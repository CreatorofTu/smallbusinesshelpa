const { kv } = require('@vercel/kv');
const webpush = require('web-push');
const { safeCompare } = require('./_safe-compare');

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ============================================================
// cron-baseline-context.js — Vercel Cron target (see vercel.json's "crons"
// entry). While an account is still building its first 7-day baseline —
// before generate-directive.js's engine has enough data to say anything real
// (see that file's MIN_ENTRIES_PER_WEEK gate) — this sends up to three
// well-timed pushes (day 1 / day 4 / day 7 since onboarding completed)
// inviting the owner to give their AI more background on the business.
//
// "NEVER LAW, JUST CONTEXT" — stated here because it's the entire reason
// this cron exists: whatever the owner adds through this touchpoint
// (profile.ownerContext, appended by save-profile.js) is read by
// generate-directive.js's reasoning prompt as color that can inform
// interpretation and framing, but it is NEVER treated as evidence for a
// causal claim. That is the identical reasoning already enforced for
// goal.metric/goal.target being excluded from variableDiffLog (see
// loadVariableDiffLog() in generate-directive.js) — no real causal
// mechanism, real risk of spurious attribution. This cron only ever sends
// the invitation push; it never reads or writes ownerContext itself.
//
// AUTHORIZATION — identical convention to cron-package-reminder.js /
// cron-anomaly-push.js: Vercel's own documented CRON_SECRET convention
// (`Authorization: Bearer <CRON_SECRET>` on every scheduler invocation),
// constant-time compare, fails closed (401) if CRON_SECRET isn't configured
// — never a route anyone can fire just by knowing the URL.
//
// SCOPE — iterates `pushaccounts` (same set both sibling crons already use):
// an account with no push subscription can't be notified regardless, so
// this is already the right-sized set to check, no new global index needed.
//
// SCHEDULE — "0 16 * * *" (see vercel.json; the rationale lives here
// because vercel.json is strict JSON and cannot carry comments). Once
// daily, deliberately staggered an hour after cron-anomaly-push.js's
// "0 15 * * *" so the two crons don't contend for the same invocation
// minute. 16:00 UTC still lands in daytime across US time zones (noon ET /
// 9am PT) — a waking-hours nudge, not a middle-of-the-night one.
//
// MILESTONES — day 1 / day 4 / day 7 since profile.completedAt (the
// existing timestamp save-profile.js already sets when the
// `body.completed === true` branch fires at the end of onboarding).
// profile.baselineContextSent (written directly to KV here, no session
// involved) marks which milestones have already fired, e.g.
// { day1: true, day4: true, day7: true }. Checked independently, in
// day1 -> day4 -> day7 order (MILESTONES below), so a single run only ever
// sends the first milestone it finds due-and-unsent for that account —
// guards against ever stacking more than one push on someone in one run.
//
// ERROR ISOLATION — per-account try/catch matching both sibling crons: one
// account's KV hiccup or push failure never aborts the rest of the run.
// Accounts are processed via Promise.all like both siblings. A push
// rejection with statusCode 404/410 means the subscription is gone at the
// push service — remove it the same way both siblings already do. The
// baselineContextSent marker is written ONLY after a confirmed successful
// send, never before — same "never mark done on a failed send" discipline
// as cron-anomaly-push.js's own anomalypushsent marker.
// ============================================================

const DAY_MS = 24 * 60 * 60 * 1000;

// Checked in this exact order — see MILESTONES comment above.
const MILESTONES = [
  { key: 'day1', days: 1 },
  { key: 'day4', days: 4 },
  { key: 'day7', days: 7 },
];

module.exports = async function handler(req, res) {
  const configuredSecret = process.env.CRON_SECRET || '';
  const authHeader = req.headers['authorization'] || '';
  const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!configuredSecret || !safeCompare(presented, configuredSecret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const accountIds = (await kv.smembers('pushaccounts')) || [];
  const results = { checked: accountIds.length, pushed: 0, skipped: 0, removedStaleSub: 0, failed: 0 };

  const payload = JSON.stringify({
    title: 'Justaddegg',
    body: 'Building your baseline — tell your AI more about your business',
    url: '/index.html?context=1',
  });

  await Promise.all(
    accountIds.map(async (accountId) => {
      try {
        const profile = await kv.get(`profile:${accountId}`);
        if (!profile || profile.completed !== true) { results.skipped += 1; return; }

        const completedMs = typeof profile.completedAt === 'string' ? Date.parse(profile.completedAt) : NaN;
        if (!Number.isFinite(completedMs)) { results.skipped += 1; return; }

        const daysSinceCompleted = Math.floor((Date.now() - completedMs) / DAY_MS);
        const sent = (profile.baselineContextSent && typeof profile.baselineContextSent === 'object')
          ? profile.baselineContextSent
          : {};

        // First unmet milestone, checked independently in day1 -> day4 ->
        // day7 order — sends at most one push per account per run.
        //
        // Deliberately >= rather than === : an exact-day match would
        // silently and permanently skip a milestone if this cron ever
        // missed a day (a deploy gap, a rare Vercel outage) — daysSince
        // Completed would jump past m.days without ever equaling it, and
        // that touchpoint would never fire again. >= means a missed day
        // just sends the touchpoint a day late on the next run instead of
        // losing it entirely — same "never silently lose a real
        // touchpoint" bar the rest of this cron already holds itself to.
        let dueMilestone = null;
        for (const m of MILESTONES) {
          if (daysSinceCompleted >= m.days && sent[m.key] !== true) {
            dueMilestone = m;
            break;
          }
        }
        if (!dueMilestone) { results.skipped += 1; return; }

        const subscription = await kv.get(`pushsub:${accountId}`);
        if (!subscription) { results.skipped += 1; return; }

        try {
          await webpush.sendNotification(subscription, payload);
          // Marker written only AFTER a confirmed send — a failed send
          // stays eligible for the next run rather than being silently
          // marked done, same discipline as cron-anomaly-push.js.
          await kv.set(`profile:${accountId}`, Object.assign({}, profile, {
            baselineContextSent: Object.assign({}, profile.baselineContextSent, { [dueMilestone.key]: true }),
          }));
          results.pushed += 1;
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
