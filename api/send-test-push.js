const webpush = require('web-push');

webpush.setVapidDetails(
  process.env.VAPID_SUBJECT,
  process.env.VAPID_PUBLIC_KEY,
  process.env.VAPID_PRIVATE_KEY
);

// Public on purpose: it only ever pushes to the exact subscription object the
// caller already holds (their own device's real, cryptographically-bound
// subscription), never one looked up by id — so it can't be used to message
// anyone else's device. The broadcast/"a directive fired" path lives in
// send-push.js instead, and that one is admin-token gated.
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const { subscription } = req.body || {};
  if (!subscription || !subscription.endpoint || !subscription.keys) {
    res.status(400).json({ error: 'Missing subscription' });
    return;
  }

  const payload = JSON.stringify({
    title: 'Partner Mode',
    body: 'This is a real push, sent from a real server, to this exact device.',
    url: '/',
  });

  try {
    await webpush.sendNotification(subscription, payload);
    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: err.message });
  }
};
