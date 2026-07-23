const { kv } = require('@vercel/kv');
const { safeCompare } = require('./_safe-compare');

// ============================================================
// admin-export.js — read-only, admin-token-gated GET endpoint that walks
// every DURABLE key this app writes and returns one faithful JSON snapshot,
// suitable for a real disaster-recovery backup / manual restore. This is a
// backup tool, not a general debugging/inspection endpoint — it never
// mutates anything (no kv.set/del/sadd/srem/zadd/incr/expire calls anywhere
// in this file, only get/keys/zrange/smembers).
//
// Trigger it with, e.g.:
//   curl -s -H "x-admin-token: <ADMIN_TOKEN>" \
//     https://<your-deploy>/api/admin-export -o backup.json
//
// AUTHORIZATION — identical gate to send-push.js/delete-legacy-data.js/
// migrate-legacy-data.js: x-admin-token header, constant-time compare via
// safeCompare, 401 on missing/wrong token. Fails CLOSED if ADMIN_TOKEN isn't
// configured at all: an empty/unset env var can never be satisfied by any
// caller-supplied token (safeCompare requires equal-length buffers, and the
// `!token` check alone already rejects a caller who tries to match an empty
// secret with an empty header), but the explicit env-var check below makes
// that intent impossible to miss on a future edit to this file.
//
// ENUMERATION STRATEGY — see the accompanying research pass this endpoint
// was built from. Short version:
//   1. `account:*` is the one true superset of every real account (every
//      signup writes exactly one, nothing ever deletes it) — but the key is
//      keyed by email, so each match has to be kv.get()'d to read `.id`
//      (the real accountId used by every other key pattern) out of the
//      stored value.
//   2. `profile:*` is cross-checked against that set purely as a data-
//      integrity signal: a profile whose id never showed up in `account:*`
//      would mean a real, unexpected inconsistency under current code paths
//      (auth-signup.js always creates the account record first). Never
//      silently dropped — folded into the enumeration set and flagged in
//      `_meta.warnings` instead of causing a gap in the backup.
//   3. For each accountId in the resulting master set, pull every durable
//      per-business key: profile, the logdates index and every logentry it
//      names, the push subscription, the qrcomment index and every comment
//      it names, and every waitlog:<id>:<date> key (via a direct kv.keys()
//      scan — there is no logdates-style index for wait data anywhere in
//      this codebase, confirmed by grepping every kv.* call site).
//   4. Plus the fixed global keys: pushaccounts (real, but a push-opt-in
//      subset, never treated as an account index), and the old pre-account
//      legacy keys (businessProfile, logdates, logentry:<date>,
//      subscriptions, sub:<id>) — real historical data until someone has
//      confirmed it's fully migrated/superseded, so this backs it up too
//      rather than guessing.
//
// EXCLUDED ON PURPOSE (ephemeral, regenerable — would just bloat the file):
// authattempts:*, signupattempts:*, pushattempts:*, pushtestattempts:*,
// qrattempts:*, qrgenattempts:*, itemquestions:*, itemquestionslock:*,
// stickerscanattempts:*, waitticket:*, waitstartattempts:*,
// waitfinishattempts:*, directivecache:*, goalquestionscache:*,
// invparseattempts:*. None of these prefixes are ever touched by the
// targeted kv.keys() calls below (account:*, profile:*, waitlog:<id>:*) or
// by any of the fixed-key reads, so nothing further needs to filter them
// out — they're simply never reached.
//
// SORTED-SET VALUES — logdates:<accountId>/qrcommentindex:<accountId>/the
// legacy global logdates are all captured as plain member arrays via
// `kv.zrange(key, 0, -1)`, matching this codebase's own established
// convention (see log-summary.js/generate-directive.js/delete-legacy-data.js
// — none of them ever read scores back either). This is a faithful,
// restorable capture and not a shortcut: every score this app ever writes
// is deterministically derivable from the member itself (logdates' score is
// `Number(date.replace(/-/g,''))`; qrcommentindex's score is the same
// timestamp already embedded as the qrcomment key's own last segment), so a
// restore script can always recompute the right score from the member alone.
//
// BEST-EFFORT, NEVER ALL-OR-NOTHING — every individual kv call is wrapped so
// one bad/missing/malformed key is skipped (and noted in `_meta.errors`)
// rather than aborting the whole export.
//
// KNOWN, NOT-YET-VERIFIED LIMITATION (see CLAUDE.md / the research pass this
// was built from): whether `kv.keys()` has any result-count cap or
// pagination behavior at this project's real current key volume was never
// checked against a live KV instance (no KV_REST_API_URL/TOKEN were present
// anywhere this endpoint was built). If the real key volume ever grows large
// enough for that to matter, this is the first place to look.
// ============================================================

const LEGACY_LOGDATES_KEY = 'logdates';
const LEGACY_BUSINESS_PROFILE_KEY = 'businessProfile';
const LEGACY_SUBSCRIPTIONS_KEY = 'subscriptions';
const PUSHACCOUNTS_KEY = 'pushaccounts';

