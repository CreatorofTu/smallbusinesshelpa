const { kv } = require('@vercel/kv');

// ============================================================
// submit-review.js — public, unauthenticated POST endpoint that stores one
// customer's QR-scan comment, per PRODUCT-CONTEXT.md's "QR-code
// environment-review system" (and its own "Trust & safety" subsection).
// The write counterpart to qr-questions.js — see that file's header for the
// route shape and generation model this pairs with.
//
// AUTHORIZATION: intentionally none — same no-login-wall-ever posture as
// qr-questions.js. `business`/`item` here ARE the real per-business/per-item
// scoping this data needs (PRODUCT-CONTEXT.md's own technical-shape section
// flags this app's existing endpoints as "flat global keys with no business
// ID anywhere... this feature is inherently multi-business by design" — this
// is the first endpoint in this app that actually is business-scoped in its
// storage key, on purpose). Because there is no real customer account/
// identity anywhere in this product (by design), object-level authorization
// here means IP-rate-limiting the write path and capping/validating
// everything in the body — not an ownership check, since there is no owner
// identity to check against on this side.
//
// STORAGE — mirrors log-entry.js's logdates:<accountId> zset-of-dates
// pattern, adapted to a running zset of individual comment keys per
// account (not per-date, since many comments can land on the same day):
//   qrcomment:<accountId>:<itemKey>:<timestamp>   one record per submission
//     (itemKey is the real inventory item id, or the literal string
//     "_general" for the door/general code — never null/empty in the key
//     itself, so key-parsing never has to special-case a missing segment)
//   qrcommentindex:<accountId>                    zset, score = timestamp
//     (ms), member = the full qrcomment:* key above. generate-directive.js
//     reads this index to reconstruct environmentItems/coreProductQrSignal
//     (see that file's loadQrSignalsFromComments()).
//
// TRUST & SAFETY, per PRODUCT-CONTEXT.md's own bar for this feature: IP-
// scoped rate limiting (no account exists to key a per-user limit off of),
// capped body/text size, server-assigned timestamp (never trust a client-
// supplied one), escaped-on-the-way-out is generate-directive.js's job (it
// fences this data before any prompt ever sees it — this endpoint's own job
// is just to store it safely, not to render or reason over it). No
// autonomous action is ever taken off this data — it only ever becomes an
// input to the directive engine's own gated reasoning.
// ============================================================

const BUSINESS_ID_MAX = 200;
const ITEM_ID_MAX = 100;
const ANSWER_KEY_MAX = 60;
const ANSWER_VALUE_MAX = 500;
const MAX_ANSWER_KEYS = 6;
const GOT_ON_MAX = 500;
const BODY_MAX_BYTES = 8192; // same cap /feedback (tiny-server.js, sibling JustAddEgg project) already holds itself to

// IP-scoped, flat per-hour cap — no release-on-success (unlike auth-login.js's
// registerAttempt/releaseAttempt), because there is no success/failure
// distinction here: every valid, well-formed submission counts against the
// same limit, per the task's own explicit scoping ("this one doesn't need a
// 'release on success' since there's no failure/success distinction, just a
// flat per-IP-per-hour cap"). The exact cap is a judgment call, not specified
// anywhere: chosen generous enough that a real busy dining room on shared
// wifi (PRODUCT-CONTEXT.md's own named false-positive risk for IP-only
// throttling) shouldn't realistically hit it, while still bounding a single
// bad actor's burst. A per-code-instance cap alongside this one was flagged
// in PRODUCT-CONTEXT.md as "worth considering" but never decided — not
// built here, left as a named future refinement.
const WINDOW_SECONDS = 60 * 60; // 1 hour
const MAX_SUBMISSIONS_PER_HOUR = 30;

