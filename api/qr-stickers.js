const { kv } = require('@vercel/kv');
const { getSessionFromRequest } = require('./_session');

// ============================================================
// qr-stickers.js — owner-facing, session-scoped, READ-ONLY GET endpoint
// that lists the account's real sticker bindings so the owner can actually
// see and print the real customer-facing QR codes
// (review.html?business=<accountId>&item=<itemId>).
//
// Real gap this closes (per PRODUCT-CONTEXT.md's "QR-code environment-
// review system" section, "Technical shape" + "QR visual style"
// subsections): profile:<accountId>.bindings — sticker number -> {id,
// name}, written by save-profile.js's stickerBinding path during
// onboarding.html's own walk-around/binding flow — has never had anywhere
// an owner could see the resulting review.html URLs or a printable QR
// code for them. This endpoint writes nothing; it only derives a view
// from data that already exists in profile:<accountId>.
//
// AUTHORIZATION: accountId comes from the caller's signed session cookie
// (see _session.js), same as every other account-scoped endpoint in this
// app (log-summary.js, save-profile.js, etc.) — never from the query
// string or request body.
//
// ITEM NAME RESOLUTION: a binding's own `name` field is a SNAPSHOT taken
// at bind time (onboarding.html: `state.bindings[num] = {id: item.id, name:
// item.name}`), so it can go stale if the owner later renames or removes
// that inventory row. qr-questions.js — the endpoint the real customer
// scan page (review.html) actually calls — always resolves the CURRENT
// name from profile.inventory by id at scan time, not the bindings
// snapshot. This endpoint matches that same resolution so what the owner
// sees here is what a customer will actually see, not a stale copy. A
// binding whose id no longer exists in inventory is still returned (it's
// a real, existing binding) but flagged `orphaned: true` so the owner
// knows that sticker's code won't resolve for a real customer scan until
// the item is restored in their list or the sticker is rebound to
// something else — qr-questions.js itself 404s ("Unknown item for this
// business") for exactly this case today.
// ============================================================

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
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

    const profile = await kv.get(`profile:${accountId}`);
    const bindings = (profile && profile.bindings && typeof profile.bindings === 'object' && !Array.isArray(profile.bindings))
      ? profile.bindings
      : {};
    const inventory = (profile && Array.isArray(profile.inventory)) ? profile.inventory : [];
    const businessName = (profile && profile.setup && profile.setup.businessName) || '';
    const coreProduct = (profile && profile.setup && profile.setup.coreProduct) || '';

    const items = Object.keys(bindings)
      .map((k) => Math.floor(Number(k)))
      .filter((n) => Number.isFinite(n) && n >= 1 && n <= 100)
      .sort((a, b) => a - b)
      .map((num) => {
        const b = bindings[String(num)] || {};
        const liveItem = inventory.find((row) => row && row.id === b.id);
        return {
          sticker: num,
          id: typeof b.id === 'string' ? b.id : '',
          name: (liveItem && liveItem.name) || b.name || '',
          orphaned: !liveItem,
        };
      })
      .filter((item) => !!item.id);

    res.status(200).json({
      ok: true,
      accountId,
      businessName,
      coreProduct,
      items,
    });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
