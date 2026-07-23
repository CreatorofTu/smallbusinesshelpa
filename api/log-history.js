const { kv } = require('@vercel/kv');
const { getSessionFromRequest } = require('./_session');

// ============================================================
// log-history.js — read-only GET endpoint returning the account's own
// logged days, most recent first, for index.html's History section.
//
// WHY THIS IS THE WHOLE FEATURE'S ONLY NEW BACKEND: log-entry.js is a plain
// upsert keyed logentry:<accountId>:<date> with zero server-side "must be
// today" restriction — editing a past day was ALWAYS possible on the write
// path, the limitation was purely index.html's UI never offering it. So
// this endpoint only has to make history readable; edits reuse log-entry.js
// exactly as-is.
//
// AUTHORIZATION: same convention as every other account-scoped endpoint —
// accountId comes from the caller's signed session cookie (_session.js),
// never from the query string. 401 with no valid session.
//
// CAP: 120 days (~4 months). Enough to cover real usage patterns — a
// baseline period plus a full season of week-over-week comparisons — while
// bounding both the response size and the per-request kv.get fan-out
// (nothing here should ever become an unbounded walk of a years-old log).
// ============================================================

const HISTORY_MAX_DAYS = 120;

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
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

    // logdates:<accountId> scores are Number(date.replace(/-/g,'')) — see
    // log-entry.js — so ascending zrange order IS chronological order.
    // Fetched with the exact (key, 0, -1) shape this codebase already uses
    // everywhere (log-summary.js/generate-directive.js) rather than a
    // rev/limit option whose availability on this @vercel/kv client version
    // isn't confirmed anywhere in this repo; the newest-N/descending cut is
    // then a trivial in-process slice+reverse. Fine at this data scale: the
    // member list is one short date string per logged day.
    const allDates = await kv.zrange(`logdates:${accountId}`, 0, -1);
    const dateList = Array.isArray(allDates) ? allDates : [];
    const recentDescending = dateList.slice(-HISTORY_MAX_DAYS).reverse();

    // Bounded Promise.all of plain kv.get calls — same pattern (and same
    // "mget availability unconfirmed" reasoning) as log-summary.js.
    const entries = await Promise.all(
      recentDescending.map((date) => kv.get(`logentry:${accountId}:${date}`).catch(() => null))
    );

    // A zset member with no matching entry record is tolerated by skipping
    // it, mirroring log-summary.js's own `if (entries[i])` filter.
    const result = [];
    recentDescending.forEach((date, i) => {
      const e = entries[i];
      if (!e) return;
      result.push({
        date: date,
        customers: e.customers,
        sales: e.sales,
        note: e.note || null,
      });
    });

    res.status(200).json({ entries: result });
  } catch (err) {
    // Same deliberate stricter error-handling convention as log-entry.js /
    // log-summary.js — generic 500, no internal detail leaked to the client.
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
