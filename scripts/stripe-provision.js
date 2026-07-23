// ============================================================
// scripts/stripe-provision.js — ONE-OFF, MANUALLY-RUN provisioning script.
// Run it yourself, once, with the real secret key in the environment:
//
//   STRIPE_SECRET_KEY=sk_... node scripts/stripe-provision.js
//
// It is NOT a serverless function and must never be deployed as one — it
// lives in scripts/ (not api/) precisely so Vercel's file-router never
// turns it into a route anyone could hit.
//
// WHAT IT CREATES (per the 2026-07-23 billing revision in
// PRODUCT-CONTEXT.md — both tiers are recurring monthly now; the old live
// $20 Payment Link was accidentally a ONE-TIME charge and is being
// replaced, not relabeled):
//   1. Product + recurring monthly Price, $20.00  — lookup_key
//      "justaddegg_light_monthly"
//   2. Product + recurring monthly Price, $100.00 — lookup_key
//      "justaddegg_full_monthly"
//   3. A Payment Link for each Price (a recurring Price makes the link a
//      subscription checkout automatically — no mode flag exists or is
//      needed on Payment Links).
//   4. A webhook endpoint at
//      https://smallbusinesshelpa.vercel.app/api/stripe-webhook
//      listening for checkout.session.completed and
//      customer.subscription.deleted — the two events api/stripe-webhook.js
//      actually handles.
//
// There is deliberately NO $80 Price here: the founder's "$80" was mental
// math (100 - 20). The real upgrade path is a true subscription price-swap
// with proration_behavior: 'create_prorations' (see api/stripe-upgrade.js)
// — Stripe credits the unused part of the current $20 period and charges
// the prorated $100 rate for the remainder, landing at $100/month. Creating
// a literal $80 Price would produce $80/month forever, which is wrong.
//
// IDEMPOTENT ON PURPOSE — safe to re-run. A provisioning script that
// creates duplicates on every retry (a flaky network, a half-finished
// first run) silently pollutes the real Stripe account with lookalike
// Products/Prices that are painful to untangle later. Every step therefore
// checks for its own prior work before creating anything:
//   - Prices: found via stripe.prices.list({ lookup_keys: [...] }) —
//     lookup_key is Stripe's own built-in stable handle for exactly this
//     "find the price I made last time" problem.
//   - Payment Links: Stripe has no lookup_key for links, so each link this
//     script creates is tagged with metadata.jae_lookup_key and re-runs
//     find it by scanning active links for that tag.
//   - Webhook endpoint: matched by exact URL. If one already exists it is
//     SKIPPED with a loud warning, because Stripe only reveals a webhook's
//     signing secret ONCE, at creation — a re-run cannot re-print it. If
//     the secret was lost, delete the endpoint in the Stripe Dashboard and
//     re-run this script to mint a fresh one.
//
// FAILS LOUDLY, NEVER SILENTLY — an unset STRIPE_SECRET_KEY exits non-zero
// immediately. Same fail-closed posture as _session.js's getSecret(): a
// missing secret must never quietly degrade into half-done work.
// ============================================================

'use strict';

const WEBHOOK_URL = 'https://smallbusinesshelpa.vercel.app/api/stripe-webhook';

// These two lookup_keys are the stable contract between this script,
// api/stripe-webhook.js (reads them off the subscription's Price to infer
// tier) and api/stripe-upgrade.js (finds the Full price by lookup_key at
// request time). This codebase has no shared server-side constants module
// (a lesson already learned the hard way — see CLAUDE.md's "no shared
// prompt module" note), so if you ever change one of these strings, change
// it in ALL THREE files or tier inference silently breaks.
const LIGHT_LOOKUP_KEY = 'justaddegg_light_monthly';
const FULL_LOOKUP_KEY = 'justaddegg_full_monthly';

const TIERS = [
  {
    lookupKey: LIGHT_LOOKUP_KEY,
    productName: 'Justaddegg Light — $20/month',
    // unit_amount is in CENTS — the single most classic Stripe provisioning
    // mistake is passing dollars here and creating a $0.20 price.
    unitAmountCents: 2000,
    label: 'Light ($20/mo)',
  },
  {
    lookupKey: FULL_LOOKUP_KEY,
    productName: 'Justaddegg Full — $100/month',
    unitAmountCents: 10000,
    label: 'Full ($100/mo)',
  },
];

const WEBHOOK_EVENTS = ['checkout.session.completed', 'customer.subscription.deleted'];

