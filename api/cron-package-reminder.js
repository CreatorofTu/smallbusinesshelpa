const { kv } = require('@vercel/kv');
const webpush = require('web-push');
const { safeCompare } = require('./_safe-compare');

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ============================================================
// cron-package-reminder.js — Vercel Cron target (see vercel.json's "crons"
// entry). "That auto unlocks, and we push a notification to them that
// their package was supposed to be delivered" — this is the automatic
// half: once ~24 hours have passed since a business's $20 setup payment
// was confirmed, and they haven't already tapped "I've received my
// package" (onboarding.html's screen-package CTA -> save-profile's
// `packageReceived` field), send them one real push reminder. Nothing
// "unlocks" server-side — the next screen was never gated — this only
// nudges someone who may have forgotten to open the app back in.
//
// AUTHORIZATION: Vercel's own documented convention for securing a Cron
// endpoint — set a CRON_SECRET env var, and Vercel's scheduler sends it
// back as `Authorization: Bearer <CRON_SECRET>` on every invocation. Fails
// closed (401) if CRON_SECRET isn't configured, same posture as
// ADMIN_TOKEN elsewhere in this codebase — never a route anyone can fire
// just by knowing the URL.
//
// SCOPE: iterates `pushaccounts` (the same set send-push.js's broadcast
// already uses) rather than a new all-accounts index — an account with no
// push subscription can't be reminded this way regardless, so this is
// already the right-sized set to check, no new global index needed.
// Re-notification is prevented by `profile.packageReminderSentAt`, written
// once and never cleared.
// ============================================================

function isProduction24hPast(payments) {
  if (!Array.isArray(payments) || payments.length === 0) return false;
  const first = payments[0];
  if (!first || typeof first.confirmedAt !== 'string') return false;
  const confirmedMs = Date.parse(first.confirmedAt);
  if (!Number.isFinite(confirmedMs)) return false;
  return (Date.now() - confirmedMs) >= 24 * 60 * 60 * 1000;
}

module.exports = async function handler(req, res) {
  const configuredSecret = process.env.CRON_SECRET || '';
  const authHeader = req.headers['authorization'] || '';
  const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!configuredSecret || !safeCompare(presented, configuredSecret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const accountIds = (await kv.smembers('pushaccounts')) || [];
  const results = { checked: accountIds.length, sent: 0, skipped: 0, removedStaleSub: 0, failed: 0 };

  const payload = JSON.stringify({
    title: 'Herald',
    body: 'Your sticker kit should have arrived by now — open the app to confirm and keep setting up.',
    url: '/onboarding.html',
  });

  await Promise.all(
    accountIds.map(async (accountId) => {
      try {
        const profile = await kv.get(`profile:${accountId}`);
        if (!profile) { results.skipped += 1; return; }
        if (profile.packageReceivedAt) { results.skipped += 1; return; }
        if (profile.packageReminderSentAt) { results.skipped += 1; return; }
        if (!isProduction24hPast(profile.payments)) { results.skipped += 1; return; }

        const subscription = await kv.get(`pushsub:${accountId}`);
        if (!subscription) { results.skipped += 1; return; }

        try {
          await webpush.sendNotification(subscription, payload);
          await kv.set(`profile:${accountId}`, Object.assign({}, profile, { packageReminderSentAt: new Date().toISOString() }));
          results.sent += 1;
        } catch (err) {
          if (err.statusCode === 404 || err.statusCode === 410) {
            await kv.del(`pushsub:${accountId}`);
            await kv.srem('pushaccounts', accountId);
            results.removedStaleSub += 1;
          } else {
            results.failed += 1;
          }
        }
      } catch (err) {
        results.failed += 1;
      }
    })
  );

  res.status(200).json(results);
};