function getClientIp(req) {
  // Vercel's own edge network appends the real connecting client's IP as the
  // LAST entry of x-forwarded-for (any earlier entries, including the whole
  // header itself, can be set by the client and are not trustworthy). Taking
  // index [0] (the leftmost, client-suppliable segment) let any direct caller
  // defeat registerSubmission()'s per-hour cap below by sending a different
  // spoofed value on every request — see the reviewer finding this fixes.
  // Only the rightmost hop is ever platform-assigned, so that's the one used.
  const xf = req.headers['x-forwarded-for'];
  if (xf) {
    const hops = String(xf).split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function registerSubmission(ip) {
  const key = `qrattempts:${ip}`;
  const n = await kv.incr(key);
  if (n === 1) await kv.expire(key, WINDOW_SECONDS);
  return n;
}

function cleanString(v, cap) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > cap ? s.slice(0, cap) : s;
}

function sanitizeAnswers(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  const out = {};
  const keys = Object.keys(raw).slice(0, MAX_ANSWER_KEYS);
  keys.forEach((k) => {
    const cleanKey = cleanString(k, ANSWER_KEY_MAX);
    if (!cleanKey) return;
    const val = raw[k];
    if (typeof val === 'string') {
      const s = val.trim();
      if (s) out[cleanKey] = s.length > ANSWER_VALUE_MAX ? s.slice(0, ANSWER_VALUE_MAX) : s;
    } else if (typeof val === 'boolean') {
      out[cleanKey] = val ? 'yes' : 'no';
    }
  });
  return out;
}

// ---- server-side question-set lookup — see the reviewer finding this
// fixes: the client used to echo back the `questions` array it rendered,
// and this endpoint trusted it verbatim (only type/length-checked) before
// persisting it into qrcomment:* records that generate-directive.js later
// embeds, unfenced, straight into its own reasoning prompt. Since there is
// no login wall, any direct caller could POST a crafted `questions` array
// and inject arbitrary text into the exact prompt that produces the
// owner-facing verdict. Fix: never trust the client's copy at all — look
// the real question set up server-side, the same way qr-questions.js itself
// would have served it. Mirrors that file's cache key/shape (duplicated
// rather than imported — this codebase has no shared prompt module, per
// CLAUDE.md's own noted lesson). ----
function itemQuestionsCacheKey(accountId, itemId) {
  return `itemquestions:${accountId}:${itemId}`;
}

// Same fixed generic door/general-code question prompts as qr-questions.js's
// own GENERAL_QUESTIONS constant.
const GENERAL_QUESTION_PROMPTS = [
  'How was your visit today?',
  'Anything you want to tell the owner? (optional)',
];

// Same vague-label fallback as qr-questions.js's fallbackItemQuestions().
function fallbackItemQuestionPrompts(itemLabel) {
  const label = itemLabel || 'this';
  return [`How's the ${label}?`];
}

async function resolveQuestionsServerSide(accountId, itemId, itemLabel) {
  if (!itemId) return GENERAL_QUESTION_PROMPTS.slice();
  const cached = await kv.get(itemQuestionsCacheKey(accountId, itemId)).catch(() => null);
  if (cached && Array.isArray(cached.questions) && cached.questions.length > 0) {
    return cached.questions.slice(0, 3).map((q) => cleanString(q, 200));
  }
  // Cache miss (e.g. this scan's generation hadn't landed/cached yet) — same
  // honest vague-label fallback qr-questions.js itself would have served.
  return fallbackItemQuestionPrompts(itemLabel);
}

const SAME_AS_LAST_TIME_OPTIONS = ['yes', 'no', 'unsure'];

// The "did you have it" answer is the one required field in this block —
// per PRODUCT-CONTEXT.md, a "no" is itself meaningful and must never be
// silently discarded, but SOME answer is required for the block to mean
// anything at all. Everything else in the block (price paid, what they got,
// same-as-last-time) is genuinely optional, matching the item-specific
// questions and the general code's own free text.
function sanitizeCoreProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const had = raw.had === true ? true : raw.had === false ? false : null;
  if (had === null) return null;

  let pricePaid = null;
  if (had === true) {
    const n = Number(raw.pricePaid);
    if (Number.isFinite(n) && n >= 0 && n < 100000) pricePaid = n;
  }

  const gotOn = cleanString(raw.gotOn, GOT_ON_MAX) || null;
  const sameAsLastTime = SAME_AS_LAST_TIME_OPTIONS.indexOf(raw.sameAsLastTime) !== -1 ? raw.sameAsLastTime : null;

  return { had, pricePaid, gotOn, sameAsLastTime };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    let bodyLen = 0;
    try {
      bodyLen = JSON.stringify(req.body || {}).length;
    } catch (err) {
      res.status(400).json({ error: 'Malformed request body' });
      return;
    }
    if (bodyLen > BODY_MAX_BYTES) {
      res.status(413).json({ error: 'Request body too large' });
      return;
    }

    const ip = getClientIp(req);
    const attemptCount = await registerSubmission(ip);
    if (attemptCount > MAX_SUBMISSIONS_PER_HOUR) {
      res.status(429).json({ error: 'Too many submissions from this device — try again later.' });
      return;
    }

    const body = req.body || {};
    const accountId = cleanString(body.business, BUSINESS_ID_MAX);
    const itemId = cleanString(body.item, ITEM_ID_MAX) || null;

    if (!accountId) {
      res.status(400).json({ error: 'Missing business' });
      return;
    }

    const profile = await kv.get(`profile:${accountId}`);
    if (!profile) {
      res.status(404).json({ error: 'Unknown business' });
      return;
    }

    let itemLabel = null;
    if (itemId) {
      const inventory = Array.isArray(profile.inventory) ? profile.inventory : [];
      const item = inventory.find((row) => row && row.id === itemId);
      if (!item) {
        res.status(404).json({ error: 'Unknown item for this business' });
        return;
      }
      itemLabel = item.name || null;
    }

    const answers = sanitizeAnswers(body.answers);
    const coreProduct = sanitizeCoreProduct(body.coreProduct);

    // Reject a genuinely empty submission (neither block has anything real
    // in it) — mirrors /feedback's own rule in the sibling JustAddEgg
    // project ("now only rejects a submission with neither a valid rating
    // nor real text"), adapted to this endpoint's two blocks instead of one
    // rating+text pair.
    if (Object.keys(answers).length === 0 && !coreProduct) {
      res.status(400).json({ error: 'Nothing to submit' });
      return;
    }

    // Never the client-echoed body.questions — looked up server-side instead,
    // see resolveQuestionsServerSide()'s own header comment above.
    const questions = await resolveQuestionsServerSide(accountId, itemId, itemLabel);

    const itemKey = itemId || '_general';
    const timestamp = Date.now(); // server-assigned, never trust a client-supplied one
    const submittedAt = new Date(timestamp).toISOString();

    const record = {
      business: accountId,
      item: itemId,
      itemLabel,
      tier: itemId ? 'item' : 'general',
      questions,
      answers,
      coreProduct,
      submittedAt,
    };

    const commentKey = `qrcomment:${accountId}:${itemKey}:${timestamp}`;
    const indexKey = `qrcommentindex:${accountId}`;

    const pipeline = kv.multi();
    pipeline.set(commentKey, record);
    pipeline.zadd(indexKey, { score: timestamp, member: commentKey });
    await pipeline.exec();

    res.status(200).json({ ok: true });
  } catch (err) {
    // Same deliberate stricter error-handling convention as log-entry.js /
    // save-profile.js / generate-directive.js — generic 500, no internal
    // detail leaked to the client.
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
