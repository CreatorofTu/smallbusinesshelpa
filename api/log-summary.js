const { kv } = require('@vercel/kv');
const { getSessionFromRequest } = require('./_session');

// AUTHORIZATION: accountId is derived from the caller's signed session
// cookie (see _session.js), never from the query string. This also closes a
// separate exposure concern: accountId used to travel as a GET query param
// (`?accountId=...`), which — since it was the only thing these endpoints
// checked, i.e. it functioned as a bearer credential — was more likely to
// land in access logs or browser history than the POST-body form the other
// account-scoped endpoints used. The query string now carries only `today`.
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const DAY_MS = 24 * 60 * 60 * 1000;
const DROP_THRESHOLD_PCT = 15;
const MIN_ENTRIES_FOR_COMPARISON = 4;

// Parses a "YYYY-MM-DD" string into a UTC-anchored timestamp. This is only
// ever used for calendar-day arithmetic (offsetting by whole days), never as
// a wall-clock time, so anchoring in UTC sidesteps DST entirely. The date
// always comes from the caller's own local calendar (the `today` query
// param) — this file never touches Date.now() or `new Date()`.
function parseDateUTC(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatDateUTC(ms) {
  const dt = new Date(ms);
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

// Ascending "YYYY-MM-DD" date strings covering the inclusive range from
// `startDaysBack` days before the anchor through `endDaysBack` days before
// the anchor. E.g. windowDates(anchor, 6, 0) is the 7 days ending on the
// anchor date (today); windowDates(anchor, 13, 7) is the 7 days before that.
function windowDates(anchorMs, startDaysBack, endDaysBack) {
  const dates = [];
  for (let daysBack = startDaysBack; daysBack >= endDaysBack; daysBack--) {
    dates.push(formatDateUTC(anchorMs - daysBack * DAY_MS));
  }
  return dates;
}

function summarizeWindow(dates, entryByDate) {
  const entries = dates.map((date) => entryByDate.get(date)).filter(Boolean);
  const entryCount = entries.length;
  const avgCustomers = entryCount === 0
    ? 0
    : entries.reduce((sum, e) => sum + e.customers, 0) / entryCount;
  const avgSales = entryCount === 0
    ? 0
    : entries.reduce((sum, e) => sum + e.sales, 0) / entryCount;

  return { entryCount, avgCustomers, avgSales };
}

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

    const { today } = req.query || {};

    if (!today || typeof today !== 'string' || !DATE_RE.test(today)) {
      res.status(400).json({ error: 'Missing or malformed today' });
      return;
    }

    const anchorMs = parseDateUTC(today);
    const thisWeekDates = windowDates(anchorMs, 6, 0);
    const lastWeekDates = windowDates(anchorMs, 13, 7);

    const allDates = await kv.zrange(`logdates:${accountId}`, 0, -1);
    const dateList = Array.isArray(allDates) ? allDates : [];
    const relevantDates = dateList.filter(
      (date) => thisWeekDates.includes(date) || lastWeekDates.includes(date)
    );

    // A small, bounded number of keys (at most 14) — plain kv.get calls in a
    // Promise.all rather than kv.mget, since mget's availability on the
    // @vercel/kv client wasn't confirmed.
    const entries = await Promise.all(
      relevantDates.map((date) => kv.get(`logentry:${accountId}:${date}`))
    );

    const entryByDate = new Map();
    relevantDates.forEach((date, i) => {
      if (entries[i]) entryByDate.set(date, entries[i]);
    });

    const thisWeek = summarizeWindow(thisWeekDates, entryByDate);
    const lastWeek = summarizeWindow(lastWeekDates, entryByDate);

    if (
      thisWeek.entryCount < MIN_ENTRIES_FOR_COMPARISON ||
      lastWeek.entryCount < MIN_ENTRIES_FOR_COMPARISON
    ) {
      res.status(200).json({
        status: 'collecting',
        thisWeek,
        lastWeek,
        message: 'Keep logging — a few more days before this week-over-week comparison means something.',
      });
      return;
    }

    const customersPct = lastWeek.avgCustomers === 0
      ? null
      : ((thisWeek.avgCustomers - lastWeek.avgCustomers) / lastWeek.avgCustomers) * 100;
    const salesPct = lastWeek.avgSales === 0
      ? null
      : ((thisWeek.avgSales - lastWeek.avgSales) / lastWeek.avgSales) * 100;

    const drops = [
      { metric: 'Customers', pct: customersPct },
      { metric: 'Sales', pct: salesPct },
    ].filter((c) => c.pct !== null && c.pct <= -DROP_THRESHOLD_PCT);

    if (drops.length === 0) {
      res.status(200).json({
        status: 'stable',
        thisWeek,
        lastWeek,
        message: 'Nothing significant moved this week — steady.',
      });
      return;
    }

    // Larger-magnitude drop wins (most negative pct).
    drops.sort((a, b) => a.pct - b.pct);
    const worst = drops[0];

    // Most recent thisWeek entry with a note, searching newest-first.
    let noteEntry = null;
    for (let i = thisWeekDates.length - 1; i >= 0; i--) {
      const entry = entryByDate.get(thisWeekDates[i]);
      if (entry && entry.note) {
        noteEntry = entry;
        break;
      }
    }

    const roundedPct = Math.round(Math.abs(worst.pct));
    const directive = noteEntry
      ? `${worst.metric} dropped ${roundedPct}% this week compared to last. You mentioned "${noteEntry.note}" on ${noteEntry.date} — could that be it?`
      : `${worst.metric} dropped ${roundedPct}% this week compared to last. Nothing logged changed — worth asking why.`;

    res.status(200).json({
      status: 'directive',
      thisWeek,
      lastWeek,
      directive,
    });
  } catch (err) {
    // Unlike the baseline endpoints (subscribe.js, send-push.js), this
    // handler intentionally wraps its body in try/catch and returns a
    // generic 500 rather than letting errors propagate to the platform
    // default — a deliberate, stricter error-handling choice for new
    // endpoints going forward, not an oversight.
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
