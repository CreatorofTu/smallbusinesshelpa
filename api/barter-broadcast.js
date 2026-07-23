const crypto = require('crypto');
const { kv } = require('@vercel/kv');
const webpush = require('web-push');
const { safeCompare } = require('./_safe-compare');

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// ============================================================
// barter-broadcast.js — creates one Barter reward-claim offer and pushes it
// to every anonymous opt-in subscriber (see api/barter-subscribe.js).
//
// ADMIN-GATED, ON PURPOSE, FOR NOW: this prototype has no per-business
// account/billing wired up yet (see PRODUCT-CONTEXT.md's distribution-
// partnership section) — it's a standalone proof that the reward-claim loop
// works end to end with a real push notification and a real atomic claim,
// not yet a self-serve business feature. Same x-admin-token + safeCompare
// convention as api/send-push.js/api/admin-export.js, fails closed if
// ADMIN_TOKEN is unset.
//
// DESCRIPTION_MAX/REWARD_MAX: this is founder-typed text for a prototype
// broadcast, not customer input — capped anyway on the same "never store an
// unbounded string" instinct as every other text field in this codebase.
// ============================================================

const DESCRIPTION_MAX = 200;
const REWARD_MAX = 100;
const BARTERORDER_TTL_SECONDS = 60 * 60 * 6; // 6 hours — a claim offer this small is stale well before then

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

  const description = typeof req.body?.description === 'string' ? req.body.description.trim().slice(0, DESCRIPTION_MAX) : '';
  const reward = typeof req.body?.reward === 'string' ? req.body.reward.trim().slice(0, REWARD_MAX) : '';
  if (!description || !reward) {
    res.status(400).json({ error: 'description and reward are both required' });
    return;
  }

  const id = crypto.randomUUID();
  const createdAt = new Date().toISOString();
  const order = { id, description, reward, status: 'open', createdAt };
  await kv.set(`barterorder:${id}`, order, { ex: BARTERORDER_TTL_SECONDS });

  const claimUrl = '/barter.html?claim=' + id;
  const payload = JSON.stringify({
    title: 'Free ' + reward + ' — first one there gets it',
    body: description,
    url: claimUrl,
  });

  const subscriberIds = (await kv.smembers('barteraccounts')) || [];
  const results = { orderId: id, notified: 0, removed: 0, failed: 0 };

  await Promise.all(
    subscriberIds.map(async (subId) => {
      const subscription = await kv.get(`bartersub:${subId}`);
      if (!subscription) return;
      try {
        await webpush.sendNotification(subscription, payload);
        results.notified += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await kv.del(`bartersub:${subId}`);
          await kv.srem('barteraccounts', subId);
          results.removed += 1;
        } else {
          results.failed += 1;
        }
      }
    })
  );

  res.status(200).json(results);
};