function todayUTC() {
  const dt = new Date();
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Fail closed: an unconfigured ADMIN_TOKEN must never be satisfiable by any
  // request, not even an empty one — explicit on top of safeCompare's own
  // length check so this can't regress silently on a future edit.
  const configuredToken = process.env.ADMIN_TOKEN;
  if (!configuredToken) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const token = req.headers['x-admin-token'];
  if (!token || !safeCompare(String(token), String(configuredToken))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const out = {};
  const warnings = [];
  const errors = [];

  function noteError(key, err) {
    errors.push({ key, message: (err && err.message) || String(err) });
  }

  async function safeGet(key) {
    try {
      const val = await kv.get(key);
      if (val !== null && val !== undefined) out[key] = val;
      return val;
    } catch (err) {
      noteError(key, err);
      return undefined;
    }
  }

  async function safeZrange(key) {
    try {
      const members = (await kv.zrange(key, 0, -1)) || [];
      if (members.length > 0) out[key] = members;
      return members;
    } catch (err) {
      noteError(key, err);
      return [];
    }
  }

  async function safeSmembers(key) {
    try {
      const members = (await kv.smembers(key)) || [];
      if (members.length > 0) out[key] = members;
      return members;
    } catch (err) {
      noteError(key, err);
      return [];
    }
  }

  async function safeKeys(pattern) {
    try {
      return (await kv.keys(pattern)) || [];
    } catch (err) {
      noteError(`keys(${pattern})`, err);
      return [];
    }
  }

  try {
    // ---- 1. Master accountId enumeration ----
    // account:* is the true superset (every signup writes exactly one, none
    // are ever deleted) but the id is only inside the stored value.
    const accountIdsFromAccounts = new Set();
    const accountKeys = await safeKeys('account:*');
    for (const key of accountKeys) {
      const value = await safeGet(key);
      if (value && typeof value === 'object' && typeof value.id === 'string' && value.id) {
        accountIdsFromAccounts.add(value.id);
      } else if (value !== undefined) {
        warnings.push(`account key "${key}" has no readable .id field — stored as-is, not counted toward the accountId set.`);
      }
    }

    // profile:* cross-check — the id is embedded directly in the key
    // (profile:<accountId>), no extra get needed to learn it.
    const accountIdsFromProfiles = new Set();
    const profileKeys = await safeKeys('profile:*');
    for (const key of profileKeys) {
      const id = key.slice('profile:'.length);
      if (id) accountIdsFromProfiles.add(id);
    }

    for (const id of accountIdsFromProfiles) {
      if (!accountIdsFromAccounts.has(id)) {
        warnings.push(`accountId "${id}" has a profile:${id} key but no matching account:* record — unexpected under current code paths, backed up anyway.`);
      }
    }

    const masterAccountIds = new Set([...accountIdsFromAccounts, ...accountIdsFromProfiles]);

    // ---- 2. Per-account durable data ----
    for (const accountId of masterAccountIds) {
      await safeGet(`profile:${accountId}`);

      const dates = await safeZrange(`logdates:${accountId}`);
      for (const date of dates) {
        await safeGet(`logentry:${accountId}:${date}`);
      }

      await safeGet(`pushsub:${accountId}`);

      const commentKeys = await safeZrange(`qrcommentindex:${accountId}`);
      for (const commentKey of commentKeys) {
        await safeGet(commentKey);
      }

      // No logdates-style index exists for wait data anywhere in this
      // codebase (generate-directive.js itself only ever reads a bounded
      // trailing date range) — a direct scoped kv.keys() scan is the
      // simplest genuinely-complete option, per the confirmed strategy.
      const waitlogKeys = await safeKeys(`waitlog:${accountId}:*`);
      for (const key of waitlogKeys) {
        await safeGet(key);
      }
    }

    // ---- 3. Fixed global keys ----
    // pushaccounts: real, but a push-opt-in subset only — never used as an
    // account index above, backed up here purely as its own real data.
    await safeSmembers(PUSHACCOUNTS_KEY);

    // Legacy, pre-account, pre-pivot keys — real historical data until
    // confirmed migrated/superseded (delete-legacy-data.js is the manual,
    // one-time destructive tool for these; this endpoint never calls it and
    // never deletes anything itself).
    await safeGet(LEGACY_BUSINESS_PROFILE_KEY);

    const legacyDates = await safeZrange(LEGACY_LOGDATES_KEY);
    for (const date of legacyDates) {
      await safeGet(`logentry:${date}`);
    }

    const legacySubIds = await safeSmembers(LEGACY_SUBSCRIPTIONS_KEY);
    for (const id of legacySubIds) {
      await safeGet(`sub:${id}`);
    }

    out._meta = {
      generatedAt: new Date().toISOString(),
      accountCount: masterAccountIds.size,
      keyCount: Object.keys(out).length, // counted before this _meta key is added
      warnings,
      errors,
    };
    // keyCount above is computed just before _meta is attached, so it never
    // counts itself.

    const filename = `justaddegg-backup-${todayUTC()}.json`;
    res.setHeader('Content-Type', 'application/json');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.status(200).json(out);
  } catch (err) {
    // Should be unreachable — every real kv call above is already wrapped —
    // but a hard fail-safe belongs here too rather than letting a truly
    // unexpected error leak a stack trace to the caller.
    res.status(500).json({ error: 'Something went wrong building the export.' });
  }
};
