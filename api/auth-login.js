const { kv } = require('@vercel/kv');
const bcrypt = require('bcryptjs');
const { setSessionCookie } = require('./_session');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// IP-scoped brute-force throttle — this app has no real user identity to key
// a per-account limit off of before login succeeds, so this follows the same
// IP/session-scoped convention already established elsewhere in this app
// (never account-based). Only failed attempts count against the limit —
// a correct login never adds to it.
const WINDOW_SECONDS = 15 * 60; // 15 minutes
const MAX_ATTEMPTS = 8;

// A syntactically valid, fixed bcrypt hash (cost 11, the same cost this file
// hashes real passwords at) that no real account will ever match. Used only
// to burn the same amount of CPU time bcrypt.compare() would spend on a real
// account — see the timing note below. Not a secret; it doesn't need to be,
// since nothing is ever hashed to produce it and nothing real is compared
// against it for equality purposes.
const DUMMY_HASH = '$2a$11$N9qo8uLOickgx2ZMRZoMyeIjZAgcfl7p92ldGxad68LJZdL17lhWy';

function getClientIp(req) {
  // Vercel's own edge network appends the real connecting client's IP as the
  // LAST entry of x-forwarded-for (any earlier entries, including the whole
  // header itself, can be client-supplied and are not trustworthy). Taking
  // index [0] let a caller defeat the per-hour attempt cap below by sending
  // a different spoofed value on every request — same bug already found and
  // fixed once in submit-review.js/qr-questions.js, propagated here too.
  const xf = req.headers['x-forwarded-for'];
  if (xf) {
    const hops = String(xf).split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

// Atomic, increment-first throttle — closes a check-then-act race where
// concurrent requests could all read the same stale attempt count before any
// of them incremented it, letting a burst of parallel requests sail past the
// MAX_ATTEMPTS gate (the previous version only actually throttled serialized,
// one-after-another attempts). kv.incr is atomic per the underlying store, so
// every concurrent caller gets its own distinct, correctly-ordered count.
//
// Because a correct login should NOT count against the limit long-term, a
// successful login calls releaseAttempt() afterward to undo its own
// increment — this preserves the original intent ("only failed attempts
// count") without reopening the race (the increment still happens up front,
// atomically, before any gate is checked).
async function registerAttempt(ip) {
  const key = `authattempts:${ip}`;
  const n = await kv.incr(key);
  if (n === 1) await kv.expire(key, WINDOW_SECONDS);
  return n;
}

async function releaseAttempt(ip) {
  const key = `authattempts:${ip}`;
  const n = await kv.decr(key);
  if (n <= 0) await kv.del(key);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const ip = getClientIp(req);
    const attemptCount = await registerAttempt(ip);
    if (attemptCount > MAX_ATTEMPTS) {
      res.status(429).json({ error: 'Too many attempts — try again in a few minutes.' });
      return;
    }

    const { email, password } = req.body || {};

    // Same generic failure for a malformed request as for a real wrong
    // credential below — never confirm/deny which part was wrong.
    const GENERIC_ERROR = 'Email or password is incorrect';

    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim()) || typeof password !== 'string' || !password) {
      res.status(401).json({ error: GENERIC_ERROR });
      return;
    }

    const emailKey = email.trim().toLowerCase();
    const account = await kv.get(`account:${emailKey}`);

    if (!account || !account.passwordHash) {
      // Constant-time mitigation: run the same bcrypt.compare cost here that
      // the "account exists, password is wrong" branch below pays, so
      // response latency doesn't reveal whether the email is registered
      // (the JSON payload never did, but timing did — bcrypt.compare is
      // deliberately slow, and only the wrong-password branch used to pay
      // that cost).
      await bcrypt.compare(password, DUMMY_HASH);
      res.status(401).json({ error: GENERIC_ERROR });
      return;
    }

    const matches = await bcrypt.compare(password, account.passwordHash);
    if (!matches) {
      res.status(401).json({ error: GENERIC_ERROR });
      return;
    }

    // Success — this attempt shouldn't count against the IP's throttle window.
    await releaseAttempt(ip);

    // Issue a real, signed, HttpOnly session cookie. This — not the
    // accountId in the JSON body — is what every account-scoped endpoint now
    // authenticates against. The body still carries accountId/email for the
    // client's own local-storage bookkeeping (deciding which screen to show),
    // but it is no longer trusted as a credential by the server.
    setSessionCookie(res, account.id, account.email);

    // Best-effort: let a returning owner skip straight back into the app
    // instead of re-running the whole setup wizard if the server already has
    // a completed profile for this account (onboarding.html uses this to
    // decide whether to redirect to /index.html or to Step 1). Also send back
    // coreProduct so a login on a fresh device (cleared localStorage) can
    // restore the personalized log-note placeholder in index.html, which
    // otherwise silently falls back to generic copy — that placeholder is
    // read from jaeFirstProduct/jaeBusinessType, which previously were only
    // ever set at the end of a fresh onboarding run and never rehydrated here.
    let completed = false;
    let coreProduct = '';
    try {
      const profile = await kv.get(`profile:${account.id}`);
      completed = !!(profile && profile.completed);
      coreProduct = (profile && profile.setup && profile.setup.coreProduct) || '';
    } catch (err) {
      // Non-fatal — worst case the user re-lands on Step 1, or keeps the
      // generic placeholder instead of the personalized one.
    }

    res.status(200).json({ ok: true, accountId: account.id, email: account.email, completed: completed, coreProduct: coreProduct });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
