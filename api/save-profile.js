const { kv } = require('@vercel/kv');
const { getSessionFromRequest } = require('./_session');

// Account-scoped onboarding profile store. Key: profile:<accountId>.
//
// AUTHORIZATION: accountId comes from the caller's signed session cookie
// (see _session.js), never from the request body — previously a client-
// supplied accountId was the only thing checked, so anyone who obtained
// another business's accountId could overwrite that business's profile.
//
// This replaces the old single global `businessProfile` key (whole-app-shared,
// stale pre-pivot schema — businessType/products[]/environment — that nothing
// ever read back). It now matches onboarding.html's real, live schema:
// setup (businessName/ownerName/address/coreProduct), inventory (item list),
// bindings (sticker -> item), product (type/temp/toppings/extras — the
// recipe field is EXCLUDED on purpose, matching onboarding.html's own
// on-screen promise that the recipe "stays between you and the ai, NEVER US"
// — never add it to this endpoint's accepted fields), and schedule (7-day
// hours).
//
// Consolidates what used to be six separate not-yet-built endpoint stubs
// (onboarding-setup / -payment / -inventory / -sticker / -schedule
// -complete) into one real, merge/upsert endpoint — onboarding.html's own
// API seam called each of those at a different step; this endpoint accepts
// whichever top-level section(s) a given call sends and merges them into the
// account's stored profile, so every one of those call sites keeps working
// without needing six separate real files.

const STRING_CAP = 200;
const DAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

function cleanString(v, cap) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > (cap || STRING_CAP) ? s.slice(0, cap || STRING_CAP) : s;
}

function sanitizeSetup(raw) {
  if (!raw || typeof raw !== 'object') return null;
  return {
    businessName: cleanString(raw.businessName),
    ownerName: cleanString(raw.ownerName),
    address: cleanString(raw.address),
    coreProduct: cleanString(raw.coreProduct),
  };
}

function sanitizeInventory(raw) {
  if (!Array.isArray(raw)) return null;
  return raw
    .slice(0, 500) // hard cap — this is a walk-around list, not unbounded input
    .map(function (row) {
      const id = cleanString(row && row.id, 100);
      const name = cleanString(row && row.name, 100);
      const count = Number(row && row.count);
      return {
        id: id || null,
        name: name,
        count: Number.isFinite(count) && count >= 0 ? Math.floor(count) : 0,
      };
    })
    .filter(function (row) { return row.id && row.name; });
}

function sanitizeBindingEntry(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const id = cleanString(entry.id, 100);
  const name = cleanString(entry.name, 100);
  if (!id || !name) return null;
  return { id: id, name: name };
}

function sanitizeProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const temp = raw.temp === 'Hot' || raw.temp === 'Cold' ? raw.temp : '';
  // recipe is intentionally never read from `raw` here — see file header.
  return {
    type: cleanString(raw.type, 200),
    temp: temp,
    toppings: cleanString(raw.toppings, 400),
    extras: cleanString(raw.extras, 400),
  };
}

function sanitizeSchedule(raw) {
  if (!Array.isArray(raw) || raw.length !== 7) return null;
  const cleaned = raw.map(function (row) {
    const day = DAYS.indexOf(row && row.day) !== -1 ? row.day : null;
    const open = row && row.open === true;
    const start = TIME_RE.test(row && row.start) ? row.start : '09:00';
    const end = TIME_RE.test(row && row.end) ? row.end : '17:00';
    return day ? { day: day, open: open, start: start, end: end } : null;
  });
  return cleaned.every(Boolean) ? cleaned : null;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const session = getSessionFromRequest(req);
    if (!session) {
      res.status(401).json({ error: 'Not logged in' });
      return;
    }
    const accountId = session.accountId;

    const body = req.body || {};

    const key = `profile:${accountId}`;
    const existing = (await kv.get(key)) || {};
    const profile = Object.assign({}, existing);

    if (body.setup !== undefined) {
      const setup = sanitizeSetup(body.setup);
      if (setup) profile.setup = Object.assign({}, profile.setup, setup);
    }

    if (typeof body.deliveryAddress === 'string') {
      profile.deliveryAddress = cleanString(body.deliveryAddress);
    }

    if (body.inventory !== undefined) {
      const inventory = sanitizeInventory(body.inventory);
      if (inventory) profile.inventory = inventory;
    }

    // Single sticker binding update (the common case — one scan at a time).
    if (body.stickerBinding && typeof body.stickerBinding === 'object') {
      const num = Math.floor(Number(body.stickerBinding.sticker));
      const entry = sanitizeBindingEntry({ id: body.stickerBinding.itemId, name: body.stickerBinding.itemName });
      if (num >= 1 && num <= 100 && entry) {
        profile.bindings = profile.bindings && typeof profile.bindings === 'object' ? profile.bindings : {};
        profile.bindings[String(num)] = entry;
      }
    }

    // Full bindings replace (supported for completeness — not used by any
    // current onboarding.html call site, which sends single bindings above).
    if (body.bindings && typeof body.bindings === 'object' && !Array.isArray(body.bindings)) {
      const cleanBindings = {};
      for (const k in body.bindings) {
        const num = Math.floor(Number(k));
        const entry = sanitizeBindingEntry(body.bindings[k]);
        if (num >= 1 && num <= 100 && entry) cleanBindings[String(num)] = entry;
      }
      profile.bindings = cleanBindings;
    }

    if (body.product !== undefined) {
      const product = sanitizeProduct(body.product);
      if (product) profile.product = Object.assign({}, profile.product, product);
    }

    if (body.schedule !== undefined) {
      const schedule = sanitizeSchedule(body.schedule);
      if (schedule) profile.schedule = schedule;
    }

    if (body.completed === true) {
      profile.completed = true;
      profile.completedAt = new Date().toISOString();
      if (Number.isFinite(body.stickerCount)) {
        profile.stickerCount = Math.floor(body.stickerCount);
      }
    }

    profile.updatedAt = new Date().toISOString();

    await kv.set(key, profile);

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
