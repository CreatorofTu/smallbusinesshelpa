const { kv } = require('@vercel/kv');
const { getSessionFromRequest } = require('./_session');

// ============================================================
// product-economics.js — per-slot cost/price/margin for the three-slot
// product model (see save-profile.js's THREE-SLOT PRODUCT MODEL header).
//
// The owner logs a bulk ingredient purchase ("$100 of flour made 200
// waffles" -> $0.50/waffle) and what the product actually sells for; this
// endpoint stores both under profile.economics[slot] and serves back the
// computed margin ($ and %) so "invest more in the core product" vs.
// "diversify into secondary/seasonal" becomes a real-numbers comparison
// instead of a gut call.
//
// STORED SHAPE (inside the existing profile:<accountId> record — a new
// top-level `economics` field, sibling of `products`, so one profile read
// serves both this endpoint and generate-directive.js):
//   profile.economics = {
//     main:      { costPerUnit, sellingPrice, lastBulkPurchase: {
//                    amountSpentDollars, unitsYielded, computedAt } },
//     secondary: { ... }, seasonal: { ... }
//   }
// Every slot key and every field inside it is optional — an owner who has
// only ever entered a selling price has { sellingPrice } and nothing else.
// costPerUnit is ALWAYS computed server-side from amountSpentDollars /
// unitsYielded (never trusted from the client — a client-computed
// cost-per-unit could silently disagree with the purchase it claims to come
// from), and lastBulkPurchase keeps the raw inputs it was computed from,
// with a server-assigned computedAt (same never-trust-a-client-timestamp
// posture as save-profile.js's sanitizePayment).
//
// HONESTY RULE, same bar as generate-directive.js's honest-null convention:
// marginDollars/marginPercent are only ever computed when BOTH halves
// (costPerUnit and sellingPrice) really exist for a slot — a margin is
// never fabricated from partial data, on the read side or anywhere else.
//
// AUTHORIZATION: same convention as every other account-scoped endpoint —
// accountId comes from the caller's signed session cookie (_session.js),
// never from the request body/query string. 401 with no valid session.
//
// PRECISION NOTE, named rather than hidden: costPerUnit is the INGREDIENT
// cost of a unit (what the bulk buy divides out to), not full COGS — labor,
// packaging, and overhead aren't tracked anywhere in this app, so the
// margin shown is an ingredient margin. PRODUCT-CONTEXT.md's product-
// economics section says this in as many words; nothing here may present
// the margin as an all-in profit number.
//
// This endpoint deliberately does NOT touch products[slot].recipe or any
// other field of profile.products — it reads products only to check that a
// slot exists (you can't log economics for a product that was never
// onboarded) and writes only profile.economics. The encrypted recipe blobs
// pass through the profile read/merge untouched and are never returned in
// any response here.
// ============================================================

// Fixed slot names — same enum save-profile.js's PRODUCT_SLOTS defines.
// Duplicated rather than imported (save-profile.js only exports its
// handler; this codebase's own convention — see generate-directive.js's
// date helpers — is to duplicate rather than reach into a sibling file's
// internals).
const PRODUCT_SLOTS = ['main', 'secondary', 'seasonal'];

// Ceilings — same "sane ceiling with named reasoning" style as
// save-profile.js's GOAL_TARGET_MAX / INVENTORY_MAX_ITEMS:
// - AMOUNT_SPENT_MAX_DOLLARS: one bulk ingredient order for a single small
//   restaurant/cafe — even a large wholesale flour/coffee order sits well
//   under $5,000; anything above it is far more likely a typo (or abuse)
//   than a real single purchase at this business size.
// - UNITS_YIELDED_MAX: units produced by ONE bulk purchase — 100,000 covers
//   even a per-cup coffee reading of a giant order with room to spare while
//   still bounding what a bad client can make us store and divide by.
// - SELLING_PRICE_MAX_DOLLARS: one menu item's selling price — F&B items
//   sit far below $500 even counting catering-platter-sized outliers.
const AMOUNT_SPENT_MAX_DOLLARS = 5000;
const UNITS_YIELDED_MAX = 100000;
const SELLING_PRICE_MAX_DOLLARS = 500;

