const crypto = require('crypto');

// ============================================================
// _recipe-crypto.js — shared encrypt/decrypt helper for the ONE field in
// this app that gets encrypted at rest: the owner's recipe text
// (profile.product.recipe, plus the encrypted recipe line-diffs inside
// changelog:<accountId>:<timestamp>:product-recipe records).
//
// WHY THIS EXISTS AT ALL (2026-07-23, founder-directed reversal): the app
// shipped with an explicit promise that recipe data never touches our
// servers ("stays between you and the ai, NEVER US" — onboarding.html's own
// on-screen copy, enforced by save-profile.js never accepting the field).
// The founder reversed that deliberately, in his own words: "then switch
// it, its their ai manager if its needed to work some lines need to be
// crossed but acknowledge and protected and showed proof of protection."
// The "protected" half of that sentence is this file. The "acknowledge"
// half is the rewritten copy in onboarding.html / privacy.html, done in
// the same pass — never ship one without the other.
//
// WHY ENCRYPTION AT REST SPECIFICALLY: the recipe is the single most
// commercially sensitive thing an owner gives this app — it's the business.
// Without this, a raw KV read, a leaked backup, or the existing
// api/admin-export.js full-profile dump (which faithfully snapshots every
// durable key, profile.product included) would expose recipe text in
// plaintext to whoever holds the file. With it, everything at rest and in
// every export is ciphertext; plaintext only ever exists in server memory,
// for the moment it takes to compare/diff (save-profile.js) or to build the
// owner's own directive prompt (generate-directive.js), and is NEVER
// included in any HTTP response body, log line, or plaintext changelog
// record.
//
// WHY AES-256-GCM: authenticated encryption — a tampered or corrupted
// ciphertext fails the auth-tag check and decrypts to nothing, rather than
// silently returning garbage bytes that could get diffed/prompted as if
// they were a real recipe. (Same fail-honest instinct as _session.js's
// signature check: bad input is rejected, never trusted-but-mangled.)
//
// WHY THE KEY IS AN ENV VAR CLIENT CODE NEVER TOUCHES: identical posture to
// every other secret in this app (SESSION_SECRET, ADMIN_TOKEN,
// ANTHROPIC_API_KEY) — server env var only, gitignored .env.local locally,
// Vercel env var in production, never in client JS, never in any response.
// RECIPE_ENCRYPTION_KEY is expected as a 64-character hex string (32 bytes
// = AES-256). Generate one with `openssl rand -hex 32`. No key value is
// ever generated, printed, or hardcoded by this code — getRecipeKey() fails
// loud (same convention as _session.js's getSecret()) rather than silently
// downgrading to weaker-or-no encryption.
//
// IV: crypto.randomBytes(12) per encryption — 12 bytes is the standard,
// recommended GCM IV length, and a fresh random IV per call means the same
// recipe encrypted twice produces different ciphertexts (GCM's security
// depends on never reusing an IV under the same key).
//
// Underscore-prefixed filename is deliberate: Vercel's api/ file-router
// ignores files/dirs starting with "_", so this never becomes its own
// route — same convention as _session.js/_safe-compare.js.
// ============================================================

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12; // standard GCM IV length — do not change, do not reuse an IV
const KEY_HEX_RE = /^[0-9a-fA-F]{64}$/; // 32 bytes as hex = AES-256 key

function getRecipeKey() {
  const hex = process.env.RECIPE_ENCRYPTION_KEY;
  if (!hex || typeof hex !== 'string' || !KEY_HEX_RE.test(hex)) {
    // Fail loud, not open — an unset/malformed key must never silently
    // downgrade to storing plaintext (which is exactly the exposure this
    // file exists to prevent). Same convention as _session.js's getSecret().
    throw new Error(
      'RECIPE_ENCRYPTION_KEY is not configured or is the wrong shape — expected a 64-character hex string (32 bytes). Generate one with `openssl rand -hex 32` and set it as a server env var.'
    );
  }
  return Buffer.from(hex, 'hex');
}

// plaintext string -> { iv, tag, data } (all base64) — the exact stored
// representation. Throws (loud) if the key is unconfigured; callers only
// reach this on requests that actually carry recipe text, so a missing key
// never breaks recipe-free saves.
function encryptRecipeText(plaintext) {
  const key = getRecipeKey();
  const iv = crypto.randomBytes(IV_BYTES);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const data = Buffer.concat([cipher.update(String(plaintext), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    data: data.toString('base64'),
  };
}

// { iv, tag, data } -> plaintext string, or '' when there is nothing real
// to decrypt. A profile with no recipe yet is a completely normal state —
// absent/malformed `stored` returns '' without ever touching the key, so
// recipe-less accounts never even require the env var on the read path.
// A structurally-valid blob that fails to decrypt (tampered ciphertext,
// wrong key after a rotation) also returns '' — GCM's auth tag makes that
// failure detectable, and "no readable recipe" is the honest result, never
// garbage bytes. The ONE case that still throws is a missing/malformed
// RECIPE_ENCRYPTION_KEY with real ciphertext in hand — that's a server
// misconfiguration, and hiding it as '' would silently make every stored
// recipe look deleted (same fail-loud reasoning as encryptRecipeText).
function decryptRecipeText(stored) {
  if (!stored || typeof stored !== 'object') return '';
  if (typeof stored.iv !== 'string' || typeof stored.tag !== 'string' || typeof stored.data !== 'string') {
    return '';
  }
  const key = getRecipeKey(); // deliberately OUTSIDE the try — see comment above
  try {
    const decipher = crypto.createDecipheriv(ALGORITHM, key, Buffer.from(stored.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(stored.tag, 'base64'));
    const out = Buffer.concat([
      decipher.update(Buffer.from(stored.data, 'base64')),
      decipher.final(),
    ]);
    return out.toString('utf8');
  } catch (err) {
    return '';
  }
}

module.exports = { encryptRecipeText, decryptRecipeText };
