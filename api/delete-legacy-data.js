const { kv } = require('@vercel/kv');
const { safeCompare } = require('./_safe-compare');

// ============================================================
// ONE-TIME, DESTRUCTIVE CLEANUP TOOL — not called by any page, run manually
// by the founder once, via e.g.:
//
//   curl -X POST https://<your-deploy>/api/delete-legacy-data \
//     -H "x-admin-token: <ADMIN_TOKEN>"
//
// This permanently deletes the OLD, pre-account global keys that predate
// real accounts (businessProfile, every logentry:<date>, logdates,
// subscriptions, every sub:<id>) — the reference/test data from before this
// app had real per-business accounts. This is IRREVERSIBLE. Real, current
// data lives under account-scoped keys (profile:<accountId>,
// logentry:<accountId>:<date>, logdates:<accountId>, pushsub:<accountId>,
// pushaccounts) and is NEVER touched by this endpoint.
//
// Run this only after confirming (e.g. via /api/migrate-legacy-data, or by
// simply deciding the old data was reference-only and not worth carrying
// forward) that nothing under the old keys is still needed.
// ============================================================

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = req.headers['x-admin-token'];
  if (!token || !safeCompare(String(token), String(process.env.ADMIN_TOKEN || ''))) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  try {
    const deleted = { businessProfile: false, logEntries: 0, logdates: false, subscriptions: 0, subscriptionsSet: false };

    const hadProfile = await kv.get('businessProfile');
    if (hadProfile) {
      await kv.del('businessProfile');
      deleted.businessProfile = true;
    }

    const legacyDates = (await kv.zrange('logdates', 0, -1)) || [];
    for (const date of legacyDates) {
      await kv.del(`logentry:${date}`);
      deleted.logEntries += 1;
    }
    if (legacyDates.length > 0 || (await kv.exists('logdates'))) {
      await kv.del('logdates');
      deleted.logdates = true;
    }

    const legacyIds = (await kv.smembers('subscriptions')) || [];
    for (const id of legacyIds) {
      await kv.del(`sub:${id}`);
      deleted.subscriptions += 1;
    }
    if (legacyIds.length > 0 || (await kv.exists('subscriptions'))) {
      await kv.del('subscriptions');
      deleted.subscriptionsSet = true;
    }

    res.status(200).json({
      ok: true,
      deleted,
      note: 'Old pre-account global keys removed. Account-scoped keys (profile:<id>, logentry:<id>:<date>, logdates:<id>, pushsub:<id>, pushaccounts) were never touched by this call.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.', detail: err.message });
  }
};
