const { kv } = require('@vercel/kv');

// ============================================================
// stripe-webhook.js — Stripe's server-to-server event receiver. This is the
// ONLY place a paid tier becomes real on an account: the client's own
// "I paid" confirmation (save-profile.js's payments log) is honor-system,
// but this endpoint hears it from Stripe itself, cryptographically signed.
//
// SIGNATURE VERIFICATION, FAIL CLOSED — this route is public and
// unauthenticated by nature (Stripe has no session cookie), so the
// stripe-signature header is the entire auth model. Every request is
// verified against the RAW request body with
// stripe.webhooks.constructEvent(rawBody, signature, STRIPE_WEBHOOK_SECRET);
// anything that fails — bad signature, missing header, missing secret —
// gets a 400 and is never processed. Without this, anyone who found the URL
// could POST a fake checkout.session.completed and grant themselves (or
// anyone) a paid tier for free.
//
// RAW BODY REQUIRED — the signature covers the exact bytes Stripe sent.
// A parsed-then-restringified body almost never byte-matches (key order,
// whitespace, unicode escapes), so verification would fail on every real
// event. The config export below disables Vercel's automatic body parsing
// for this route, and the handler collects the raw stream itself.
//
// ACCOUNT LINKAGE — CLIENT_REFERENCE_ID DEPENDENCY (document once, here):
// onboarding.html's startTierPayment() appends
// ?client_reference_id=<accountId> to the Payment Link URL it opens.
// Stripe carries that value through checkout untouched and hands it back
// on the resulting checkout.session.completed event as
// session.client_reference_id. That is the ONLY thread connecting a Stripe
// payment to a Herald account — if onboarding.html ever stops appending
// it, payments still succeed but land here with no account to attach to
// (logged and skipped below, never guessed).
//
// Note this means the accountId here is CLIENT-SUPPLIED (it rode a URL the
// payer's own browser opened). That is acceptable for this write and only
// this write, because the signature proves the money is real and the worst
// a hostile payer can do by editing the param is pay real money to gift a
// tier to some other existing account — there is no read-back path here and
// no way to touch another account's data. The id is still charset-checked
// (ID_RE below) before ever being embedded in a KV key, same instinct as
// save-profile.js's ID_RE: a ':' or path-ish character in a client value
// must never reach a KV key.
//
// TIER INFERENCE — read off the subscription's own Price lookup_key
// (justaddegg_light_monthly / justaddegg_full_monthly, created by
// scripts/stripe-provision.js) rather than hardcoded price IDs — chosen
// deliberately so recreating the Prices someday (test-mode -> live-mode,
// a pricing change) never requires touching or redeploying this file.
// No shared constants module exists in this codebase (see CLAUDE.md's
// "no shared prompt module" lesson) — these strings must stay in sync with
// scripts/stripe-provision.js and api/stripe-upgrade.js by hand.
//
// REVERSE INDEX — stripecustomer:<stripeCustomerId> -> accountId, written
// on checkout completion. customer.subscription.deleted events only carry
// the Stripe customer id, and profiles are keyed by accountId — without
// this index, handling a cancellation would mean a full profile:* scan on
// every event. Written alongside the profile merge, small and permanent.
//
// RETRY SEMANTICS — Stripe retries any non-2xx for days. So: 200 for
// everything handled OR deliberately skipped (unknown event types, a
// checkout with no/invalid client_reference_id, a profile that doesn't
// exist — retrying those would produce the same skip forever), and 500
// only for genuinely transient failures (KV or Stripe API errors) where a
// retry can actually succeed. Both handlers below are idempotent merges,
// so a retry after a partial failure is safe — same "never mark done until
// confirmed" discipline as cron-anomaly-push.js: the profile write IS the
// done-marker, and it only happens after the Stripe lookups succeed.
// Response bodies never carry internal error detail — Stripe doesn't read
// them and anyone else probing this route shouldn't either.
// ============================================================

// Same charset rule as save-profile.js's ID_RE and for the same reason:
// this value gets embedded in KV keys (profile:<accountId>) where ':' is
// the segment delimiter.
const ID_RE = /^[A-Za-z0-9_-]+$/;

