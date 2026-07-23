const { kv } = require('@vercel/kv');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { safeCompare } = require('./_safe-compare');

// ============================================================
// ONE-TIME MIGRATION TOOL — not called by any page, run manually by the
// founder once, after this deploy, via e.g.:
//
//   curl -X POST https://<your-deploy>/api/migrate-legacy-data \
//     -H "x-admin-token: <ADMIN_TOKEN>" \
//     -H "Content-Type: application/json" \
//     -d '{"email":"REPLACE-ME@example.com","password":"REPLACE-ME-6-CHARS-MIN"}'
//
// It creates a real account for the existing pilot business (the founder's
// father's shop — the one real data currently sitting under the old global
// keys: businessProfile, logentry:<date>, logdates, sub:*/subscriptions),
// and copies that data into the new account-scoped keys.
//
// NON-DESTRUCTIVE ON PURPOSE: nothing is deleted from the old global keys.
// This only ever writes new, additively-namespaced keys — safe to run more
// than once (idempotent: re-running reuses the same account if the email
// already has one, and re-copies the same log dates without duplicating).
// Verify the migrated data looks right in the app before manually clearing
// the old global keys yourself, if you ever want to.
// ============================================================

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const BCRYPT_COST = 11;

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
    const { email, password } = req.body || {};

    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      res.status(400).json({ error: 'Pass a real email for this pilot account in the request body: { "email": "...", "password": "..." }' });
      return;
    }
    if (typeof password !== 'string' || password.length < 6) {
      res.status(400).json({ error: 'Pass a password (>= 6 chars) for this pilot account in the request body.' });
      return;
    }

    const emailKey = email.trim().toLowerCase();
    const accountKey = `account:${emailKey}`;

    let account = await kv.get(accountKey);
    let createdAccount = false;
    if (!account) {
      const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
      account = {
        id: crypto.randomUUID(),
        email: emailKey,
        passwordHash,
        createdAt: new Date().toISOString(),
      };
      await kv.set(accountKey, account);
      createdAccount = true;
    }
    const accountId = account.id;

    // ---- 1. Legacy businessProfile -> profile:<accountId> ----
    // Best-effort only: the OLD businessProfile schema (businessType/
    // products[]/environment{hours,price}) predates the pivot and never
    // matched onboarding.html's real fields — PRODUCT-CONTEXT.md confirms
    // nothing ever read this back, so this is a courtesy copy, not a
    // guaranteed-faithful migration. Skipped if profile:<accountId> already
    // has a real setup (don't clobber a real onboarding that already ran
    // under this account).
    let hadLegacyProfile = false;
    const legacyProfile = await kv.get('businessProfile');
    if (legacyProfile) {
      hadLegacyProfile = true;
      const existingProfile = (await kv.get(`profile:${accountId}`)) || {};
      if (!existingProfile.setup) {
        const firstProduct = Array.isArray(legacyProfile.products) && legacyProfile.products[0]
          ? legacyProfile.products[0].name
          : '';
        await kv.set(`profile:${accountId}`, Object.assign({}, existingProfile, {
          setup: {
            businessName: '',
            ownerName: '',
            address: '',
            coreProduct: firstProduct || '',
          },
          legacyMigratedAt: new Date().toISOString(),
          legacyNote: 'Best-effort copy from the old pre-pivot businessProfile schema — verify/re-enter in onboarding.',
        }));
      }
    }

    // ---- 2. Legacy daily logs -> logentry:<accountId>:<date> / logdates:<accountId> ----
    const legacyDates = (await kv.zrange('logdates', 0, -1)) || [];
    let migratedDates = 0;
    for (const date of legacyDates) {
      const entry = await kv.get(`logentry:${date}`);
      if (!entry) continue;
      const pipeline = kv.multi();
      pipeline.set(`logentry:${accountId}:${date}`, entry);
      pipeline.zadd(`logdates:${accountId}`, { score: Number(String(date).replace(/-/g, '')), member: date });
      await pipeline.exec();
      migratedDates += 1;
    }

    // ---- 3. Legacy push subscription -> pushsub:<accountId> / pushaccounts ----
    let hadPushSubscription = false;
    const legacyIds = (await kv.smembers('subscriptions')) || [];
    if (legacyIds.length > 0) {
      const firstSub = await kv.get(`sub:${legacyIds[0]}`);
      if (firstSub) {
        hadPushSubscription = true;
        await kv.set(`pushsub:${accountId}`, firstSub);
        await kv.sadd('pushaccounts', accountId);
      }
    }

    res.status(200).json({
      ok: true,
      accountId,
      email: emailKey,
      accountCreated: createdAccount,
      hadLegacyProfile,
      migratedDates,
      hadPushSubscription,
      note: 'Old global keys (businessProfile, logentry:<date>, logdates, sub:*, subscriptions) were left in place, untouched — nothing was deleted.',
    });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.', detail: err.message });
  }
};
