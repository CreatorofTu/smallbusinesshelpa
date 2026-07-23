const { kv } = require('@vercel/kv');
const { getSessionFromRequest } = require('./_session');

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX_LENGTH = 280;
// Sane per-day ceilings for a single small restaurant/cafe location — not a
// real-world record, just a backstop so a bad/malicious client value can't
// corrupt generate-directive.js's mean/stdev baseline math. `sales` is in
// whole dollars (see the "Sales today ($)" input in app/index.html, step
// 0.01), not cents.
const MAX_CUSTOMERS_PER_DAY = 100000;
const MAX_SALES_PER_DAY = 1000000;

// Account-scoped: every business gets its own logentry:<accountId>:<date>
// keys and its own logdates:<accountId> sorted set — previously a single
// global logentry:<date>/logdates pair shared (and silently collided) across
// every business. The caller (the owner's own device) always sends its own
// local calendar date explicitly. We never derive "today" from the server
// clock here: this function runs in UTC and would file evening entries under
// the wrong day.
//
// AUTHORIZATION: accountId is derived from the caller's signed session
// cookie (see _session.js), never from the request body. A client-supplied
// accountId in the body is no longer accepted for this purpose — previously
// it was the only thing checked, so anyone who ever obtained another
// business's accountId could write to that business's log forever.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
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

    const { date, customers, sales, note } = req.body || {};

    if (!date || typeof date !== 'string' || !DATE_RE.test(date)) {
      res.status(400).json({ error: 'Missing or malformed date' });
      return;
    }

    if (!Number.isFinite(customers) || customers < 0) {
      res.status(400).json({ error: 'customers must be a finite number >= 0' });
      return;
    }
    if (customers > MAX_CUSTOMERS_PER_DAY) {
      res.status(400).json({ error: `customers must be <= ${MAX_CUSTOMERS_PER_DAY}` });
      return;
    }

    if (!Number.isFinite(sales) || sales < 0) {
      res.status(400).json({ error: 'sales must be a finite number >= 0' });
      return;
    }
    if (sales > MAX_SALES_PER_DAY) {
      res.status(400).json({ error: `sales must be <= ${MAX_SALES_PER_DAY}` });
      return;
    }

    let cleanNote = typeof note === 'string' ? note.trim() : '';
    if (cleanNote.length > NOTE_MAX_LENGTH) {
      cleanNote = cleanNote.slice(0, NOTE_MAX_LENGTH);
    }

    const entry = {
      date,
      customers,
      sales,
      note: cleanNote || null,
      // Actual write timestamp (not the caller-supplied business `date`) —
      // safe to source from the server clock here since it's audit metadata,
      // not used for calendar-day bucketing.
      loggedAt: new Date().toISOString(),
    };

    // Upsert: writing the same date again corrects it in place rather than
    // duplicating it, and re-adding to the sorted set with the same member
    // just updates its score.
    //
    // Sent as a single multi/pipeline so both writes go out together rather
    // than as two independent round trips; if log-summary.js ever encounters
    // a zset member with no matching entry (or vice versa) it already
    // tolerates that by filtering with `if (entries[i])`.
    const pipeline = kv.multi();
    pipeline.set(`logentry:${accountId}:${date}`, entry);
    pipeline.zadd(`logdates:${accountId}`, { score: Number(date.replace(/-/g, '')), member: date });
    await pipeline.exec();

    res.status(200).json({ ok: true });
  } catch (err) {
    // Unlike the baseline endpoints (subscribe.js, send-push.js), this
    // handler intentionally wraps its body in try/catch and returns a
    // generic 500 rather than letting errors propagate to the platform
    // default — a deliberate, stricter error-handling choice for new
    // endpoints going forward, not an oversight.
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
