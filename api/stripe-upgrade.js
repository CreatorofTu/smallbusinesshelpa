const { kv } = require('@vercel/kv');
const { getSessionFromRequest } = require('./_session');

// ============================================================
// stripe-upgrade.js — the Light ($20/mo) -> Full ($100/mo) upgrade, as a
// TRUE Stripe subscription price-swap with proration. Per the 2026-07-23
// billing revision in PRODUCT-CONTEXT.md: the founder's "$80" was mental
// math (100 - 20), NOT a separate Price object and NOT a second stacked
// subscription. stripe.subscriptions.update with proration_behavior:
// 'create_prorations' does the industry-standard thing natively — Stripe
// credits the unused portion of the current $20 period, charges the
// prorated $100 rate for the remainder, and the subscription lands at a
// clean $100/month going forward.
//
// AUTHORIZATION — identical to save-profile.js: accountId comes ONLY from
// the caller's signed session cookie (getSessionFromRequest), never from
// the request body/query. This endpoint mutates a real recurring charge on
// a real card — exactly the kind of route where re-trusting a
// client-supplied accountId would let anyone who learned another account's
// id raise that account's bill. 401 with no session, full stop.
//
// METHODS —
//   GET: returns { tier, hasSubscription } for the caller's own account.
//     Exists because index.html has NO server-side profile read today (it
//     gates everything on localStorage flags), and the upgrade card must
//     be gated on the SERVER'S tier — the client's localStorage belief can
//     be stale (the webhook writes tier to KV, not to any browser) or
//     simply edited. Read-only, session-scoped, returns nothing but the
//     two fields the card needs — deliberately not a general profile-dump
//     endpoint.
//   POST: performs the upgrade.
//
// PRECONDITIONS (POST), each with an honest, plain 400 —
//   - profile.stripeSubscriptionId + stripeSubscriptionItemId must exist:
//     these are only ever written by stripe-webhook.js after a REAL,
//     signature-verified checkout. Missing means the account never went
//     through real Stripe checkout (e.g. the honor-system "test-mode"
//     payment path) or the webhook hasn't landed yet — either way there is
//     no subscription to swap, and guessing would charge nothing or the
//     wrong thing.
//   - tier must not already be 'full': a repeat click (double-tap, a retry
//     after a slow response) must never reach Stripe a second time. The
//     swap itself is also naturally idempotent (swapping to a price you're
//     already on is a no-op), but cutting it off here is cheaper and gives
//     the honest "already on the full plan" answer.
//
// PRICE RESOLUTION — the Full price is found at request time via
// stripe.prices.list({ lookup_keys: ['justaddegg_full_monthly'] }) rather
// than a hardcoded price ID. Tradeoff, on purpose: one extra Stripe API
// call per upgrade (a rare, human-paced event — not a hot path) in
// exchange for this file never needing a redeploy if the Prices are ever
// recreated (test-mode -> live, a price change). If upgrades ever become
// high-volume, an env-var price ID would be the faster path — revisit then.
// The lookup_key string must stay in sync BY HAND with
// scripts/stripe-provision.js and api/stripe-webhook.js — no shared
// constants module exists in this codebase (see CLAUDE.md's "no shared
// prompt module" lesson).
//
// NEVER MARK DONE UNTIL CONFIRMED — same discipline as
// cron-baseline-context.js's send-then-mark ordering: KV's tier is set to
// 'full' ONLY after stripe.subscriptions.update returns successfully. A
// failed Stripe call returns a calm, non-leaky error and writes NOTHING —
// an account must never show as upgraded while still being billed $20.
// (The reverse gap — Stripe succeeded, then the KV write failed — is
// self-healing in the safe direction: the card still shows "light", a
// retry hits the update again, and swapping to the price it's already on
// is a Stripe no-op that generates no new proration.)
// ============================================================

const FULL_LOOKUP_KEY = 'justaddegg_full_monthly';

// Lazy client construction so merely loading this module never throws when
// STRIPE_SECRET_KEY is absent — the handler fails closed with a real HTTP
// status instead (same pattern as stripe-webhook.js).
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const Stripe = require('stripe');
  return new Stripe(key);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
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

    const profileKey = `profile:${accountId}`;
    const profile = await kv.get(profileKey);

    if (req.method === 'GET') {
      // Read-only tier check for index.html's upgrade-card gating — see
      // METHODS in the header. Never errors on a missing profile: "no
      // profile yet" is a normal mid-onboarding state, answered honestly.
      res.status(200).json({
        tier: (profile && typeof profile.tier === 'string') ? profile.tier : '',
        hasSubscription: !!(profile && profile.stripeSubscriptionId && profile.stripeSubscriptionItemId),
      });
      return;
    }

    // ---- POST: perform the upgrade ----
    if (!profile || typeof profile !== 'object') {
      res.status(400).json({ error: 'No active subscription found — finish setting up first.' });
      return;
    }
    if (profile.tier === 'full') {
      res.status(400).json({ error: 'Already on the full plan.' });
      return;
    }
    if (!profile.stripeSubscriptionId || !profile.stripeSubscriptionItemId) {
      // See PRECONDITIONS in the header — no verified checkout on record.
      res.status(400).json({ error: 'No active subscription found — if you just paid, give it a minute and try again.' });
      return;
    }

    const stripe = getStripe();
    if (!stripe) {
      // Fail closed, not open — an unset secret must never look like a
      // successful upgrade or leak why it failed.
      res.status(500).json({ error: 'Upgrades are not available right now.' });
      return;
    }

    let fullPriceId;
    try {
      const prices = await stripe.prices.list({ lookup_keys: [FULL_LOOKUP_KEY], limit: 1 });
      fullPriceId = prices.data && prices.data[0] && prices.data[0].id;
    } catch (err) {
      res.status(502).json({ error: 'Could not reach the payment provider — try again in a bit.' });
      return;
    }
    if (!fullPriceId) {
      // Provisioning hasn't run (or the lookup_key drifted) — a real
      // wiring problem, surfaced calmly to the owner and loudly in logs.
      console.log('stripe-upgrade: no price found for lookup_key ' + FULL_LOOKUP_KEY + ' — run scripts/stripe-provision.js.');
      res.status(500).json({ error: 'Upgrades are not available right now.' });
      return;
    }

    // The swap itself. Addressing the existing subscription ITEM (not just
    // the subscription) is what makes this a price change on the one
    // existing line rather than adding a second line alongside the $20 one
    // — the "two stacked subscriptions" shape PRODUCT-CONTEXT.md explicitly
    // rejects.
    try {
      await stripe.subscriptions.update(profile.stripeSubscriptionId, {
        items: [{ id: profile.stripeSubscriptionItemId, price: fullPriceId }],
        proration_behavior: 'create_prorations',
      });
    } catch (err) {
      // NOTHING is written to KV on a failed call — see NEVER MARK DONE in
      // the header. Stripe's raw error message can carry internals
      // (ids, decline codes), so it goes to the log, never the response.
      console.log('stripe-upgrade: subscriptions.update failed for ' + accountId + ': ' + ((err && err.message) || err));
      res.status(502).json({ error: 'The upgrade did not go through — you have not been charged the new price. Try again in a bit.' });
      return;
    }

    // Confirmed by Stripe — now (and only now) record it. Merge-don't-
    // overwrite, same as save-profile.js; re-read is skipped deliberately
    // (`profile` was loaded milliseconds ago and this endpoint owns the
    // tier field's transition).
    await kv.set(profileKey, Object.assign({}, profile, {
      tier: 'full',
      paid: true,
      upgradedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }));

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