const TIER_BY_LOOKUP_KEY = {
  justaddegg_light_monthly: 'light',
  justaddegg_full_monthly: 'full',
};

// Cap on the raw body we will buffer. Real Stripe events are a few KB;
// anything approaching this is not Stripe and gets rejected before it can
// exhaust function memory — same input-size posture as save-profile.js's
// body caps, applied at the stream level since parsing is disabled here.
const MAX_BODY_BYTES = 1024 * 1024; // 1MB

function readRawBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let total = 0;
    req.on('data', function (chunk) {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('Body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', function () { resolve(Buffer.concat(chunks)); });
    req.on('error', reject);
  });
}

// Lazy client construction so merely loading this module (Vercel does this
// at cold start) never throws when env vars are absent — the handler itself
// fails closed instead, with a real HTTP status.
function getStripe() {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) return null;
  const Stripe = require('stripe');
  return new Stripe(key);
}

async function handleCheckoutCompleted(stripe, session) {
  const accountId = typeof session.client_reference_id === 'string' ? session.client_reference_id : '';
  if (!accountId || !ID_RE.test(accountId)) {
    // No usable account linkage — a checkout opened without the URL param
    // (see the dependency comment in the header), or a tampered value.
    // Deliberate skip, not an error: retrying can never make an id appear.
    console.log('stripe-webhook: checkout.session.completed with missing/invalid client_reference_id — skipped.');
    return { skipped: true };
  }

  const profileKey = `profile:${accountId}`;
  const profile = await kv.get(profileKey);
  if (!profile || typeof profile !== 'object') {
    // Never create an account from a webhook — a payment referencing an
    // accountId this app has never seen is a linkage bug (or a tampered
    // param), and inventing a profile here would mint a ghost account with
    // a paid tier and no owner. Log loudly, skip permanently.
    console.log(`stripe-webhook: checkout.session.completed for unknown accountId "${accountId}" — no profile, skipped.`);
    return { skipped: true };
  }

  const customerId = typeof session.customer === 'string' ? session.customer : (session.customer && session.customer.id) || '';
  const subscriptionId = typeof session.subscription === 'string' ? session.subscription : (session.subscription && session.subscription.id) || '';
  if (!subscriptionId) {
    // A completed checkout with no subscription would mean a one-time-mode
    // link — exactly the old accidental shape this billing revision
    // replaces. Nothing to attach; skip rather than half-record it.
    console.log(`stripe-webhook: checkout.session.completed for "${accountId}" has no subscription (one-time link?) — skipped.`);
    return { skipped: true };
  }

  // Fetch the subscription to learn (a) its first line-item id — required
  // later by stripe-upgrade.js's price-swap call, which addresses the
  // specific item being swapped — and (b) which Price it's on, to infer
  // tier from the Price's own lookup_key (see header).
  const subscription = await stripe.subscriptions.retrieve(subscriptionId);
  const item = subscription.items && subscription.items.data && subscription.items.data[0];
  const itemId = item ? item.id : '';
  const lookupKey = item && item.price ? item.price.lookup_key : '';
  const tier = TIER_BY_LOOKUP_KEY[lookupKey] || '';
  if (!tier) {
    console.log(`stripe-webhook: subscription ${subscriptionId} price lookup_key "${lookupKey}" matches no known tier — stored Stripe ids anyway, tier left unchanged.`);
  }

  // Merge, never overwrite — same posture as save-profile.js: this handler
  // owns only the Stripe-linkage fields (plus tier/paid, where this
  // endpoint is the most authoritative writer there is).
  const updated = Object.assign({}, profile, {
    stripeCustomerId: customerId || profile.stripeCustomerId || '',
    stripeSubscriptionId: subscriptionId,
    stripeSubscriptionItemId: itemId,
    updatedAt: new Date().toISOString(),
  });
  if (tier) {
    updated.tier = tier;
    updated.paid = true;
  }
  await kv.set(profileKey, updated);

  // Reverse index for cancellation events — see header. Written after the
  // profile so a failure between the two writes leaves the more important
  // record in place; a Stripe retry of this (idempotent) handler heals the
  // index.
  if (customerId) {
    await kv.set(`stripecustomer:${customerId}`, accountId);
  }
  return { ok: true };
}

