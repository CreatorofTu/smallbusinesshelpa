const { kv } = require('@vercel/kv');
const { getSessionFromRequest } = require('./_session');
const { encryptRecipeText, decryptRecipeText } = require('./_recipe-crypto');

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
// bindings (sticker -> item), products (THREE-SLOT MODEL, 2026-07-23 — see
// the note below; each slot is type/temp/toppings/extras plus recipe, see
// the REVERSAL note below), schedule (7-day hours), and payments
// (append-only onboarding-charge confirmation log — see sanitizePayment
// below).
//
// THREE-SLOT PRODUCT MODEL (2026-07-23) — profile.product (singular) became
// profile.products = { main, secondary, seasonal }. The founder's own slot
// definitions: MAIN is "the actual core, what the shop is known for"
// (required — this is the old single product, relocated); SECONDARY is
// "usually accompanied in the shop along with other products, like a coffee
// or a drink, matcha tea" (optional, part of normal baseline reasoning
// exactly like main — no seasonal weighting); SEASONAL is optional and
// carries a `season` (allow-listed, SEASON_VALUES below), in his words:
// "Seasonal products will be popular and a part of the baseline during the
// seasonal pushes. We want to make sure they are not a part of the baseline
// when they are not a part of that season, because then it will drop the
// baseline. Maybe we can make it so seasonal is an actual input that is
// weighted differently based off of the expected time." IMPORTANT HONESTY
// NOTE on what that last sentence can actually mean with today's data: this
// app logs exactly ONE combined daily {customers, sales} pair for the whole
// business (log-entry.js) — there is no per-product sales number anywhere,
// so nothing here mathematically excludes or subtracts a seasonal product
// from any baseline. What shipped instead: generate-directive.js feeds the
// reasoning prompt explicit seasonal CONTEXT (current season, whether the
// seasonal product is in-season) so the model can weigh a season-boundary
// swing as a plausible explanation — interpretive context only, the same
// "never law, just context" posture as profile.ownerContext. This is a
// completion of intent already gestured at, not a pivot:
// generate-directive.js has always shaped this data as a coreProducts ARRAY
// (with one entry), and PRODUCT-CONTEXT.md's architecture section always
// said "core-products/<name>.json — one file per recipe/product actually
// sold" (plural).
//
// Legacy compatibility, both directions: an old stored profile with the
// singular profile.product is READ as the main slot (see existingProducts
// in the handler), and an old cached client still POSTing body.product
// (singular) is routed into the main slot — so neither an existing account
// nor a stale page ever silently loses its product data. On the first
// products write, the legacy singular field is deleted so profile.products
// is the single source of truth going forward.
//
// RECIPE REVERSAL (2026-07-23) — this endpoint used to EXCLUDE the recipe
// field on purpose, matching onboarding.html's own on-screen promise that
// the recipe "stays between you and the ai, NEVER US"; a hard "never add it
// to this endpoint's accepted fields" rule stood here. The founder reversed
// that deliberately, in his own words: "then switch it, its their ai
// manager if its needed to work some lines need to be crossed but
// acknowledge and protected and showed proof of protection." The old
// exclusion was the only reason the flagship recipe-level directive
// ("removing the brown sugar cost you 4 customers") could never fire on
// real data. The reversal ships with real protection, not a quiet flip:
// recipe text is encrypted at rest via api/_recipe-crypto.js (AES-256-GCM,
// key server-side only in RECIPE_ENCRYPTION_KEY) before it ever touches KV,
// its changelog entries store an ENCRYPTED line-diff (never plaintext
// before/after — see the recipe-diff block in the handler), and
// onboarding.html/privacy.html's copy was rewritten in the same pass so the
// promise shown to owners matches what the code actually does.
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
// Recipe gets its own cap, bigger than STRING_CAP: recipes are entered "one
// ingredient per line" (onboarding.html's own placeholder), so this isn't a
// name-sized field — 4000 chars is generous for even a long ingredient list
// (dozens of lines with room to spare) while still bounding what a bad or
// malicious client can make us encrypt and store.
const RECIPE_MAX_LENGTH = 4000;
const BINDINGS_MAX_KEYS = 200; // hard cap on client-supplied key count, checked before we loop
const GOAL_TARGET_MAX = 100000; // sane ceiling for a small business's daily customer/sales count
const STOCK_MAX = 10000; // sane ceiling for "how many of this item could you make right now" at one small business

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
// TIER (new): the "save money" vs. "get the most out of it" fork onboarding.html
// asks right before opening a payment link. amount is keyed by tier and never
// trusted from the client, same posture as the old single PAYMENT_AMOUNT this
// replaces — server always assigns the real price for whichever tier was
// actually chosen, matching whatever payment link onboarding.html opened.
const TIER_VALUES = ['light', 'full'];
const PAYMENT_AMOUNTS = { light: 20, full: 100 };
const PAYMENTS_MAX = 20; // sane ceiling — this is a one-time onboarding charge, not a ledger
// VISION (new): the "what are you actually trying to achieve" question
// onboarding.html asks right before the tier fork. Stored as-is, an
// allow-listed enum like TIER_VALUES above — no free text accepted.
const VISION_VALUES = ['retirement', 'franchise'];

