const crypto = require('crypto');

// ============================================================
// Shared session-cookie helper — closes the broken object-level-authorization
// gap flagged in review: log-entry.js/log-summary.js/save-profile.js/
// subscribe.js used to trust a client-supplied `accountId` as if it were a
// credential, with nothing checking that the caller ever actually
// authenticated as that account. Anyone who obtained another business's
// accountId (shared device, browser history, a screenshot) could read/write
// that business's data forever.
//
// Fix: auth-login.js/auth-signup.js now issue a signed, HttpOnly session
// cookie on success. Every account-scoped endpoint verifies that cookie
// server-side and derives accountId from IT, not from anything the client
// sends in the request body/query string — a client-supplied accountId can
// no longer be used to read or write another account's data.
//
// Underscore-prefixed filename is deliberate: Vercel's api/ file-router
// ignores files/dirs starting with "_", so this never becomes its own route.
// ============================================================

const COOKIE_NAME = 'jae_session';
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60; // 30 days

function getSecret() {
  const secret = process.env.SESSION_SECRET;
  if (!secret) {
    // Fail loud, not open — an unset secret must never silently downgrade
    // to "trust the client," which is exactly the hole this closes.
    throw new Error('SESSION_SECRET is not configured');
  }
  return secret;
}

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64urlToBuffer(str) {
  let s = String(str).replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  return Buffer.from(s, 'base64');
}

function createSessionToken(accountId, email) {
  const payload = {
    accountId: accountId,
    email: email || '',
    exp: Date.now() + SESSION_MAX_AGE_SECONDS * 1000,
  };
  const payloadB64 = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest();
  return payloadB64 + '.' + base64url(sig);
}

function verifySessionToken(token) {
  if (typeof token !== 'string' || !token) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts;

  let expectedSig, actualSig;
  try {
    expectedSig = crypto.createHmac('sha256', getSecret()).update(payloadB64).digest();
    actualSig = base64urlToBuffer(sigB64);
  } catch (err) {
    return null;
  }
  if (expectedSig.length !== actualSig.length || !crypto.timingSafeEqual(expectedSig, actualSig)) {
    return null;
  }

  let payload;
  try {
    payload = JSON.parse(base64urlToBuffer(payloadB64).toString('utf8'));
  } catch (err) {
    return null;
  }
  if (!payload || typeof payload.accountId !== 'string' || !payload.accountId || typeof payload.exp !== 'number') {
    return null;
  }
  if (Date.now() > payload.exp) return null; // expired

  return { accountId: payload.accountId, email: payload.email || '' };
}

function parseCookies(req) {
  const header = req.headers && req.headers.cookie;
  const out = {};
  if (!header) return out;
  String(header).split(';').forEach(function (pair) {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) {
      try { out[k] = decodeURIComponent(v); } catch (err) { out[k] = v; }
    }
  });
  return out;
}

// The one thing every account-scoped endpoint should call: returns
// { accountId, email } for a valid, unexpired session, or null. Callers must
// treat null as "not logged in" (401) — never fall back to a client-supplied
// accountId.
function getSessionFromRequest(req) {
  const cookies = parseCookies(req);
  return verifySessionToken(cookies[COOKIE_NAME]);
}

function setSessionCookie(res, accountId, email) {
  const token = createSessionToken(accountId, email);
  const isProd = process.env.VERCEL === '1' || process.env.NODE_ENV === 'production';
  const attrs = [
    COOKIE_NAME + '=' + encodeURIComponent(token),
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    'Max-Age=' + SESSION_MAX_AGE_SECONDS,
  ];
  if (isProd) attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
}

module.exports = {
  COOKIE_NAME,
  createSessionToken,
  verifySessionToken,
  getSessionFromRequest,
  setSessionCookie,
};
