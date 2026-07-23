const { kv } = require('@vercel/kv');
const webpush = require('web-push');
const { safeCompare } = require('./_safe-compare');
const { computeDirectiveForAccount } = require('./generate-directive');

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ============================================================
// cron-anomaly-push.js — Vercel Cron target (see vercel.json's "crons"
// entry). The proactive half of the directive engine: instead of waiting
// for an owner to open the app and tap "Get today's read," this runs the
// exact same compute pipeline (generate-directive.js's exported
// computeDirectiveForAccount — required directly, never an HTTP self-call)
// once a day for every push-subscribed, fully-onboarded account, and sends
// ONE real push only when the engine actually found something: a verdict
// whose confidenceTier is present and not LOW_NONE. The push body is the
// engine's own directive sentence (or its diagnosticOnlyLead fallback),
// never invented copy — if the verdict carries no real text, nothing is
// sent.
//
// SCHEDULE — "0 15 * * *" (see vercel.json; the rationale lives here
// because vercel.json is strict JSON and cannot carry comments). Once
// daily, deliberately: the directive is a per-DAY verdict (cached per
// accountId+date), so running more often would only re-hit the cache.
// Vercel cron schedules run in UTC; 15:00 UTC lands mid-morning across US
// time zones (11am ET / 8am PT) — a waking-hours notification, with the
// trailing 14-day window fully covered through yesterday. Bonus: whatever
// verdict this computes is written to the same directivecache:<accountId>:
// <date> key the interactive endpoint reads, so an owner who opens the app
// after the push gets the already-paid-for verdict with no second billed
// Anthropic call.
//
// AUTHORIZATION — identical to cron-package-reminder.js: Vercel's own
// documented CRON_SECRET convention (`Authorization: Bearer <CRON_SECRET>`
// on every scheduler invocation), constant-time compare, fails closed
// (401) if CRON_SECRET isn't configured — never a route anyone can fire
// just by knowing the URL. That matters more here than on the package
// reminder: each uncached invocation of the compute pipeline is a real,
// billed Anthropic call.
//
// SCOPE — iterates `pushaccounts` (same set as cron-package-reminder.js /
// send-push.js): an account with no push subscription can't be notified
// regardless, so it's already the right-sized set — no new global index.
// Accounts whose profile is missing or not yet completed are skipped
// (onboarding isn't done; their data isn't ready to reason over).
//
// DE-DUP — anomalypushsent:<accountId>:<date>, written only after a
// successful send, checked before doing anything expensive. EPHEMERAL AND
// REGENERABLE BY DESIGN: it's a short-lived "already pushed for this date"
// marker whose date is embedded in the key itself, expired via TTL a
// couple days later purely as garbage collection — losing it costs at
// worst one duplicate push, so it deliberately does NOT belong in
// admin-export.js's durable backup (same "ephemeral, regenerable" rule as
// directivecache:*, and admin-export's targeted key scans never reach this
// prefix anyway).
//
// ERROR ISOLATION — per-account try/catch matching
// cron-package-reminder.js: one account's KV hiccup, model failure, or
// push failure never aborts the rest of the run. A push rejection with
// statusCode 404/410 means the subscription is gone at the push service —
// remove it the same way cron-package-reminder.js and send-push.js already
// do. Accounts are processed via Promise.all like the sibling cron —
// wall-clock time is bounded by the slowest account rather than the sum,
// which is what matters inside a serverless function's max duration; most
// accounts short-circuit cheaply (profile gate, de-dup hit, directive
// cache hit, or the compute pipeline's own MIN_ENTRIES_PER_WEEK gate)
// before any billed call happens.
// ============================================================

// Display-truncation bound for the push body — notification UIs clip
// around this length anyway, and the full sentence is waiting in the app
// (served from the directive cache) when the owner taps through.
const PUSH_BODY_MAX_CHARS = 180;

// "A couple days" — the date is already part of the de-dup key, so this
// TTL is pure garbage collection, not correctness; it just needs to
// comfortably outlive the day it marks.
const PUSH_SENT_TTL_SECONDS = 60 * 60 * 48;

// Same UTC-anchored calendar-date formatting as wait-finish.js/
// admin-export.js's own todayUTC — duplicated rather than imported (this
// codebase has no shared date-helper module, and no sibling exports it),
// and sourced from the server's real clock since a cron has no
// caller-local "today" to anchor against.
function todayUTC() {
  const dt = new Date();
  const y = dt.getUTCFullYear();
  const m = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const d = String(dt.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function truncateForPush(text) {
  const s = String(text);
  if (s.length <= PUSH_BODY_MAX_CHARS) return s;
  return s.slice(0, PUSH_BODY_MAX_CHARS - 1).trimEnd() + '…';
}

module.exports = async function handler(req, res) {
  const configuredSecret = process.env.CRON_SECRET || '';
  const authHeader = req.headers['authorization'] || '';
  const presented = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (!configuredSecret || !safeCompare(presented, configuredSecret)) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const today = todayUTC();
  const accountIds = (await kv.smembers('pushaccounts')) || [];
  const results = { checked: accountIds.length, pushed: 0, skipped: 0, removedStaleSub: 0, failed: 0 };

  await Promise.all(
    accountIds.map(async (accountId) => {
      try {
        const profile = await kv.get(`profile:${accountId}`);
        if (!profile || profile.completed !== true) { results.skipped += 1; return; }

        // Cheapest gates first — never spend a (potentially billed) compute
        // on an account that was already pushed today or can't receive one.
        const sentKey = `anomalypushsent:${accountId}:${today}`;
        const alreadySent = await kv.get(sentKey).catch(() => null);
        if (alreadySent) { results.skipped += 1; return; }

        const subscription = await kv.get(`pushsub:${accountId}`);
        if (!subscription) { results.skipped += 1; return; }

        const verdict = await computeDirectiveForAccount(accountId, today);
        if (!verdict || typeof verdict.confidenceTier !== 'string' || verdict.confidenceTier === 'LOW_NONE') {
          // Nothing cleared the engine's own gates today (or the engine
          // isn't configured / couldn't get a read — confidenceTier null).
          // No push: silence is the honest output for "nothing to explain."
          results.skipped += 1;
          return;
        }

        // Real engine text only — directive first, diagnosticOnlyLead as
        // fallback. If neither exists, send nothing rather than inventing
        // placeholder copy.
        const bodyText =
          (typeof verdict.directive === 'string' && verdict.directive.trim()) ||
          (typeof verdict.diagnosticOnlyLead === 'string' && verdict.diagnosticOnlyLead.trim()) ||
          '';
        if (!bodyText) { results.skipped += 1; return; }

        const payload = JSON.stringify({
          title: 'Justaddegg',
          body: truncateForPush(bodyText),
          url: '/',
        });

        try {
          await webpush.sendNotification(subscription, payload);
          // Marker written only AFTER a confirmed send — a failed send
          // stays eligible for the next run rather than being silently
          // marked done.
          await kv.set(sentKey, { sentAt: new Date().toISOString(), confidenceTier: verdict.confidenceTier }, { ex: PUSH_SENT_TTL_SECONDS }).catch(() => {});
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
