const { kv } = require('@vercel/kv');
const webpush = require('web-push');

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// The real "a directive fired" path — broadcasts to every stored subscription.
// Gated behind ADMIN_TOKEN so this can't be used as an open notification
// blaster by anyone who finds the URL. Call it later from wherever the real
// trigger logic ends up living, passing the token as `x-admin-token`.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const token = req.headers['x-admin-token'];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    res.status(401).json({ error: 'Unauthorized' });
    return;
  }

  const { title, body, url } = req.body || {};
  const payload = JSON.stringify({
    title: title || 'Justaddegg',
    body: body || 'Something changed — take a look.',
    url: url || '/',
  });

  const ids = (await kv.smembers('subscriptions')) || [];
  const results = { sent: 0, removed: 0, failed: 0 };

  await Promise.all(
    ids.map(async (id) => {
      const subscription = await kv.get(`sub:${id}`);
      if (!subscription) return;
      try {
        await webpush.sendNotification(subscription, payload);
        results.sent += 1;
      } catch (err) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await kv.del(`sub:${id}`);
          await kv.srem('subscriptions', id);
          results.removed += 1;
        } else {
          results.failed += 1;
        }
      }
    })
  );

  res.status(200).json(results);
};