// PRODUCTS — three-slot model (2026-07-23, see the file header). The slot
// names are fixed, never client-invented, and the seasonal slot's `season`
// is an allow-listed enum exactly like TIER_VALUES/VISION_VALUES above —
// never free text. Quarterly mapping (resolved from the founder's own
// "the season changes every three months" / summer-roughly-June-August
// framing): winter = Dec-Feb, spring = Mar-May, summer = Jun-Aug,
// fall = Sep-Nov. generate-directive.js's getCurrentSeason() must always
// use this same mapping.
const PRODUCT_SLOTS = ['main', 'secondary', 'seasonal'];
const SEASON_VALUES = ['winter', 'spring', 'summer', 'fall'];

// OWNER CONTEXT (new, additive array field). "Never law, just context" —
// free-form background notes the owner adds about their own business during
// the pre-baseline period (invited by cron-baseline-context.js's day 1/4/7
// touchpoints, collected by index.html's ?context=1 screen). Appended (never
// overwritten) exactly like profile.payments above, capped at
// OWNER_CONTEXT_MAX entries with the oldest trimmed first. Read back by
// generate-directive.js's reasoning prompt as color only — never as evidence
// for a causal claim, the identical reasoning already applied there to
// excluding goal.metric/goal.target from variableDiffLog.
const OWNER_CONTEXT_STRING_CAP = 1000;
const OWNER_CONTEXT_MAX = 20;

// CHANGELOG (new, additive). Real change-log write path — previously
// generate-directive.js's variableDiffLog was permanently `[]` because
// nothing anywhere recorded a change; this closes that gap. Only the
// fields the founder named as real business decisions are tracked here:
// setup identity fields, each product slot's type/temp/toppings/extras
// plus the seasonal slot's season (paths products.main.type,
// products.secondary.toppings, products.seasonal.season, etc. — the
// three-slot extension of what used to be product.type etc.; pre-3-slot
// records with the old singular product.* paths remain in the log as-is
// and generate-directive.js still reads both), each slot's recipe
// (SINCE 2026-07-23 — previously "never, full stop" per the old privacy
// promise; see the RECIPE REVERSAL note in this file's header. Recipe
// changes are logged as an ENCRYPTED line-diff, never as plaintext
// oldValue/newValue — see the per-slot recipe-diff pass in the handler,
// changelog paths products.main.recipe / products.secondary.recipe /
// products.seasonal.recipe), the 7-day
// schedule (per-day open/start/end), and goal.metric/goal.target. Follows
// this codebase's own established index+record pattern (see
// submit-review.js's qrcommentindex:<accountId>/qrcomment:<accountId>:
// <itemKey>:<timestamp>): a changelogindex:<accountId> zset (score =
// timestamp ms) plus individual changelog:<accountId>:<timestamp>:<field>
// records — the trailing :<field> slug is needed (unlike qrcomment's
// itemKey-based key) because more than one field can change in the same
// request and would otherwise collide on the exact same millisecond.
// Capped the same way this file already caps other lists (PAYMENTS_MAX
// above) — a sane ceiling, oldest trimmed first, so this can never grow
// unbounded even for a business that edits constantly. At small-business
// scale (a handful of real edits a week, if that) 500 entries is years of
// history, not a tight limit.
const CHANGELOG_MAX = 500;
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

