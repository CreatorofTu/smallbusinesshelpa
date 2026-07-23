const { kv } = require('@vercel/kv');
const { getSessionFromRequest } = require('./_session');

// Account-scoped: one push subscription per account at pushsub:<accountId>
// (re-subscribing overwrites, same as before). Previously kept a single
// global `subscriptions` set of sha256(endpoint)-hashed ids shared across
// every business — that set is preserved in spirit as `pushaccounts` (now a
// set of accountIds instead of endpoint hashes) so send-push.js's existing
// broadcast-to-everyone admin path keeps working without changes to its own
// enumeration logic.
//
// AUTHORIZATION: accountId comes from the caller's signed session cookie
// (see _session.js), never from the request body — previously a client-
// supplied accountId was the only thing checked, so anyone who obtained
// another business's accountId could POST their own push subscription and
// silently hijack that business's notifications.
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
  const accountId = session.accountId;

  const { subscription } = req.body || {};

  if (!subscription || !subscription.endpoint || !subscription.keys) {
    res.status(400).json({ error: 'Invalid subscription payload' });
    return;
  }

  await kv.set(`pushsub:${accountId}`, subscription);
  await kv.sadd('pushaccounts', accountId);

  res.status(201).json({ ok: true });
};
