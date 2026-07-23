const { kv } = require('@vercel/kv');
const { getSessionFromRequest } = require('./_session');

// Account-scoped: one push subscription per account at pushsub:<accountId>
// (re-subscribing overwrites, same as before). Previously kept a single
// global `subscriptions` set of sha256(endpoint)-hashed ids shared across
// every business — that set is preserved in spirit as `pushaccounts` (now a
// set of accountIds instead of endpoint hashes) so send-push.js's existing
// broadcast-to-everyone admin path keeps working without changes to its own
// enumeration logic.
//
// AUTHORIZATION: accountId comes from the caller's signed session cookie
// (see _session.js), never from the request body — previously a client-
// supplied accountId was the only thing checked, so anyone who obtained
// another business's accountId could POST their own push subscription and
// silently hijack that business's notifications.
//
// TRUST & SAFETY: being session-authenticated doesn't mean the body is
// trustworthy — a valid, logged-in caller could still script a burst of
// POSTs (churning pushaccounts/kv writes) or send an oversized subscription
// object. Same IP-scoped rate limit + body-size cap convention as
// submit-review.js/qr-questions.js/auth-login.js (own key namespace here:
// pushattempts:<ip>), per CLAUDE.md's own rule that rate limiting in this
// app must be IP/session-based, never account-based.
const BODY_MAX_BYTES = 8192; // same cap submit-review.js holds itself to

const WINDOW_SECONDS = 60 * 60; // 1 hour
const MAX_ATTEMPTS_PER_HOUR = 20;

function getClientIp(req) {
  // Vercel's own edge network appends the real connecting client's IP as the
  // LAST entry of x-forwarded-for (any earlier entries, including the whole
  // header itself, can be client-supplied and are not trustworthy). Taking
  // index [0] would let a caller defeat the per-hour cap below by sending a
  // different spoofed value on every request — same fix already applied in
  // submit-review.js/qr-questions.js/auth-login.js, propagated here too.
  const xf = req.headers['x-forwarded-for'];
  if (xf) {
    const hops = String(xf).split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function registerAttempt(ip) {
  const key = `pushattempts:${ip}`;
  const n = await kv.incr(key);
  if (n === 1) await kv.expire(key, WINDOW_SECONDS);
  return n;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

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
  const attemptCount = await registerAttempt(ip);
  if (attemptCount > MAX_ATTEMPTS_PER_HOUR) {
    res.status(429).json({ error: 'Too many attempts — try again later.' });
    return;
  }

  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }
  const accountId = session.accountId;

  const { subscription } = req.body || {};

  if (!subscription || !subscription.endpoint || !subscription.keys) {
    res.status(400).json({ error: 'Invalid subscription payload' });
    return;
  }

  await kv.set(`pushsub:${accountId}`, subscription);
  await kv.sadd('pushaccounts', accountId);

  res.status(201).json({ ok: true });
};
