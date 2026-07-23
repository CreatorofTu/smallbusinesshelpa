const { kv } = require('@vercel/kv');

// ============================================================
// sticker-scan.js — public, unauthenticated GET endpoint that resolves what
// a physical, mailed sticker QR code should do when scanned, on ANY device
// — not just the owner's own browser with matching localStorage state.
//
// REAL GAP THIS CLOSES: onboarding.html's handleStickerDeepLink() only ever
// checked its own localStorage (`state.bindings`, `state.done`) — correct
// for the owner completing setup on their own device, but silently wrong
// for everyone else: a customer scanning a bound sticker on their own phone
// has none of that local state and would land on the owner's setup/intro
// screen instead of the real customer review page. This endpoint gives
// onboarding.html a server-side answer instead, so the same physical
// sticker correctly routes an owner (during setup) vs. a customer (after
// binding), on any device.
//
// AUTHORIZATION: intentionally none — same no-login-wall posture as
// qr-questions.js/submit-review.js. This is a read-only lookup keyed by the
// account's own id (public, not a secret) and a sticker number 1-100; it
// never returns anything the physical sticker/QR code itself doesn't
// already imply.
//
// ITEM NAME RESOLUTION: matches api/qr-stickers.js's own convention exactly
// — resolve the CURRENT name from profile.inventory by id, not the
// bindings snapshot taken at bind time, so a customer redirect always
// reflects the owner's current item list, not a stale name.
// ============================================================

const BUSINESS_ID_MAX = 200;

const WINDOW_SECONDS = 60 * 60; // 1 hour
const MAX_SCANS_PER_HOUR = 60; // generous — legit traffic is "a phone scans this sticker," rare per visitor, matches wait-start.js's own limit for the same actor class

function getClientIp(req) {
  // Same last-hop x-forwarded-for convention as every other public endpoint
  // in this codebase (qr-questions.js, submit-review.js, wait-start.js) —
  // the leftmost segment is client-suppliable and not trustworthy.
  const xf = req.headers['x-forwarded-for'];
  if (xf) {
    const hops = String(xf).split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length > 0) return hops[hops.length - 1];
  }
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function registerScan(ip) {
  const key = `stickerscanattempts:${ip}`;
  const n = await kv.incr(key);
  if (n === 1) await kv.expire(key, WINDOW_SECONDS);
  return n;
}

function cleanString(v, cap) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > cap ? s.slice(0, cap) : s;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const ip = getClientIp(req);
    const attemptCount = await registerScan(ip);
    if (attemptCount > MAX_SCANS_PER_HOUR) {
      res.status(429).json({ error: 'Too many scans from this connection — try again later.' });
      return;
    }

    const query = req.query || {};
    const accountId = cleanString(query.business, BUSINESS_ID_MAX);
    const num = Math.floor(Number(query.sticker));

    if (!accountId || !(num >= 1 && num <= 100)) {
      res.status(400).json({ error: 'Missing or malformed business/sticker.' });
      return;
    }

    const profile = await kv.get(`profile:${accountId}`);
    if (!profile) {
      res.status(404).json({ error: 'Unknown business.' });
      return;
    }

    const bindings = (profile.bindings && typeof profile.bindings === 'object' && !Array.isArray(profile.bindings))
      ? profile.bindings
      : {};
    const binding = bindings[String(num)];

    if (!binding || typeof binding.id !== 'string' || !binding.id) {
      res.status(200).json({ ok: true, bound: false });
      return;
    }

    const inventory = Array.isArray(profile.inventory) ? profile.inventory : [];
    const liveItem = inventory.find((row) => row && row.id === binding.id);

    res.status(200).json({
      ok: true,
      bound: true,
      itemId: binding.id,
      itemName: (liveItem && liveItem.name) || binding.name || '',
      orphaned: !liveItem,
    });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
