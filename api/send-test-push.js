const webpush = require('web-push');
const { kv } = require('@vercel/kv');

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Public on purpose: it only ever pushes to the exact subscription object the
// caller already holds (their own device's real, cryptographically-bound
// subscription), never one looked up by id — so it can't be used to message
// anyone else's device. The broadcast/"a directive fired" path lives in
// send-push.js instead, and that one is admin-token gated.
//
// Even so, being fully public with no rate limit and no shape check meant any
// caller could hammer this endpoint (burning webpush/Vercel spend) or throw a
// malformed subscription at web-push and crash the handler. Fixed to match
// this codebase's own established convention (submit-review.js /
// qr-questions.js): IP-scoped rate limit via getClientIp's last-hop
// x-forwarded-for parsing + a kv.incr window counter in its own key
// namespace, plus explicit shape validation on the subscription object before
// it ever reaches web-push.

const WINDOW_SECONDS = 60 * 60; // 1 hour
const MAX_PUSHES_PER_HOUR = 20;

function getClientIp(req) {
  // Vercel's own edge network appends the real connecting client's IP as the
  // LAST entry of x-forwarded-for (any earlier entries, including the whole
  // header itself, can be set by the client and are not trustworthy). Taking
  // index [0] (the leftmost, client-suppliable segment) would let any direct
  // caller defeat the per-hour cap below by sending a different spoofed value
  // on every request — same fix as submit-review.js / qr-questions.js. Only
  // the rightmost hop is ever platform-assigned, so that's the one used.
  const xf = req.headers['x-forwarded-for'];
  if (xf) {
    const hops = String(xf).split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function registerPushAttempt(ip) {
  const key = `pushtestattempts:${ip}`;
  const n = await kv.incr(key);
  if (n === 1) await kv.expire(key, WINDOW_SECONDS);
  return n;
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function isValidSubscription(sub) {
  if (!sub || typeof sub !== 'object') return false;
  if (!isNonEmptyString(sub.endpoint)) return false;
  try {
    const u = new URL(sub.endpoint);
    if (u.protocol !== 'https:') return false;
  } catch (err) {
    return false;
  }
  if (!sub.keys || typeof sub.keys !== 'object') return false;
  if (!isNonEmptyString(sub.keys.p256dh)) return false;
  if (!isNonEmptyString(sub.keys.auth)) return false;
  return true;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const ip = getClientIp(req);
    const attemptCount = await registerPushAttempt(ip);
    if (attemptCount > MAX_PUSHES_PER_HOUR) {
      res.status(429).json({ error: 'Too many test pushes from this device — try again later.' });
      return;
    }

    const { subscription } = req.body || {};
    if (!isValidSubscription(subscription)) {
      res.status(400).json({ error: 'Missing or malformed subscription' });
      return;
    }

    const payload = JSON.stringify({
      title: 'Justaddegg',
      body: 'This is a real push, sent from a real server, to this exact device.',
      url: '/',
    });

    try {
      await webpush.sendNotification(subscription, payload);
      res.status(200).json({ ok: true });
    } catch (err) {
      // Never leak err.message to the client — same generic-error convention
      // as log-entry.js / submit-review.js / wait-start.js / wait-finish.js /
      // generate-directive.js / save-profile.js. This endpoint is public and
      // unauthenticated (see note above), so any caller could otherwise read
      // back whatever text web-push or the push service returns. The HTTP
      // status class is still meaningful to the caller (a 4xx from web-push,
      // e.g. an expired/invalid subscription, is a different situation than a
      // 5xx), so that's preserved — only the message text is genericized.
      const status = err.statusCode >= 400 && err.statusCode < 500 ? err.statusCode : 500;
      res.status(status).json({ ok: false, error: 'Could not send that push notification.' });
    }
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
