const { kv } = require('@vercel/kv');

// ============================================================
// wait-finish.js — public, unauthenticated POST endpoint that closes one
// customer-tapped wait-time ticket (opened by api/wait-start.js) and folds
// its elapsed time into that day's waitlog:<accountId>:<date> aggregate.
// See wait-start.js's own header for the full identity/correlation/
// abandonment design this pairs with.
//
// AUTHORIZATION: intentionally none — same posture as wait-start.js/
// submit-review.js/qr-questions.js. The ticketId itself (an unguessable
// crypto.randomUUID() minted by wait-start.js) is the only thing standing
// in for identity here — there is no customer account to check ownership
// against, and there doesn't need to be: a ticket can only ever be closed
// once (see the delete-before-use ordering below) and only ever expresses
// one visit's own elapsed time.
//
// "TODAY" FOR waitlog:<accountId>:<date>: computed SERVER-SIDE from
// Date.now(), never from a client-supplied date. This deliberately does NOT
// mirror log-entry.js's own date handling verbatim — that endpoint accepts
// an explicit `date` in the body because it's an authenticated OWNER
// logging their own local calendar day from their own device. This is an
// anonymous, unauthenticated customer tap with no session and no reason to
// trust a client clock at all, so "today" is derived the same UTC-anchored
// way log-summary.js/generate-directive.js already format calendar dates
// (formatDateUTC), just sourced from the server's own real clock instead of
// a caller-supplied anchor.
//
// STORAGE — waitlog:<accountId>:<YYYY-MM-DD> = { totalMinutes, count },
// read-modify-write (kv.get then kv.set) — fine at this business's real
// scale (a handful of ticket closes per day), no need for a fancier atomic
// structure. generate-directive.js reads this same key shape to build its
// parallel waitByDate map — see that file's request-handler section.
// ============================================================

const BUSINESS_ID_MAX = 200; // matches submit-review.js/qr-questions.js's own cap
const TICKET_ID_MAX = 100; // crypto.randomUUID() is always 36 chars — generous cap against a malicious client sending something huge
const BODY_MAX_BYTES = 8192; // same cap submit-review.js already holds itself to

// Sane elapsed-time bounds — guards against clock skew or any other
// nonsensical value rather than trusting Date.parse()/Date.now() blindly.
const MIN_ELAPSED_MINUTES = 0;
const MAX_ELAPSED_MINUTES = 180;

// Same IP-scoped, flat per-hour cap convention as wait-start.js/
// submit-review.js — own key namespace.
const WINDOW_SECONDS = 60 * 60; // 1 hour
const MAX_FINISHES_PER_HOUR = 60;

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) {
    const hops = String(xf).split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function registerFinish(ip) {
  const key = `waitfinishattempts:${ip}`;
  const n = await kv.incr(key);
  if (n === 1) await kv.expire(key, WINDOW_SECONDS);
  return n;
}

function cleanString(v, cap) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > cap ? s.slice(0, cap) : s;
}

// Same UTC-anchored calendar-date formatting as log-summary.js/
// generate-directive.js's own formatDateUTC — duplicated rather than
// imported (this codebase has no shared date-helper module, and neither
// sibling file exports it), but sourced from the server's real clock here
// rather than a caller-supplied anchor, since this endpoint has no
// authenticated caller-local "today" to anchor against.
function todayUTC() {
  const dt = new Date();
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
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
    const attemptCount = await registerFinish(ip);
    if (attemptCount > MAX_FINISHES_PER_HOUR) {
      res.status(429).json({ error: 'Too many requests from this device — try again later.' });
      return;
    }

    const body = req.body || {};
    const accountId = cleanString(body.business, BUSINESS_ID_MAX);
    const ticketId = cleanString(body.ticketId, TICKET_ID_MAX);

    if (!accountId) {
      res.status(400).json({ error: 'Missing business' });
      return;
    }
    if (!ticketId) {
      res.status(400).json({ error: 'Missing ticketId' });
      return;
    }

    const profile = await kv.get(`profile:${accountId}`);
    if (!profile) {
      res.status(404).json({ error: 'Unknown business' });
      return;
    }

    const ticketKey = `waitticket:${accountId}:${ticketId}`;
    const ticket = await kv.get(ticketKey);
    if (!ticket || typeof ticket.startedAt !== 'string') {
      res.status(404).json({ error: "This wait session has expired." });
      return;
    }

    // Delete before doing anything else — per the resolved design, this
    // means the ticket can never be double-closed (a retry or a duplicate
    // tap after this point always 404s as "expired" instead of
    // double-counting one visit's wait time into the day's aggregate).
    await kv.del(ticketKey);

    const startedMs = Date.parse(ticket.startedAt);
    const elapsedMinutes = (Date.now() - startedMs) / 60000;

    if (!Number.isFinite(elapsedMinutes) || elapsedMinutes < MIN_ELAPSED_MINUTES || elapsedMinutes > MAX_ELAPSED_MINUTES) {
      // Ticket existed and was well-formed, but the elapsed time itself is
      // nonsensical (clock skew, or some other edge case) — close the visit
      // out for the customer without ever writing a bogus number into the
      // day's real aggregate.
      res.status(200).json({ ok: true });
      return;
    }

    const dateKey = todayUTC();
    const logKey = `waitlog:${accountId}:${dateKey}`;
    const existing = await kv.get(logKey);
    const current = (existing && typeof existing === 'object')
      ? existing
      : { totalMinutes: 0, count: 0 };

    const updated = {
      totalMinutes: (Number(current.totalMinutes) || 0) + elapsedMinutes,
      count: (Number(current.count) || 0) + 1,
    };

    await kv.set(logKey, updated);

    res.status(200).json({ ok: true });
  } catch (err) {
    // Same deliberate stricter error-handling convention as log-entry.js /
    // submit-review.js / generate-directive.js — generic 500, no internal
    // detail leaked to the client.
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