// Per-slot product validator — reused unchanged for all three slots of the
// products model (main/secondary/seasonal; see the file header). The
// seasonal slot's extra `season` field is validated separately at the
// handler's products block, against SEASON_VALUES, because it only exists
// on that one slot.
function sanitizeProduct(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const temp = raw.temp === 'Hot' || raw.temp === 'Cold' ? raw.temp : '';
  // Same never-trust-client-shape posture as sanitizeInventory's count:
  // Number() + Number.isFinite() so NaN/Infinity/strings never slip
  // through, floored to a whole count, bounded by STOCK_MAX. Empty/absent
  // input (the field is optional) yields null, not 0 — "didn't say" should
  // never look the same as "zero in stock."
  const stockNum = Number(raw.currentStock);
  const currentStock = raw.currentStock !== '' && Number.isFinite(stockNum) && stockNum >= 0 && stockNum <= STOCK_MAX
    ? Math.floor(stockNum)
    : null;
  // recipe is deliberately NOT handled here even though it's accepted now
  // (see the RECIPE REVERSAL note in the file header): this function's
  // output is plaintext-merged into the slot's stored object, and the
  // recipe must never be stored as plaintext. Each slot has its own
  // encrypt-before-store pass in the handler instead — keeping it out of
  // this merge also means a product save that omits recipe leaves the
  // slot's existing encrypted recipe untouched, exactly like every other
  // merge-preserved field.
  return {
    type: cleanString(raw.type, 200),
    temp: temp,
    toppings: cleanString(raw.toppings, 400),
    extras: cleanString(raw.extras, 400),
    currentStock: currentStock,
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

// ---- changelog helpers ----

// Turns a dotted path like "schedule.Monday.start" into a safe KV-key
// segment ("schedule-monday-start") — same charset-restriction instinct as
// ID_RE above, applied here to a path we build ourselves (not client input)
// purely so the resulting key is predictable and never contains a ':' that
// could confuse downstream key-parsing.
function slugifyPath(path) {
  return String(path).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

// Line-based recipe diff — recipes are entered "one ingredient per line"
// (onboarding.html's own placeholder), so a line diff IS an ingredient
// diff, which is exactly the granularity the directive engine's flagship
// example reasons at ("removing the brown sugar..."). Lines are trimmed and
// compared case-insensitively so "Brown Sugar" -> "brown sugar" or a
// reordered list never gets logged as a fake ingredient change. Returns
// { added: [...], removed: [...] } or null when nothing real changed.
// The RETURNED PLAINTEXT NEVER TOUCHES KV DIRECTLY — the caller encrypts
// the whole diff object via encryptRecipeText before storing it (storing a
// plaintext ingredient diff would leak the most identifying parts of the
// recipe and defeat the point of encrypting the field itself).
function computeRecipeLineDiff(oldText, newText) {
  function lines(text) {
    return String(text).split('\n').map(function (s) { return s.trim(); }).filter(Boolean);
  }
  const oldLines = lines(oldText);
  const newLines = lines(newText);
  const oldSet = new Set(oldLines.map(function (s) { return s.toLowerCase(); }));
  const newSet = new Set(newLines.map(function (s) { return s.toLowerCase(); }));
  const added = newLines.filter(function (s) { return !oldSet.has(s.toLowerCase()); });
  const removed = oldLines.filter(function (s) { return !newSet.has(s.toLowerCase()); });
  if (added.length === 0 && removed.length === 0) return null;
  return { added: added, removed: removed };
}

function scheduleByDay(schedule) {
  const map = {};
  if (Array.isArray(schedule)) {
    schedule.forEach(function (row) {
      if (row && row.day) map[row.day] = row;
    });
  }
  return map;
}

// Best-effort trim, oldest first — mirrors PAYMENTS_MAX's "keep only the
// newest N" behavior but for a zset-indexed key set instead of a plain
// array field. Deletes the actual changelog:* records being dropped too
// (not just their index entries) so nothing orphaned is left behind in KV.
// Never allowed to fail the request it's called from — a capping failure
// should never cost a founder their real profile save.
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

function sanitizePayment(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const mode = PAYMENT_MODES.indexOf(raw.mode) !== -1 ? raw.mode : null;
  const tier = TIER_VALUES.indexOf(raw.tier) !== -1 ? raw.tier : null;
  if (!mode || !tier) return null;
  // amount is never trusted from the client — always the fixed real price
  // for whichever tier was chosen, server-assigned, exactly like the
  // timestamp below.
  return { amount: PAYMENT_AMOUNTS[tier], tier: tier, mode: mode, confirmedAt: new Date().toISOString() };
}

// ============================================================
// GET — restores an in-progress onboarding after local data is lost.
//
// REAL BUG THIS CLOSES (2026-07-23): onboarding.html's own progress lives in
// localStorage (see its saveState()/loadState()) and gets written to the
// server progressively as each step completes — but nothing ever read that
// server data BACK. A LOGIN to an incomplete account always restarted at
// screen-setup with blank fields, even though everything already saved
// server-side was sitting right there — iOS's own well-documented habit of
// clearing localStorage for installed home-screen web apps made this a real,
// reproducible loss, not just a theoretical one. This endpoint is the fix:
// onboarding.html's login handler now calls it and repopulates its local
// state from the real, already-saved server data before resuming.
//
// RECIPE TEXT IS DELIBERATELY NEVER RETURNED HERE, even encrypted — this is
// a read path reachable right after login, and decrypting recipe text just
// for onboarding-resume convenience would mean importing the recipe
// decryption capability into a broader surface than it needs to reach (see
// api/_recipe-crypto.js's whole reason for existing: recipe plaintext exists
// in memory ONLY inside generate-directive.js/save-profile.js's own write
// path, nowhere else). hasRecipe (a boolean, per slot) is returned instead,
// so the client can show "you already saved a recipe here" without ever
// touching the ciphertext. Losing a typed-but-unsaved recipe on a data-wipe
// is a real, smaller residual gap, not exhaustively closed by this endpoint.
// ============================================================
function shapeProfileForResume(profile) {
  const products = profile.products && typeof profile.products === 'object' && !Array.isArray(profile.products)
    ? profile.products
    : profile.product && typeof profile.product === 'object'
      ? { main: profile.product }
      : {};
  function shapeSlot(slot) {
    if (!slot || typeof slot !== 'object') return null;
    return {
      type: typeof slot.type === 'string' ? slot.type : '',
      temp: typeof slot.temp === 'string' ? slot.temp : '',
      toppings: typeof slot.toppings === 'string' ? slot.toppings : '',
      extras: typeof slot.extras === 'string' ? slot.extras : '',
      season: typeof slot.season === 'string' ? slot.season : undefined,
      currentStock: typeof slot.currentStock === 'number' ? slot.currentStock : null,
      hasRecipe: !!(slot.recipe && typeof slot.recipe === 'object'),
    };
  }
  return {
    setup: profile.setup || null,
    deliveryAddress: typeof profile.deliveryAddress === 'string' ? profile.deliveryAddress : '',
    inventory: Array.isArray(profile.inventory) ? profile.inventory : null,
    bindings: profile.bindings && typeof profile.bindings === 'object' ? profile.bindings : {},
    products: {
      main: shapeSlot(products.main),
      secondary: shapeSlot(products.secondary),
      seasonal: shapeSlot(products.seasonal),
    },
    schedule: Array.isArray(profile.schedule) ? profile.schedule : null,
    vision: typeof profile.vision === 'string' ? profile.vision : null,
    tier: typeof profile.tier === 'string' ? profile.tier : null,
    paid: !!profile.paid,
    completed: !!profile.completed,
  };
}

module.exports = async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const session = getSessionFromRequest(req);
      if (!session) {
        res.status(401).json({ error: 'Not logged in' });
        return;
      }
      const profile = (await kv.get(`profile:${session.accountId}`)) || {};
      res.status(200).json({ ok: true, profile: shapeProfileForResume(profile) });
    } catch (err) {
      res.status(500).json({ error: 'Something went wrong.' });
    }
    return;
  }

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

    // ---- PRODUCTS: three-slot model (2026-07-23, see the file header) ----
    //
    // Legacy read: a profile saved before the three-slot model stored a
    // single profile.product — treated here as the MAIN slot ("this is
    // today's existing single product, just renamed/relocated"), so an
    // existing account's product/recipe carries forward without a separate
    // migration step. Computed unconditionally (not just when products were
    // posted) because the changelog diff below compares against it either
    // way.
    const existingProducts =
      existing.products && typeof existing.products === 'object' && !Array.isArray(existing.products)
        ? existing.products
        : existing.product && typeof existing.product === 'object'
          ? { main: existing.product }
          : {};

    // Legacy write: an old cached client still POSTing body.product
    // (singular) is routed into the main slot, so a stale page never
    // silently loses its save. body.products (the real shape) wins if both
    // are somehow present.
    const bodyProducts =
      body.products && typeof body.products === 'object' && !Array.isArray(body.products)
        ? body.products
        : body.product && typeof body.product === 'object'
          ? { main: body.product }
          : null;

    // Per-slot plaintext { added, removed } recipe diffs — encrypted at the
    // changelog write site below, exactly like the old single recipeDiff.
    const slotRecipeDiffs = {};

    if (bodyProducts) {
      // Fresh container seeded from the (legacy-normalized) existing slots:
      // a request touching only one slot never clobbers the others, and a
      // legacy singular profile migrates to the three-slot shape on its
      // first products write. A fresh object (never the existing.products
      // reference itself) so slot writes below can never mutate `existing`
      // out from under the changelog comparison.
      profile.products = Object.assign({}, existingProducts);

      for (const slot of PRODUCT_SLOTS) {
        const raw = bodyProducts[slot];
        if (!raw || typeof raw !== 'object') continue; // slot not sent this request — merge-preserved
        const cleaned = sanitizeProduct(raw);

        if (slot === 'seasonal') {
          // season — allow-listed against SEASON_VALUES, never free text.
          // Merge-preserved when omitted on a revision (an existing valid
          // stored season stands in); a seasonal write with no valid season
          // available from either source is rejected wholesale — a seasonal
          // product without a season can't do the one job the slot exists
          // for, and storing it season-less would be worse than rejecting.
          const existingSeason =
            existingProducts.seasonal && SEASON_VALUES.indexOf(existingProducts.seasonal.season) !== -1
              ? existingProducts.seasonal.season
              : null;
          const season =
            SEASON_VALUES.indexOf(raw.season) !== -1
              ? raw.season
              : raw.season === undefined
                ? existingSeason
                : null;
          if (!season) continue;
          if (cleaned) profile.products.seasonal = Object.assign({}, profile.products.seasonal, cleaned, { season: season });
        } else if (cleaned) {
          profile.products[slot] = Object.assign({}, profile.products[slot], cleaned);
        }

        // <slot>.recipe — accepted since 2026-07-23 (see the RECIPE
        // REVERSAL note in the file header), encrypted BEFORE it is ever
        // stored — the identical treatment the old single product.recipe
        // block got, now applied independently per slot. The plaintext
        // exists only in this request's memory: length-capped, compared
        // against the DECRYPTED previous value (the stored form is
        // ciphertext and would never plaintext-equal anything, so the
        // normal diffField comparison can't work here), line-diffed if it
        // really changed, then encrypted into profile.products.<slot>
        // .recipe. Nothing below ever sees the plaintext again, and it
        // never appears in any response, log line, or plaintext changelog
        // record.
        //
        // Judgment call, carried over from the single-recipe version: an
        // empty/whitespace-only recipe is ignored rather than treated as a
        // delete — there's no "clear my recipe" UI anywhere today, so an
        // empty value here is far more likely a client bug than an
        // intentional erase of the owner's most sensitive field.
        if (typeof raw.recipe === 'string') {
          const recipePlain = raw.recipe.trim().slice(0, RECIPE_MAX_LENGTH);
          // Seasonal guard: a seasonal recipe is never stored onto a slot
          // that has no valid season (i.e. the seasonal write above was
          // rejected and no prior seasonal slot exists) — otherwise a
          // rejected seasonal payload could still leave a season-less
          // seasonal slot behind via its recipe alone.
          const seasonalSlotValid =
            slot !== 'seasonal' || (profile.products.seasonal && SEASON_VALUES.indexOf(profile.products.seasonal.season) !== -1);
          if (recipePlain && seasonalSlotValid) {
            const previousStored =
              existingProducts[slot] && existingProducts[slot].recipe && typeof existingProducts[slot].recipe === 'object'
                ? existingProducts[slot].recipe
                : null;
            // '' here means either "no recipe ever stored on this slot"
            // (first save — onboarding, not a revision, so no changelog
            // entry, matching diffField()'s own both-defined guard) or
            // "stored blob failed to decrypt" (tampered/rotated key — no
            // honest diff is computable, so none is invented; the new
            // value still gets stored below).
            const previousPlain = previousStored ? decryptRecipeText(previousStored) : '';
            if (previousPlain && previousPlain !== recipePlain) {
              slotRecipeDiffs[slot] = computeRecipeLineDiff(previousPlain, recipePlain);
            }
            profile.products[slot] = profile.products[slot] && typeof profile.products[slot] === 'object' ? profile.products[slot] : {};
            profile.products[slot].recipe = encryptRecipeText(recipePlain);
          }
        }
      }

      // The legacy singular field is retired on the first products write —
      // profile.products is the single source of truth from here on, and
      // leaving a stale profile.product behind would hand every reader two
      // conflicting copies of the main product.
      if (profile.product !== undefined) delete profile.product;
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
        profile.tier = payment.tier;
      }
    }

    // ownerContext — one new free-text note per call, appended (never
    // overwritten). cleanString() both trims and caps length; an empty or
    // whitespace-only note trims down to '' and is correctly rejected by the
    // truthiness check below, same rejection style this file already relies
    // on elsewhere (e.g. sanitizeSetup's individual string fields).
    if (typeof body.ownerContext === 'string') {
      const note = cleanString(body.ownerContext, OWNER_CONTEXT_STRING_CAP);
      if (note) {
        profile.ownerContext = Array.isArray(profile.ownerContext) ? profile.ownerContext : [];
        profile.ownerContext.push({ text: note, addedAt: new Date().toISOString() });
        if (profile.ownerContext.length > OWNER_CONTEXT_MAX) {
          profile.ownerContext = profile.ownerContext.slice(profile.ownerContext.length - OWNER_CONTEXT_MAX);
        }
      }
    }

    // packageReceived — set once, from onboarding.html's "I've received my
    // package" CTA on the standalone package screen. Server-assigned
    // timestamp (never trust a client one), and this also short-circuits
    // cron-package-reminder.js's 24h reminder push, so someone who confirms
    // early never gets a stale "did your package arrive" nudge afterward.
    if (body.packageReceived === true && !profile.packageReceivedAt) {
      profile.packageReceivedAt = new Date().toISOString();
    }

    // vision — asked once during onboarding, right before the tier fork:
    // "retirement" or "franchise". Not wired into the changelog/diff-log
    // system on purpose: there's no UI to change it after onboarding today,
    // so it only ever moves from undefined to a real value, which
    // diffField()'s own "both defined" guard would never log as a change
    // anyway — adding dead tracking code for a revision path that doesn't
    // exist would be speculative, not real.
    if (VISION_VALUES.indexOf(body.vision) !== -1) {
      profile.vision = body.vision;
    }

    if (body.completed === true) {
      profile.completed = true;
      profile.completedAt = new Date().toISOString();
      if (Number.isFinite(body.stickerCount)) {
        profile.stickerCount = Math.floor(body.stickerCount);
      }
    }

    // ---------------------------------------------------------------
    // CHANGELOG — runs AFTER every section above has merged into `profile`,
    // comparing `existing` (what was on disk before this request) against
    // `profile` (what's about to be written), for the fixed field set named
    // in this file's header comment above CHANGELOG_MAX. This deliberately
    // diffs the net effect of the request rather than tracking which
    // section(s) the client actually sent — simpler, and correct either
    // way, since a section that wasn't sent leaves `profile` equal to
    // `existing` for those fields, which never produces a diff.
    //
    // Each product slot's recipe is handled by its own dedicated per-slot
    // pass above the changelog write below (SINCE 2026-07-23 — it used to
    // be a hard "never diffed or logged, full stop" line; see the RECIPE
    // REVERSAL note in the file header for why that changed, and the
    // three-slot note for why there are now up to three such records per
    // request): a recipe's stored form is ciphertext, so it can't go
    // through diffField()'s plaintext comparison, and its changelog record
    // stores an ENCRYPTED line-diff instead of plaintext oldValue/newValue.
    //
    // A field moving from undefined to a real value (first-ever save) is
    // onboarding, not a business decision being revised, and is never
    // logged — see diffField()'s own "both defined" guard.
    // ---------------------------------------------------------------
    const changeEntries = [];

    function diffField(path, field, oldValue, newValue) {
      if (oldValue === undefined || newValue === undefined) return;
      if (oldValue === newValue) return;
      changeEntries.push({ path: path, field: field, oldValue: oldValue, newValue: newValue });
    }

    const oldSetup = existing.setup || {};
    const newSetup = profile.setup || {};
    diffField('setup.businessName', 'businessName', oldSetup.businessName, newSetup.businessName);
    diffField('setup.ownerName', 'ownerName', oldSetup.ownerName, newSetup.ownerName);
    diffField('setup.address', 'address', oldSetup.address, newSetup.address);
    diffField('setup.coreProduct', 'coreProduct', oldSetup.coreProduct, newSetup.coreProduct);

    // Per-slot product diffs (three-slot model, 2026-07-23) — the exact
    // diffField treatment product.type/temp/toppings/extras used to get,
    // now once per slot under slot-qualified paths (products.main.type,
    // products.secondary.toppings, ...), plus the seasonal slot's season.
    // oldProducts is the legacy-normalized view (a pre-3-slot singular
    // profile.product reads as the main slot), so a migrated profile's
    // first real revision diffs correctly against its old values — under
    // the new products.main.* paths, while its older records keep their
    // original product.* paths in the log (generate-directive.js reads
    // both).
    const oldProducts = existingProducts;
    const newProducts = profile.products && typeof profile.products === 'object' ? profile.products : oldProducts;
    PRODUCT_SLOTS.forEach(function (slot) {
      const oldSlot = oldProducts[slot] || {};
      const newSlot = newProducts[slot] || {};
      diffField('products.' + slot + '.type', 'type', oldSlot.type, newSlot.type);
      diffField('products.' + slot + '.temp', 'temp', oldSlot.temp, newSlot.temp);
      diffField('products.' + slot + '.toppings', 'toppings', oldSlot.toppings, newSlot.toppings);
      diffField('products.' + slot + '.extras', 'extras', oldSlot.extras, newSlot.extras);
      diffField('products.' + slot + '.currentStock', 'currentStock', oldSlot.currentStock, newSlot.currentStock);
      if (slot === 'seasonal') {
        diffField('products.seasonal.season', 'season', oldSlot.season, newSlot.season);
      }
    });
    // Each slot's recipe: diffed via the encrypt-aware per-slot pass above
    // (see `slotRecipeDiffs`), never through diffField — see comment block
    // above.

    const oldScheduleByDay = scheduleByDay(existing.schedule);
    const newScheduleByDay = scheduleByDay(profile.schedule);
    DAYS.forEach(function (day) {
      const oldRow = oldScheduleByDay[day];
      const newRow = newScheduleByDay[day];
      diffField('schedule.' + day + '.open', 'open', oldRow && oldRow.open, newRow && newRow.open);
      diffField('schedule.' + day + '.start', 'start', oldRow && oldRow.start, newRow && newRow.start);
      diffField('schedule.' + day + '.end', 'end', oldRow && oldRow.end, newRow && newRow.end);
    });

    const oldGoal = existing.goal || {};
    const newGoal = profile.goal || {};
    diffField('goal.metric', 'metric', oldGoal.metric, newGoal.metric);
    diffField('goal.target', 'target', oldGoal.target, newGoal.target);

    const hasRecipeDiffs = PRODUCT_SLOTS.some(function (slot) { return !!slotRecipeDiffs[slot]; });
    if (changeEntries.length > 0 || hasRecipeDiffs) {
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
      // Recipe change records — same key scheme/index as every other
      // tracked field, but NO plaintext oldValue/newValue (storing
      // before/after recipe text in the clear would defeat encrypting the
      // field itself). Instead: encryptedDiff, an AES-256-GCM blob whose
      // plaintext is JSON.stringify({ added: [...], removed: [...] }) —
      // the line-level ingredient diff computeRecipeLineDiff() produced
      // above. One record per changed slot, under its own slot-qualified
      // path (products.main.recipe / products.secondary.recipe /
      // products.seasonal.recipe — the three-slot extension of the old
      // single product.recipe record). generate-directive.js's
      // loadVariableDiffLog() decrypts them in memory when building the
      // reasoning prompt (see that file's SWAP POINT 3); it still reads
      // older product.recipe records too.
      PRODUCT_SLOTS.forEach(function (slot) {
        const diff = slotRecipeDiffs[slot];
        if (!diff) return;
        const recipePath = 'products.' + slot + '.recipe';
        const recipeRecordKey = `changelog:${accountId}:${changeTimestamp}:${slugifyPath(recipePath)}`;
        pipeline.set(recipeRecordKey, {
          date: changeDate,
          path: recipePath,
          field: 'recipe',
          encryptedDiff: encryptRecipeText(JSON.stringify(diff)),
          changedAt: changedAt,
        });
        pipeline.zadd(indexKey, { score: changeTimestamp, member: recipeRecordKey });
      });
      await pipeline.exec();

      // Best-effort cap — never let a trim failure block a real profile
      // save.
      await capChangelog(accountId).catch(function () {});
    }

    profile.updatedAt = new Date().toISOString();

    await kv.set(key, profile);

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
