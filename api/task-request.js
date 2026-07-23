const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const { getSessionFromRequest } = require('./_session');

// ============================================================
// task-request.js — the confirm-then-delay consent mechanic, made real.
//
// This is the trust flow PRODUCT-CONTEXT.md's "Trust, consent, and the
// baseline mechanic" section already designed: the owner says "I'm getting
// it" once, a live countdown runs client-side (index.html's "Ask your AI
// manager" section), and two equal-weight escape hatches — Stop and
// Redirect — can end it at any moment. Only if the countdown reaches zero
// untouched does the client call `confirm` here.
//
// TEST MODE, HONESTLY LABELED: the reframed execution mechanism (2026-07-23,
// see PRODUCT-CONTEXT.md) is dispatching a real human tasker through an
// existing on-demand platform (DoorDash Drive / Uber Direct / Instacart
// Business) — which needs a real account + API key from one of those
// platforms, the founder's own action, and none exists yet. So `confirm`
// executes NOTHING real: it marks the record 'executed-test-mode' (the
// status string itself says no real action happened) and returns a plain
// message saying so — the exact posture onboarding.html's
// startTierPayment() already uses ("Payment link not connected yet (test
// mode)") when no real payment link is configured: nothing is silently
// faked, the seam is visible and honest.
//
// COUNTDOWN LIVES IN THE BROWSER, NOT HERE: this app has no background job
// runner, so there is no server timer — a pending record can never
// self-execute. Execution only ever happens when a live browser's countdown
// reaches zero and posts `confirm`. That's also why `confirm` re-checks
// status: a stale tab double-firing must never double-execute.
//
// AUTHORIZATION: same convention as every other account-scoped endpoint —
// accountId comes from the caller's signed session cookie (_session.js),
// never from the request body. Records are keyed
// taskrequest:<accountId>:<id>, so the account scoping is structural: an id
// guessed (or leaked) from account A resolves against account B's keyspace
// and simply isn't found — account B can never touch account A's request.
//
// STORAGE: taskrequestindex:<accountId> zset (score = createdAt ms) plus
// individual taskrequest:<accountId>:<id> records — same index+record
// pattern as save-profile.js's changelogindex/changelog keys, same
// best-effort oldest-first cap so this can never grow unbounded.
// ============================================================

// "What do you need?" is a short, concrete ask ("more brown sugar"), not an
// essay — name-sized cap, same order as save-profile.js's STRING_CAP.
const TASK_DESCRIPTION_CAP = 200;

// LOW ON PURPOSE. This mechanic is explicitly scoped to SMALL, reversible
// actions ("pick this thing up for me for $5") — the whole trust design
// rests on each individual action being cheap enough that a wrong one is an
// apology and a credit, not a real loss. A high ceiling here would quietly
// turn "small reversible task" into "autonomous spend," which is a
// different product with a different consent bar. $50 comfortably covers a
// supply run; anything bigger should be a conversation, not a countdown.
const TASK_COST_CAP_MAX_DOLLARS = 50;

// Sane ceiling on stored requests per account, oldest trimmed first — same
// reasoning as save-profile.js's CHANGELOG_MAX: at small-business scale a
// handful of asks a week, 100 records is a long history, not a tight limit.
const TASKREQUEST_MAX = 100;

// ids are crypto.randomUUID() output, but validate the client-echoed id
// anyway before it's embedded in a KV key — same charset-restriction
// instinct as save-profile.js's ID_RE: a ':' or other delimiter must never
// land inside a key segment.
const TASK_ID_RE = /^[A-Za-z0-9-]{1,64}$/;

const RESOLVED_STATUSES = ['stopped', 'redirected', 'executed-test-mode'];

// The honest test-mode line `confirm` returns — see the file header. The
// status string 'executed-test-mode' (never plain 'executed') exists so the
// stored record itself can never be misread as a real order having
// happened.
const TEST_MODE_MESSAGE =
  'No real tasker platform is connected yet — nothing was actually ordered or charged. ' +
  'This is a demonstration of the confirm-then-delay flow only.';

function recordKey(accountId, id) {
  return `taskrequest:${accountId}:${id}`;
}

function indexKey(accountId) {
  return `taskrequestindex:${accountId}`;
}

// Best-effort trim, oldest first — mirrors save-profile.js's capChangelog:
// deletes the dropped records themselves (not just index entries) so
// nothing orphaned is left in KV, and is never allowed to fail the request
// it's called from.
async function capTaskRequests(accountId) {
  const idxKey = indexKey(accountId);
  const count = await kv.zcard(idxKey);
  if (!count || count <= TASKREQUEST_MAX) return;
  const excess = count - TASKREQUEST_MAX;
  const oldest = await kv.zrange(idxKey, 0, excess - 1);
  if (Array.isArray(oldest) && oldest.length > 0) {
    await Promise.all(oldest.map(function (k) { return kv.del(k); }));
  }
  await kv.zremrangebyrank(idxKey, 0, excess - 1);
}

