const { kv } = require('@vercel/kv');
const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const subscription = req.body;
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    res.status(400).json({ error: 'Invalid subscription payload' });
    return;
  }

  const id = crypto.createHash('sha256').update(subscription.endpoint).digest('hex');

  await kv.set(`sub:${id}`, subscription);
  await kv.sadd('subscriptions', id);

  res.status(201).json({ ok: true });
};
