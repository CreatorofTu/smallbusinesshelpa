const { kv } = require('@vercel/kv');
const crypto = require('crypto');

// ============================================================
// wait-start.js — public, unauthenticated POST endpoint that opens one
// customer-tapped wait-time ticket, per PRODUCT-CONTEXT.md's "customer-
// tapped wait-time" future idea (now being built) and the resolved design
// locked for this build:
//
//   IDENTITY — no per-table QR code or per-table schema is needed. A
//   single shared QR code for the whole business is enough (see
//   app/qr-stickers.html's "Wait-time code" section, which encodes
//   wait.html?business=<accountId>, no item/table param). Identity lives in
//   the server-issued ticketId this endpoint mints, not in which physical
//   sticker got scanned — this correctly handles multiple simultaneous
//   tables/parties with zero new physical-sticker infrastructure.
//   CORRELATION — the client (app/wait.html) holds this ticketId in its own
//   sessionStorage between the "I just sat down" tap and the later "my
//   food just arrived" tap. No login, no device fingerprinting, no
//   "oldest open record" guessing, no claim-code the customer has to copy
//   down.
//   ABANDONMENT — an open ticket that's never closed simply expires out of
//   KV via the TTL below and is never counted in any average. No
//   abandonment-rate feature is in scope this pass.
//
// AUTHORIZATION: intentionally none — same no-login-wall-ever posture as
// submit-review.js/qr-questions.js. `business` is a routing key, validated
// the same way submit-review.js validates it (non-empty, capped, and the
// business must actually exist — 404 if not).
//
// STORAGE — waitticket:<accountId>:<ticketId>, TTL WAIT_TICKET_TTL_SECONDS
// (3 hours). api/wait-finish.js is the only reader/deleter of this key —
// see that file's own header for the close-out contract, and
// generate-directive.js's request-handler section for how the resulting
// waitlog:<accountId>:<date> aggregate feeds the directive engine.
// ============================================================

const BUSINESS_ID_MAX = 200; // matches submit-review.js/qr-questions.js's own cap
const BODY_MAX_BYTES = 8192; // same cap submit-review.js already holds itself to

const WAIT_TICKET_TTL_SECONDS = 10800; // 3 hours — an open ticket never closed just expires, never counted anywhere

// Same IP-scoped, flat per-hour cap convention as submit-review.js's
// registerSubmission() — own key namespace. Generous since this is real
// customer foot-traffic: every seated party taps this once, and a shared-
// wifi dining room shouldn't realistically hit it (same false-positive risk
// PRODUCT-CONTEXT.md already names for IP-only throttling elsewhere).
const WINDOW_SECONDS = 60 * 60; // 1 hour
const MAX_STARTS_PER_HOUR = 60;

function getClientIp(req) {
  // Same last-hop x-forwarded-for convention as submit-review.js/
  // qr-questions.js/auth-signup.js — Vercel's edge network appends the real
  // connecting client's IP as the LAST entry of x-forwarded-for; any
  // earlier entries (or the whole header) are client-suppliable and not
  // trustworthy.
  const xf = req.headers['x-forwarded-for'];
  if (xf) {
    const hops = String(xf).split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function registerStart(ip) {
  const key = `waitstartattempts:${ip}`;
  const n = await kv.incr(key);
  if (n === 1) await kv.expire(key, WINDOW_SECONDS);
  return n;
}

function cleanString(v, cap) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > cap ? s.slice(0, cap) : s;
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
    const attemptCount = await registerStart(ip);
    if (attemptCount > MAX_STARTS_PER_HOUR) {
      res.status(429).json({ error: 'Too many requests from this device — try again later.' });
      return;
    }

    const body = req.body || {};
    const accountId = cleanString(body.business, BUSINESS_ID_MAX);
    if (!accountId) {
      res.status(400).json({ error: 'Missing business' });
      return;
    }

    const profile = await kv.get(`profile:${accountId}`);
    if (!profile) {
      res.status(404).json({ error: 'Unknown business' });
      return;
    }

    const ticketId = crypto.randomUUID();
    const ticket = {
      status: 'open',
      startedAt: new Date().toISOString(), // server-assigned, never trust a client-supplied one
    };

    await kv.set(`waitticket:${accountId}:${ticketId}`, ticket, { ex: WAIT_TICKET_TTL_SECONDS });

    res.status(200).json({ ok: true, ticketId });
  } catch (err) {
    // Same deliberate stricter error-handling convention as log-entry.js /
    // submit-review.js / generate-directive.js — generic 500, no internal
    // detail leaked to the client.
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