// The public subset of a record — same fields for GET and for the create
// path's stored shape. accountId never appears in any response (it's
// already implicit in whose session asked).
function publicRecord(record) {
  return {
    id: record.id,
    description: record.description,
    costCapDollars: record.costCapDollars,
    status: record.status,
    createdAt: record.createdAt,
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      res.status(401).json({ error: 'Not logged in' });
      return;
    }
    const accountId = session.accountId;

    // ---- GET: the account's most recent request only (or null) ----
    // index.html calls this once on load purely to resume an in-flight
    // countdown after a reload — deliberately NOT a history/list view, so
    // only the newest record is ever returned.
    if (req.method === 'GET') {
      const newest = await kv.zrange(indexKey(accountId), -1, -1);
      const newestKey = Array.isArray(newest) && newest.length > 0 ? newest[0] : null;
      const record = newestKey ? await kv.get(newestKey) : null;
      res.status(200).json({ request: record ? publicRecord(record) : null });
      return;
    }

    const body = req.body || {};
    const action = body.action;

    // ---- POST { action: 'create', description, costCapDollars } ----
    if (action === 'create') {
      const description =
        typeof body.description === 'string' ? body.description.trim().slice(0, TASK_DESCRIPTION_CAP) : '';
      if (!description) {
        res.status(400).json({ error: 'Say what you need first.' });
        return;
      }
      const costCapDollars = Number(body.costCapDollars);
      if (!Number.isFinite(costCapDollars) || costCapDollars <= 0 || costCapDollars > TASK_COST_CAP_MAX_DOLLARS) {
        res.status(400).json({ error: 'Cost cap must be between $0 and $' + TASK_COST_CAP_MAX_DOLLARS + '.' });
        return;
      }

      const id = crypto.randomUUID();
      const createdMs = Date.now(); // server-assigned, never client-supplied
      const record = {
        id: id,
        description: description,
        // Round to cents — this number is shown back to the owner as a
        // dollar amount, and a float like 5.000000001 shouldn't survive
        // into storage.
        costCapDollars: Math.round(costCapDollars * 100) / 100,
        status: 'pending',
        createdAt: new Date(createdMs).toISOString(),
      };

      await kv.set(recordKey(accountId, id), record);
      await kv.zadd(indexKey(accountId), { score: createdMs, member: recordKey(accountId, id) });
      await capTaskRequests(accountId).catch(function () {});

      res.status(200).json({ id: id });
      return;
    }

    // ---- POST { action: 'stop' | 'redirect' | 'confirm', id } ----
    if (action === 'stop' || action === 'redirect' || action === 'confirm') {
      const id = typeof body.id === 'string' && TASK_ID_RE.test(body.id) ? body.id : '';
      if (!id) {
        res.status(400).json({ error: 'Missing request id.' });
        return;
      }
      // Structural ownership check: the key is built from THIS session's
      // accountId, so an id belonging to another account looks up a key in
      // this account's own keyspace and comes back empty — there is no path
      // by which a guessed id reaches another account's record.
      const key = recordKey(accountId, id);
      const record = await kv.get(key);
      if (!record || typeof record !== 'object') {
        res.status(404).json({ error: 'No such request.' });
        return;
      }

      // Idempotence: resolving an already-resolved request is a harmless
      // no-op reporting the real current state, never an error — a
      // double-click on Stop, or a stale tab's confirm firing after a Stop
      // already landed, must never throw and must NEVER double-execute.
      if (RESOLVED_STATUSES.indexOf(record.status) !== -1) {
        res.status(200).json({
          ok: true,
          status: record.status,
          message: record.status === 'executed-test-mode' ? TEST_MODE_MESSAGE : 'Already resolved — nothing happened.',
        });
        return;
      }

      if (action === 'stop' || action === 'redirect') {
        record.status = action === 'stop' ? 'stopped' : 'redirected';
        record.resolvedAt = new Date().toISOString();
        await kv.set(key, record);
        res.status(200).json({ ok: true, status: record.status });
        return;
      }

      // action === 'confirm' — the countdown reached zero with neither
      // escape hatch pressed. THIS IS THE TEST-MODE SEAM (see file header):
      // when a real tasker-platform account exists, the real dispatch call
      // goes right here, before the status write. Today there is none, so
      // nothing real happens and the status string says exactly that.
      record.status = 'executed-test-mode';
      record.resolvedAt = new Date().toISOString();
      record.message = TEST_MODE_MESSAGE;
      await kv.set(key, record);
      res.status(200).json({ ok: true, status: record.status, message: TEST_MODE_MESSAGE });
      return;
    }

    res.status(400).json({ error: 'Unknown action.' });
  } catch (err) {
    // Same deliberate error-handling convention as log-history.js /
    // save-profile.js — generic 500, no internal detail leaked.
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
