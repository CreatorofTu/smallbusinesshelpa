const { kv } = require('@vercel/kv');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { setSessionCookie } = require('./_session');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 6; // matches onboarding.html's client-side rule — enforced again here server-side.
const BCRYPT_COST = 11;

// Minimal IP-based throttle against signup spam/enumeration. Separate
// namespace and a looser limit than auth-login.js's brute-force throttle
// (signup abuse is spam/enumeration, not password guessing) — same
// IP/session-scoped convention used elsewhere in this app (never
// account-scoped, since there's no account yet at signup time).
const SIGNUP_WINDOW_SECONDS = 60 * 60; // 1 hour
const SIGNUP_MAX_ATTEMPTS = 10;

function getClientIp(req) {
  const xf = req.headers['x-forwarded-for'];
  if (xf) return String(xf).split(',')[0].trim();
  return (req.socket && req.socket.remoteAddress) || 'unknown';
}

async function tooManySignups(ip) {
  const key = `signupattempts:${ip}`;
  const n = await kv.incr(key);
  if (n === 1) await kv.expire(key, SIGNUP_WINDOW_SECONDS);
  return n > SIGNUP_MAX_ATTEMPTS;
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const ip = getClientIp(req);
    if (await tooManySignups(ip)) {
      res.status(429).json({ error: 'Too many signups from this connection — try again later.' });
      return;
    }

    const { email, password } = req.body || {};

    if (typeof email !== 'string' || !EMAIL_RE.test(email.trim())) {
      res.status(400).json({ error: 'Enter a valid email address.' });
      return;
    }
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      res.status(400).json({ error: 'Password needs to be at least 6 characters.' });
      return;
    }

    const emailKey = email.trim().toLowerCase();
    const accountKey = `account:${emailKey}`;

    const existing = await kv.get(accountKey);
    if (existing) {
      // Deliberately generic-but-specific here: this IS the signup path, so
      // confirming "an account already exists" doesn't leak anything an
      // attacker couldn't already infer by trying to sign up with the same
      // email. (auth-login.js is the one that must never distinguish
      // wrong-email vs wrong-password.)
      res.status(409).json({ error: 'An account with that email already exists.' });
      return;
    }

    const passwordHash = await bcrypt.hash(password, BCRYPT_COST);
    const id = crypto.randomUUID();
    const account = {
      id,
      email: emailKey,
      passwordHash,
      createdAt: new Date().toISOString(),
    };

    await kv.set(accountKey, account);

    // Same session-cookie issuance as auth-login.js — see _session.js for
    // why: the accountId in this JSON body is no longer trusted as a
    // credential by any account-scoped endpoint, only this signed cookie is.
    setSessionCookie(res, id, emailKey);

    // Never return passwordHash to the client.
    res.status(200).json({ ok: true, accountId: id, email: emailKey, completed: false });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
