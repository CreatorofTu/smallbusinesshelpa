const { kv } = require('@vercel/kv');
const { safeCompare } = require('./_safe-compare');

// ============================================================
// admin-grant-access.js — manually grant an account complimentary Full
// access (tier: 'full', paid: true) with NO real Stripe subscription behind
// it, and mark it as a test subject so it's clearly segregated from real
// paying customers everywhere the account list gets read (admin-export.js,
// and anywhere revenue/usage gets reported later).
//
// WHY THIS EXISTS: the founder's own father (Eurowafel) is getting full,
// free access ahead of tomorrow's real handoff — not a paying customer, not
// a Stripe subscription, but should see every Full-tier feature exactly
// like one. Nothing in this codebase's tier-gating (e.g. index.html's
// #upgrade-card, which only checks profile.tier === 'light') requires a
// real Stripe subscription to exist just to BE tier 'full' — this endpoint
// sets that field directly, the same field stripe-webhook.js sets after a
// real payment, just via a manual admin action instead.
//
// ADMIN-GATED, fail-closed: same x-admin-token + safeCompare convention as
// send-push.js/admin-export.js/barter-broadcast.js. This grants real
// product access with zero payment — it must never be reachable by anyone
// who doesn't hold the admin token.
//
// SEGREGATION: sets profile.testSubject = true and profile.complimentary =
// true (distinct flags — testSubject marks "exclude from real usage/
// revenue metrics," complimentary marks "why this account is tier full
// with no Stripe subscription," since a future account could theoretically
// be a real test subject on a real paid tier, or complimentary for a
// reason other than being a test subject). admin-export.js's per-account
// dump already includes the whole profile object, so both flags are
// already visible there with no separate change needed.
//
// LOOKUP BY EMAIL, not accountId: the founder knows his father's email, not
// an opaque accountId — account:<email> (written by auth-signup.js) holds
// {id, email, passwordHash, createdAt}, and .id is the real accountId.
// ============================================================

const TIER_VALUES = ['light', 'full']; // mirrors save-profile.js's own enum

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

  const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
  const tier = TIER_VALUES.indexOf(req.body?.tier) !== -1 ? req.body.tier : 'full';
  const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 200) : 'test subject';

  if (!email) {
    res.status(400).json({ error: 'email is required' });
    return;
  }

  const account = await kv.get(`account:${email}`);
  if (!account || typeof account !== 'object' || !account.id) {
    res.status(404).json({ error: 'No account exists with that email — they need to sign up first.' });
    return;
  }
  const accountId = account.id;

  const profileKey = `profile:${accountId}`;
  const existing = (await kv.get(profileKey)) || {};

  const updated = Object.assign({}, existing, {
    tier: tier,
    paid: true,
    testSubject: true,
    complimentary: true,
    complimentaryReason: reason,
    complimentaryGrantedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });

  await kv.set(profileKey, updated);

  res.status(200).json({
    ok: true,
    accountId: accountId,
    email: email,
    tier: tier,
    testSubject: true,
  });
};