async function main() {
  const secretKey = process.env.STRIPE_SECRET_KEY;
  if (!secretKey) {
    // Fail loud, fail immediately — never let a missing key produce a
    // half-provisioned account or a confusing downstream API error.
    console.error('');
    console.error('ERROR: STRIPE_SECRET_KEY is not set.');
    console.error('Run this script as:');
    console.error('  STRIPE_SECRET_KEY=sk_... node scripts/stripe-provision.js');
    console.error('');
    process.exit(1);
  }

  const Stripe = require('stripe');
  const stripe = new Stripe(secretKey);

  const paymentLinkUrls = {}; // lookupKey -> url, for the final summary

  for (const tier of TIERS) {
    // ---- 1. Price (and Product), idempotent via lookup_key ----
    let price = null;
    const existingPrices = await stripe.prices.list({
      lookup_keys: [tier.lookupKey],
      limit: 1,
    });
    if (existingPrices.data.length > 0) {
      price = existingPrices.data[0];
      console.log(`[${tier.label}] Price already exists (${price.id}) — reusing, nothing created.`);
      // Sanity check, loudly — a price that matches the lookup_key but not
      // the expected amount/interval means someone changed things in the
      // Dashboard; silently reusing it would wire the app to a wrong price.
      const recurringOk = price.recurring && price.recurring.interval === 'month';
      if (price.unit_amount !== tier.unitAmountCents || !recurringOk) {
        console.warn(`[${tier.label}] WARNING: existing price is ${price.unit_amount} cents, ` +
          `recurring=${JSON.stringify(price.recurring)} — expected ${tier.unitAmountCents} cents monthly. ` +
          'Check the Stripe Dashboard before going live.');
      }
    } else {
      // products.create + prices.create in one shot via price's
      // product_data — keeps Product and Price born together so a re-run
      // never has to reconcile a Product that exists without its Price.
      price = await stripe.prices.create({
        currency: 'usd',
        unit_amount: tier.unitAmountCents,
        recurring: { interval: 'month' },
        lookup_key: tier.lookupKey,
        product_data: { name: tier.productName },
      });
      console.log(`[${tier.label}] Created Product + monthly Price (${price.id}, lookup_key=${tier.lookupKey}).`);
    }

    // ---- 2. Payment Link, idempotent via metadata tag ----
    // Payment Links have no lookup_key of their own, so links created here
    // carry metadata.jae_lookup_key and re-runs find them by that tag.
    // (list() has no metadata filter, so this scans active links — fine at
    // this account's scale of a handful of links.)
    let link = null;
    const existingLinks = await stripe.paymentLinks.list({ active: true, limit: 100 });
    for (const l of existingLinks.data) {
      if (l.metadata && l.metadata.jae_lookup_key === tier.lookupKey) {
        link = l;
        break;
      }
    }
    if (link) {
      console.log(`[${tier.label}] Payment Link already exists (${link.id}) — reusing.`);
    } else {
      link = await stripe.paymentLinks.create({
        line_items: [{ price: price.id, quantity: 1 }],
        metadata: { jae_lookup_key: tier.lookupKey },
      });
      console.log(`[${tier.label}] Created Payment Link (${link.id}).`);
    }
    paymentLinkUrls[tier.lookupKey] = link.url;
  }

  // ---- 3. Webhook endpoint, idempotent via exact-URL match ----
  let webhookSecret = null;
  let webhookSkipped = false;
  const existingEndpoints = await stripe.webhookEndpoints.list({ limit: 100 });
  const already = existingEndpoints.data.find(function (ep) { return ep.url === WEBHOOK_URL; });
  if (already) {
    webhookSkipped = true;
    console.warn('');
    console.warn(`[webhook] An endpoint already exists at ${WEBHOOK_URL} (${already.id}) — SKIPPING creation.`);
    console.warn('[webhook] Stripe only reveals a signing secret ONCE, at creation — it CANNOT be');
    console.warn('[webhook] re-retrieved for an existing endpoint. If you still have the secret saved');
    console.warn('[webhook] as STRIPE_WEBHOOK_SECRET, you are fine. If it was lost, delete this');
    console.warn('[webhook] endpoint in the Stripe Dashboard (Developers -> Webhooks) and re-run this');
    console.warn('[webhook] script to mint a fresh one.');
  } else {
    const endpoint = await stripe.webhookEndpoints.create({
      url: WEBHOOK_URL,
      enabled_events: WEBHOOK_EVENTS,
    });
    webhookSecret = endpoint.secret;
    console.log(`[webhook] Created endpoint ${endpoint.id} at ${WEBHOOK_URL}.`);
  }

  // ---- Final summary — everything a human needs to finish wiring ----
  console.log('');
  console.log('================================================================');
  console.log('DONE. Manual steps to finish wiring (copy these now):');
  console.log('================================================================');
  console.log('');
  console.log('1. Paste these into onboarding.html (the PAYMENT_LINK_* constants');
  console.log('   near the top of its <script> block):');
  console.log('');
  console.log(`   PAYMENT_LINK_LIGHT = '${paymentLinkUrls[LIGHT_LOOKUP_KEY]}'`);
  console.log(`   PAYMENT_LINK_FULL  = '${paymentLinkUrls[FULL_LOOKUP_KEY]}'`);
  console.log('');
  if (webhookSecret) {
    console.log('2. *** SAVE THIS NOW — IT IS SHOWN EXACTLY ONCE AND CANNOT BE');
    console.log('   RETRIEVED AGAIN. *** Set it as the STRIPE_WEBHOOK_SECRET');
    console.log('   environment variable in Vercel (Project Settings ->');
    console.log('   Environment Variables), alongside STRIPE_SECRET_KEY:');
    console.log('');
    console.log(`   STRIPE_WEBHOOK_SECRET=${webhookSecret}`);
    console.log('');
  } else if (webhookSkipped) {
    console.log('2. Webhook endpoint already existed — no new signing secret was');
    console.log('   minted (see the warning above). Confirm STRIPE_WEBHOOK_SECRET');
    console.log('   is already set in Vercel, or delete + re-run to get a new one.');
    console.log('');
  }
  console.log('3. Deactivate the OLD one-time $20 Payment Link in the Stripe');
  console.log('   Dashboard once the new links are live — per PRODUCT-CONTEXT.md');
  console.log('   it was accidentally one-time and is being replaced, not kept.');
  console.log('');
}

main().catch(function (err) {
  console.error('');
  console.error('Provisioning FAILED partway through. This script is idempotent —');
  console.error('fix the cause and re-run; already-created objects will be reused,');
  console.error('not duplicated.');
  console.error('');
  console.error(err && err.message ? err.message : err);
  process.exit(1);
});