// Changelog cap — mirrors save-profile.js's CHANGELOG_MAX (that file's
// constant isn't exported; the two must stay equal so whichever endpoint
// trims last enforces the same ceiling).
const CHANGELOG_MAX = 500;

// Same legacy normalization save-profile.js/generate-directive.js both
// apply: a pre-three-slot profile still holding the singular
// profile.product reads as the main slot, so an account that onboarded
// before the 2026-07-23 build can log economics without re-saving its
// product first.
function normalizedProducts(profile) {
  if (profile.products && typeof profile.products === 'object' && !Array.isArray(profile.products)) {
    return profile.products;
  }
  if (profile.product && typeof profile.product === 'object') {
    return { main: profile.product };
  }
  return {};
}

// Strictly-positive bounded number, or null. Number.isFinite (not a bare
// Number() cast check) so NaN/Infinity/strings never slip through — same
// validation style as save-profile.js's sanitizeGoal.
function positiveNumber(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0 || n > max) return null;
  return n;
}

// Units are a count — floored to a whole number like save-profile.js's
// inventory counts, then re-checked so 0.4 can't floor to 0 and divide by
// zero downstream.
function positiveWholeNumber(v, max) {
  const n = Number(v);
  if (!Number.isFinite(n)) return null;
  const whole = Math.floor(n);
  if (whole < 1 || whole > max) return null;
  return whole;
}

// One slot's response shape — the same object GET returns per slot and
// POST returns for the slot it just saved, so index.html renders both from
// identical code. Every economics number is re-validated on the way out
// (a hand-edited KV value must never surface as NaN margins to the owner).
// label deliberately comes from the slot's own `type` field ("Waffle");
// the main slot falls back to setup.coreProduct — the same preferred-name
// source generate-directive.js's reshapeSlot uses — then to a plain role
// word, so the row is never nameless.
function shapeSlot(role, productSlot, econSlot, setup) {
  if (!productSlot || typeof productSlot !== 'object') return null;
  const label =
    (typeof productSlot.type === 'string' && productSlot.type.trim()) ||
    (role === 'main' && setup && typeof setup.coreProduct === 'string' && setup.coreProduct.trim()) ||
    role + ' product';

  const econ = econSlot && typeof econSlot === 'object' ? econSlot : {};
  const costPerUnit = Number.isFinite(econ.costPerUnit) && econ.costPerUnit > 0 ? econ.costPerUnit : null;
  const sellingPrice = Number.isFinite(econ.sellingPrice) && econ.sellingPrice > 0 ? econ.sellingPrice : null;
  // Margin only when BOTH halves exist — never fabricated from partial
  // data (see the honesty rule in the file header). The sellingPrice > 0
  // guard on marginPercent is belt-and-suspenders: the write path already
  // rejects non-positive prices, but a hand-edited KV value must never
  // produce a divide-by-zero here.
  const marginDollars = costPerUnit !== null && sellingPrice !== null ? sellingPrice - costPerUnit : null;
  const marginPercent = marginDollars !== null && sellingPrice > 0 ? (marginDollars / sellingPrice) * 100 : null;

  const lb = econ.lastBulkPurchase;
  const lastBulkPurchase =
    lb && typeof lb === 'object' && Number.isFinite(lb.amountSpentDollars) && Number.isFinite(lb.unitsYielded)
      ? {
          amountSpentDollars: lb.amountSpentDollars,
          unitsYielded: lb.unitsYielded,
          computedAt: typeof lb.computedAt === 'string' ? lb.computedAt : null,
        }
      : null;

  return {
    label: label,
    costPerUnit: costPerUnit,
    sellingPrice: sellingPrice,
    marginDollars: marginDollars,
    marginPercent: marginPercent,
    lastBulkPurchase: lastBulkPurchase,
  };
}

