const crypto = require('crypto');

// Constant-time string comparison for secrets (ADMIN_TOKEN, etc.). Plain
// `a !== b` short-circuits on the first mismatched byte, which is a known
// timing side-channel for privileged secrets — crypto.timingSafeEqual
// closes it. It throws on mismatched buffer lengths, so that's checked
// first (a length mismatch is itself safe to reveal, and false in that case
// is exactly the right answer).
//
// Underscore-prefixed filename: Vercel's api/ file-router ignores files/dirs
// starting with "_", so this never becomes its own route.
function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a, 'utf8');
  const bufB = Buffer.from(b, 'utf8');
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

module.exports = { safeCompare };
