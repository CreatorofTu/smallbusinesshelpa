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
// — never add it to this endpoint's accepted fields), schedule (7-day
// hours), and payments (append-only $20 onboarding-charge confirmation log —
// see sanitizePayment below).
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
const INVENTORY_MAX_ITEMS = 200; // sane ceiling for a single small restaurant's item list
const BINDINGS_MAX_KEYS = 200; // hard cap on client-supplied key count, checked before we loop
const GOAL_TARGET_MAX = 100000; // sane ceiling for a small business's daily customer/sales count

// PAYMENT (new, additive field). Replaces the old /api/onboarding-payment
// stub, which never existed as a real file — onboarding.html's
// API.recordPayment() posted to it and got a real 404 every time, silently
// swallowed by its own try/catch, so there was zero server-side record of
// which businesses actually confirmed the $20 "ai infrastructure package"
// charge. Folded in here rather than as a standalone file so it inherits
// this endpoint's real session-cookie auth for free instead of duplicating
// it. amount/mode are both server-validated against fixed allow-lists below
// — never trust either as free-form client input — and every confirmation
// is appended to an array (never overwritten) so the record stays a real
// audit trail even if the client confirms more than once.
const PAYMENT_MODES = ['payment-link', 'test-mode'];
const PAYMENT_AMOUNT = 20; // must match the live $20 charge shown in onboarding.html's Step 1 button
const PAYMENTS_MAX = 20; // sane ceiling — this is a one-time onboarding charge, not a ledger
// Inventory item IDs and sticker-binding item IDs are stored inside KV keys
// elsewhere in this app (KV keys use ':' as a segment delimiter, e.g.
// profile:<accountId>) — restrict to a safe charset so a ':' or other
// delimiter-ish character can never get embedded in a stored ID and later
// break KV key parsing downstream.
const ID_RE = /^[A-Za-z0-9_-]+$/;

function cleanString(v, cap) {
  if (typeof v !== 'string') return '';
  const s = v.trim();
  return s.length > (cap || STRING_CAP) ? s.slice(0, cap || STRING_CAP) : s;
}

function sanitizeId(v, cap) {
  const s = cleanString(v, cap || 100);
  return s && ID_RE.test(s) ? s : '';
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
    .slice(0, INVENTORY_MAX_ITEMS) // hard cap — this is a walk-around list, not unbounded input
    .map(function (row) {
      const id = sanitizeId(row && row.id, 100);
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
  const id = sanitizeId(entry.id, 100);
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

// GOAL MODE (new, additive field — see api/generate-goal-questions.js).
// "Here's your baseline, not set a vision" per the founder's own framing:
// a goal is always a metric + a target number set alongside a real, already-
// computed baseline the owner actually sees first — never an invented
// vision captured with no reference point. Overwritten wholesale on every
// set (no history of past goals kept — same "today only" simplicity this
// file already uses for schedule/product).
const GOAL_METRICS = ['customers', 'sales'];
function sanitizeGoal(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const metric = GOAL_METRICS.indexOf(raw.metric) !== -1 ? raw.metric : null;
  const target = Number(raw.target);
  if (!metric || !Number.isFinite(target) || target < 0 || target > GOAL_TARGET_MAX) return null;
  return { metric: metric, target: target, setAt: new Date().toISOString() };
}

function sanitizePayment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = PAYMENT_MODES.indexOf(raw.mode) !== -1 ? raw.mode : null;
  if (!mode) return null;
  // amount is never trusted from the client — always the fixed real price,
  // server-assigned, exactly like the timestamp below.
  return { amount: PAYMENT_AMOUNT, mode: mode, confirmedAt: new Date().toISOString() };
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
      // Hard cap on client-supplied key count, checked before we loop — this
      // object is client-controlled and otherwise unbounded before filtering.
      const bindingKeys = Object.keys(body.bindings).slice(0, BINDINGS_MAX_KEYS);
      for (const k of bindingKeys) {
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

    if (body.goal !== undefined) {
      const goal = sanitizeGoal(body.goal);
      if (goal) profile.goal = goal;
    }

    if (body.payment !== undefined) {
      const payment = sanitizePayment(body.payment);
      if (payment) {
        profile.payments = Array.isArray(profile.payments) ? profile.payments : [];
        profile.payments.push(payment);
        if (profile.payments.length > PAYMENTS_MAX) {
          profile.payments = profile.payments.slice(profile.payments.length - PAYMENTS_MAX);
        }
        profile.paid = true;
      }
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
