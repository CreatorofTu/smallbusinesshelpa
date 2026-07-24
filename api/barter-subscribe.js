const crypto = require('crypto');
const { kv } = require('@vercel/kv');

// ============================================================
// barter-subscribe.js — public, no-login opt-in for the "Barter" reward-claim
// prototype (PRODUCT-CONTEXT.md's distribution-partnership section). Unlike
// api/subscribe.js (which attaches a push subscription to a logged-in
// business account), this one has no account at all — the whole point of
// Barter is reaching random nearby people who will never create a Herald
// account, just opt into "want a shot at free stuff sometimes?" alerts.
//
// Anonymous subscriber id (crypto.randomUUID(), server-assigned) rather than
// anything tied to identity — this app never asks a Barter subscriber for a
// name, email, or phone. Same body-size cap + IP-scoped rate limit
// convention as api/subscribe.js (per CLAUDE.md: rate limiting here must be
// IP/session-based, never account-based, since there is no account).
// ============================================================

const BODY_MAX_BYTES = 8192;
const WINDOW_SECONDS = 60 * 60;
const MAX_ATTEMPTS_PER_HOUR = 20;

function getClientIp(req) {
  // Same last-hop x-forwarded-for fix as every other IP-throttled endpoint —
  // index [0] is client-spoofable, the LAST hop is the one Vercel's edge
  // actually appends.
  const xf = req.headers['x-forwarded-for'];
  if (xf) {
    const hops = String(xf).split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function registerAttempt(ip) {
  const key = `barterattempts:${ip}`;
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

  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    res.status(400).json({ error: 'Invalid subscription payload' });
    return;
  }

  const id = crypto.randomUUID();
  await kv.set(`bartersub:${id}`, subscription);
  await kv.sadd('barteraccounts', id);

  res.status(201).json({ ok: true });
};