async function handleSubscriptionDeleted(subscription) {
  const customerId = typeof subscription.customer === 'string' ? subscription.customer : (subscription.customer && subscription.customer.id) || '';
  if (!customerId) {
    console.log('stripe-webhook: customer.subscription.deleted with no customer id — skipped.');
    return { skipped: true };
  }

  const accountId = await kv.get(`stripecustomer:${customerId}`);
  if (!accountId || typeof accountId !== 'string' || !ID_RE.test(accountId)) {
    // A cancellation for a customer this app never indexed — e.g. a
    // subscription created before this webhook existed. Nothing to update.
    console.log(`stripe-webhook: customer.subscription.deleted for unindexed customer "${customerId}" — skipped.`);
    return { skipped: true };
  }

  const profileKey = `profile:${accountId}`;
  const profile = await kv.get(profileKey);
  if (!profile || typeof profile !== 'object') {
    console.log(`stripe-webhook: customer.subscription.deleted — index points at "${accountId}" but no profile exists, skipped.`);
    return { skipped: true };
  }

  // Only deactivate if the deleted subscription is the one this profile is
  // actually on — a stale delete event for an OLD subscription (e.g. after
  // a cancel-and-resubscribe) must never knock out a newer, live one.
  if (profile.stripeSubscriptionId && profile.stripeSubscriptionId !== subscription.id) {
    console.log(`stripe-webhook: deleted subscription ${subscription.id} is not "${accountId}"'s current one (${profile.stripeSubscriptionId}) — skipped.`);
    return { skipped: true };
  }

  // Mark the tier inactive. tier -> '' (nothing anywhere gates on '' as a
  // real tier, so every tier-gated feature turns off) and paid -> false,
  // with the cancellation timestamped for the record. Stripe linkage ids
  // for the DEAD subscription are cleared so stripe-upgrade.js's "requires
  // stripeSubscriptionId" check correctly reports no active subscription;
  // stripeCustomerId and the reverse index are kept — the Stripe customer
  // still exists and a future re-subscribe reuses it.
  const updated = Object.assign({}, profile, {
    tier: '',
    paid: false,
    stripeSubscriptionId: '',
    stripeSubscriptionItemId: '',
    subscriptionCanceledAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  await kv.set(profileKey, updated);
  return { ok: true };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  // Fail closed on missing configuration — an unset webhook secret must
  // never downgrade to "process unverified events" (same posture as
  // _session.js's getSecret and admin-export.js's ADMIN_TOKEN check).
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  const stripe = getStripe();
  if (!webhookSecret || !stripe) {
    res.status(400).json({ error: 'Not configured' });
    return;
  }

  let event;
  try {
    const rawBody = await readRawBody(req);
    const signature = req.headers['stripe-signature'];
    // constructEvent throws on any signature mismatch, malformed header,
    // or stale timestamp — every failure path lands in the catch and 400s.
    event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
  } catch (err) {
    res.status(400).json({ error: 'Invalid signature' });
    return;
  }

  // From here the event is authentic. Processing errors are caught and
  // answered 500 WITHOUT detail so Stripe retries transient failures —
  // see RETRY SEMANTICS in the header.
  try {
    if (event.type === 'checkout.session.completed') {
      await handleCheckoutCompleted(stripe, event.data.object);
    } else if (event.type === 'customer.subscription.deleted') {
      await handleSubscriptionDeleted(event.data.object);
    }
    // Any other event type (shouldn't arrive — the endpoint registration in
    // scripts/stripe-provision.js only subscribes to the two above) is
    // acknowledged and ignored.
    res.status(200).json({ received: true });
  } catch (err) {
    console.log('stripe-webhook: processing failed for event ' + event.id + ' (' + event.type + '): ' + ((err && err.message) || err));
    res.status(500).json({ error: 'Processing failed' });
  }
};

// Vercel Node function convention: disable automatic body parsing so the
// handler receives the raw stream — required for signature verification
// (see RAW BODY REQUIRED in the header). This must stay attached to this
// route; removing it silently breaks every webhook with a 400.
module.exports.config = { api: { bodyParser: false } };
