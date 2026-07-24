const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const { getSessionFromRequest } = require('./_session');

// ============================================================
// barter-demo-order.js — creates ONE manufactured Barter claim order so an
// owner can try the "give it a try" experience during onboarding, right
// after entering their core product, instead of only discovering Barter
// exists after onboarding is fully done and a real shortage happens to
// come up (see PRODUCT-CONTEXT.md's distribution-partnership section for
// the real mechanic this previews).
//
// MANUFACTURED SCENARIO, REAL PRODUCT NAME: the "shortage" ingredient is a
// staged placeholder (STAPLE_INGREDIENTS below) — never derived from the
// owner's actual recipe text, which stays encrypted and is never read
// here. The reward name IS the owner's real core product type, since
// that's public-facing menu info the owner just typed, not a secret.
//
// UNLIKE api/barter-broadcast.js, this never calls webpush.sendNotification
// and never touches the `barteraccounts` subscriber set — no real opted-in
// local person should get a push meant only for one owner trying their own
// feature during their own onboarding. It writes the exact same
// barterorder:<id> KV shape api/barter-claim.js already reads/claims, so
// the existing barter.html?claim=<id> screen works completely unmodified.
//
// SESSION-GATED, NOT PUBLIC: unlike barter-claim.js/barter-subscribe.js
// (deliberately open, no login, anonymous customers), this endpoint writes
// a real KV record on every call, so it should only be reachable by a real
// logged-in onboarding account, not anyone on the internet. Session comes
// from the signed cookie (_session.js) — same convention as every other
// account-scoped endpoint in this codebase, never a client-supplied id.
// ============================================================

const PRODUCT_TYPE_MAX = 60;
const BARTERORDER_TTL_SECONDS = 60 * 60 * 6; // matches barter-broadcast.js's real orders
const STAPLE_INGREDIENTS = ['flour', 'sugar', 'eggs', 'brown sugar', 'butter', 'milk'];

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const session = getSessionFromRequest(req);
  if (!session) {
    res.status(401).json({ error: 'Not logged in' });
    return;
  }

  const productTypeRaw = typeof req.body?.productType === 'string' ? req.body.productType.trim().slice(0, PRODUCT_TYPE_MAX) : '';
  const productType = productTypeRaw || 'treat';

  const ingredient = STAPLE_INGREDIENTS[Math.floor(Math.random() * STAPLE_INGREDIENTS.length)];
  const description = `We're running low on ${ingredient} — bring some by and get a free ${productType} on the house, it's on the way!`;

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  // demo: true marks this apart from a real admin-broadcast order — same
  // KV shape either way, so barter-claim.js needs no changes to read it.
  const order = { id, description, reward: productType, status: 'open', createdAt, demo: true };
  await kv.set(`barterorder:${id}`, order, { ex: BARTERORDER_TTL_SECONDS });

  res.status(200).json({ id, claimUrl: '/barter.html?claim=' + id });
};