// ---- changelog helpers — same key scheme + trim behavior as
// save-profile.js's changelog (changelogindex:<accountId> zset +
// changelog:<accountId>:<timestamp>:<field> records; see that file's
// CHANGELOG header comment for the full rationale). slugifyPath/
// capChangelog duplicated rather than imported for the same
// not-exported/no-sibling-internals reason as PRODUCT_SLOTS above. ----
function slugifyPath(path) {
  return String(path).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

async function capChangelog(accountId) {
  const idxKey = `changelogindex:${accountId}`;
  const count = await kv.zcard(idxKey);
  if (!count || count <= CHANGELOG_MAX) return;
  const excess = count - CHANGELOG_MAX;
  const oldest = await kv.zrange(idxKey, 0, excess - 1);
  if (Array.isArray(oldest) && oldest.length > 0) {
    await Promise.all(oldest.map(function (k) { return kv.del(k); }));
  }
  await kv.zremrangebyrank(idxKey, 0, excess - 1);
}

module.exports = async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
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

    const key = `profile:${accountId}`;
    const existing = (await kv.get(key)) || {};
    const products = normalizedProducts(existing);
    const economics =
      existing.economics && typeof existing.economics === 'object' && !Array.isArray(existing.economics)
        ? existing.economics
        : {};

    if (req.method === 'GET') {
      // Every slot key is always present; its value is the shaped
      // economics object when that product slot exists on this account,
      // null when it doesn't — so index.html can tell "no products at all
      // yet" (all three null -> finish-onboarding message) apart from
      // "product exists, no numbers entered yet" (object with null
      // cost/price/margin fields) without a second call.
      res.status(200).json({
        slots: {
          main: shapeSlot('main', products.main, economics.main, existing.setup),
          secondary: shapeSlot('secondary', products.secondary, economics.secondary, existing.setup),
          seasonal: shapeSlot('seasonal', products.seasonal, economics.seasonal, existing.setup),
        },
      });
      return;
    }

    // ---- POST ----
    const body = req.body || {};

    const slot = PRODUCT_SLOTS.indexOf(body.slot) !== -1 ? body.slot : null;
    if (!slot) {
      res.status(400).json({ error: 'Unknown product slot.' });
      return;
    }
    // Checked against the REAL stored profile, never trusted from the
    // client — economics can't be logged for a product that was never
    // onboarded (there'd be nothing real for the numbers to describe, and
    // a directive engine reading them later would be reasoning about a
    // product that doesn't exist).
    if (!products[slot] || typeof products[slot] !== 'object') {
      res.status(400).json({ error: "That product isn't set up yet — add it in onboarding first." });
      return;
    }

    // All three numeric fields are optional INDEPENDENTLY (update just the
    // selling price, or just log a fresh bulk buy) — but a bulk purchase is
    // inherently a pair: an amount with no unit count (or vice versa) can't
    // compute an honest cost-per-unit, so a half-sent pair is rejected
    // outright rather than half-saved or guessed at.
    const hasAmount = body.amountSpentDollars !== undefined;
    const hasUnits = body.unitsYielded !== undefined;
    const hasPrice = body.sellingPriceDollars !== undefined;

    let amountSpent = null;
    let unitsYielded = null;
    let sellingPrice = null;

    if (hasAmount || hasUnits) {
      if (!hasAmount || !hasUnits) {
        res.status(400).json({ error: 'A bulk purchase needs both numbers — what you spent and how many units it made.' });
        return;
      }
      amountSpent = positiveNumber(body.amountSpentDollars, AMOUNT_SPENT_MAX_DOLLARS);
      unitsYielded = positiveWholeNumber(body.unitsYielded, UNITS_YIELDED_MAX);
      if (amountSpent === null) {
        res.status(400).json({ error: 'Amount spent must be between $0 and $' + AMOUNT_SPENT_MAX_DOLLARS + '.' });
        return;
      }
      if (unitsYielded === null) {
        res.status(400).json({ error: 'Units must be a whole number between 1 and ' + UNITS_YIELDED_MAX + '.' });
        return;
      }
    }

    if (hasPrice) {
      sellingPrice = positiveNumber(body.sellingPriceDollars, SELLING_PRICE_MAX_DOLLARS);
      if (sellingPrice === null) {
        res.status(400).json({ error: 'Selling price must be between $0 and $' + SELLING_PRICE_MAX_DOLLARS + '.' });
        return;
      }
    }

    if (amountSpent === null && sellingPrice === null) {
      res.status(400).json({ error: 'Enter a bulk purchase or a selling price first.' });
      return;
    }

    // Merge-preserve, same instinct as save-profile.js's per-slot product
    // handling: whichever of cost/price wasn't part of THIS request keeps
    // its stored value; other slots' economics are untouched entirely.
    const existingSlotEcon = economics[slot] && typeof economics[slot] === 'object' ? economics[slot] : {};
    const updatedSlotEcon = Object.assign({}, existingSlotEcon);

    if (amountSpent !== null) {
      // Computed HERE, from this request's own validated pair — never a
      // client-supplied cost-per-unit (see the file header).
      updatedSlotEcon.costPerUnit = amountSpent / unitsYielded;
      updatedSlotEcon.lastBulkPurchase = {
        amountSpentDollars: amountSpent,
        unitsYielded: unitsYielded,
        computedAt: new Date().toISOString(), // server-assigned, never client-supplied
      };
    }
    if (sellingPrice !== null) {
      updatedSlotEcon.sellingPrice = sellingPrice;
    }

    const profile = Object.assign({}, existing);
    profile.economics = Object.assign({}, economics);
    profile.economics[slot] = updatedSlotEcon;

    // ---- changelog — only when costPerUnit or sellingPrice ACTUALLY
    // changed value. Same diffField convention as save-profile.js,
    // including its "both defined" first-save guard — and that guard is
    // even more load-bearing here than there: the first time an owner
    // enters a price, the price existed in reality all along and only the
    // TRACKING started, so logging undefined -> $4.00 as a "price change"
    // would hand generate-directive.js's variableDiffLog a price change
    // that never actually happened at the business — exactly the spurious
    // causal signal the confidence gate exists to prevent. Plain
    // oldValue/newValue on purpose: these are dollar amounts and unit
    // counts, not proprietary ingredients — nothing recipe-grade to
    // encrypt (and nothing here touches the recipe encryption path at
    // all). ----
    const changeEntries = [];
    function diffField(path, field, oldValue, newValue) {
      if (oldValue === undefined || newValue === undefined) return;
      if (oldValue === newValue) return;
      changeEntries.push({ path: path, field: field, oldValue: oldValue, newValue: newValue });
    }
    diffField('economics.' + slot + '.costPerUnit', 'costPerUnit', existingSlotEcon.costPerUnit, updatedSlotEcon.costPerUnit);
    diffField('economics.' + slot + '.sellingPrice', 'sellingPrice', existingSlotEcon.sellingPrice, updatedSlotEcon.sellingPrice);

    if (changeEntries.length > 0) {
      const changeTimestamp = Date.now(); // server-assigned, never client-supplied
      const changedAt = new Date(changeTimestamp).toISOString();
      const changeDate = changedAt.slice(0, 10);
      const indexKey = `changelogindex:${accountId}`;

      const pipeline = kv.multi();
      changeEntries.forEach(function (entry) {
        const recordKey = `changelog:${accountId}:${changeTimestamp}:${slugifyPath(entry.path)}`;
        pipeline.set(recordKey, {
          date: changeDate,
          path: entry.path,
          field: entry.field,
          oldValue: entry.oldValue,
          newValue: entry.newValue,
          changedAt: changedAt,
        });
        pipeline.zadd(indexKey, { score: changeTimestamp, member: recordKey });
      });
      await pipeline.exec();

      // Best-effort cap — never let a trim failure block a real save
      // (same posture as save-profile.js's identical call).
      await capChangelog(accountId).catch(function () {});
    }

    profile.updatedAt = new Date().toISOString();
    await kv.set(key, profile);

    // Return the freshly-shaped slot so index.html can update the row's
    // numbers (including the newly-computed margin) without a second
    // round trip.
    res.status(200).json({
      ok: true,
      slot: shapeSlot(slot, products[slot], updatedSlotEcon, existing.setup),
    });
  } catch (err) {
    // Same deliberate stricter error-handling convention as log-entry.js /
    // log-summary.js / save-profile.js — generic 500, no internal detail
    // leaked to the client.
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
