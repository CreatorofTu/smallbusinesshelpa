const { kv } = require('@vercel/kv');

// ============================================================
// barter-claim.js — public read + atomic first-claim-wins for one Barter
// reward-claim offer (see api/barter-broadcast.js for how an offer is
// created and pushed out).
//
// ATOMICITY IS THE WHOLE POINT: "only one person is going to get it" is the
// founder's own design for this mechanic — a race between however many
// people tap the push notification at once, with exactly one winner. This
// uses Redis's SET-if-not-exists (kv.set(key, value, { nx: true })) as the
// actual atomic decision — whichever request's NX-set succeeds is the real,
// server-enforced winner; every other concurrent request's NX-set is a
// no-op and gets told "already claimed." A naive "read status, then write
// status" (two separate calls) would have a real race window between the
// read and the write; NX-set has none, because the check and the write are
// the same atomic operation.
//
// NO LOGIN ANYWHERE ON THIS ENDPOINT — same posture as the rest of the
// Barter prototype: whoever taps the link claims it, no account needed. The
// order id itself (a crypto.randomUUID() from barter-broadcast.js) is the
// only thing standing in for a credential, same shape as a one-time coupon
// code — reasonable at this small, prototype scale.
// ============================================================

const ID_RE = /^[0-9a-fA-F-]{36}$/; // crypto.randomUUID()'s exact shape

module.exports = async function handler(req, res) {
  const id = typeof req.query?.id === 'string' ? req.query.id : (req.body && req.body.id);
  if (typeof id !== 'string' || !ID_RE.test(id)) {
    res.status(400).json({ error: 'Missing or malformed order id' });
    return;
  }

  const orderKey = `barterorder:${id}`;

  if (req.method === 'GET') {
    const order = await kv.get(orderKey);
    if (!order) {
      res.status(404).json({ error: 'This offer is gone — it may have expired or already been claimed a while ago.' });
      return;
    }
    res.status(200).json({ order });
    return;
  }

  if (req.method === 'POST') {
    const order = await kv.get(orderKey);
    if (!order) {
      res.status(404).json({ error: 'This offer is gone — it may have expired.' });
      return;
    }

    // THE atomic decision. claimedKey has no TTL shorter than the order's
    // own (matches barterorder's 6h expiry via a mirrored kv.expire call
    // below) — an NX-set against a key that might not exist yet is exactly
    // "first writer wins."
    const claimedKey = `barterorder:${id}:claimed`;
    const won = await kv.set(claimedKey, { claimedAt: new Date().toISOString() }, { nx: true });
    await kv.expire(claimedKey, 60 * 60 * 6).catch(function () {});

    if (!won) {
      res.status(200).json({ ok: false, status: 'already-claimed', message: 'Someone already claimed this — better luck next time.' });
      return;
    }

    const updated = Object.assign({}, order, { status: 'claimed' });
    await kv.set(orderKey, updated);
    res.status(200).json({ ok: true, status: 'claimed', order: updated, message: 'You got it — go pick it up.' });
    return;
  }

  res.status(405).json({ error: 'Method not allowed' });
};
