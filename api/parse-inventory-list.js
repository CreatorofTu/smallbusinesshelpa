const { kv } = require('@vercel/kv');
const { getSessionFromRequest } = require('./_session');

// ============================================================
// parse-inventory-list.js — session-authenticated POST that turns a raw,
// messy, "just say all the things" walk-around dump (onboarding.html's new
// bulk-add box on screen-inventory) into a clean array of distinct item
// names, via a real Anthropic call. Owner-only, not public — matches
// save-profile.js's session-cookie convention, not the anonymous-customer
// pattern the QR endpoints use.
//
// FALLBACK: if ANTHROPIC_API_KEY isn't configured, this still works —
// naiveSplit() below does a deterministic comma/newline split, trim,
// dedupe. Degraded (no typo/plural cleanup, no filler-word stripping), but
// never leaves the owner stuck, same posture as every other AI-calling
// endpoint in this codebase (generate-directive.js/generate-goal-
// questions.js/qr-questions.js all have the identical "configured:false,
// still functional" fallback).
//
// TRUST & SAFETY: the raw text is the owner's own free-form input about
// their own business — still fenced before ever reaching a prompt, per this
// codebase's blanket rule that every AI prompt fences untrusted free text,
// no exceptions carved out for "it's just the owner talking about
// themselves."
// ============================================================

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_VERSION = '2023-06-01';
const ANTHROPIC_MODEL = 'claude-sonnet-5';

const TEXT_MAX_LENGTH = 2000;
const MAX_ITEMS = 50;

const WINDOW_SECONDS = 60 * 60; // 1 hour
const MAX_PARSES_PER_HOUR = 20; // owner-authenticated, generous enough for a few retries while building a real list

const ITEMS_OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: { type: 'string' },
      maxItems: MAX_ITEMS,
    },
  },
  required: ['items'],
  additionalProperties: false,
};

async function registerParseAttempt(accountId) {
  const key = `invparseattempts:${accountId}`;
  const n = await kv.incr(key);
  if (n === 1) await kv.expire(key, WINDOW_SECONDS);
  return n;
}

function fenceUserText(raw, tag) {
  const s = typeof raw === 'string' ? raw : '';
  if (!s) return null;
  const escaped = s.split('<').join('&lt;').split('>').join('&gt;');
  return `<${tag}>${escaped}</${tag}>`;
}

function naiveSplit(text) {
  return text
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((s, i, arr) => arr.indexOf(s) === i)
    .slice(0, MAX_ITEMS);
}

function buildPrompt(fencedText) {
  return `A small food & beverage business owner just walked around their restaurant/cafe and typed or dictated a raw, messy list of everything they saw — physical items, fixtures, anything a customer might notice or interact with. It may be comma-separated, one-per-line, or a rambling mix, with filler words, plurals, or minor typos.

${fencedText}

Extract a clean array of distinct, short, plain-language item names (2-5 words each) a customer would recognize — e.g. "Radio", "Bathroom door (left)", "Soap dispenser", "Board games". Rules:
- Never invent an item that wasn't actually mentioned.
- Merge exact duplicates, but never merge two genuinely distinct real items into one.
- Strip filler words ("um", "and then", "I guess") — keep only the item name itself.
- If two sides/copies of the same fixture are both mentioned (e.g. "bathroom door left" and "bathroom door right"), keep them as two separate items, not one.
- Return ONLY the JSON array requested — no counts, no extra commentary.`;
}

async function callAnthropic(prompt) {
  const res = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': ANTHROPIC_VERSION,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      max_tokens: 800,
      thinking: { type: 'disabled' },
      output_config: { format: { type: 'json_schema', schema: ITEMS_OUTPUT_SCHEMA } },
      messages: [{ role: 'user', content: prompt }],
    }),
  });

  if (!res.ok) {
    const bodyText = await res.text().catch(() => '');
    const err = new Error(`Anthropic API error ${res.status}: ${bodyText.slice(0, 500)}`);
    err.status = res.status;
    throw err;
  }

  return res.json();
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

    const attemptCount = await registerParseAttempt(accountId);
    if (attemptCount > MAX_PARSES_PER_HOUR) {
      res.status(429).json({ error: 'Too many attempts — try again in a bit.' });
      return;
    }

    const raw = (req.body && req.body.text) || '';
    if (typeof raw !== 'string' || !raw.trim()) {
      res.status(400).json({ error: 'Nothing to sort — type your list first.' });
      return;
    }
    const text = raw.trim().slice(0, TEXT_MAX_LENGTH);

    if (!process.env.ANTHROPIC_API_KEY) {
      res.status(200).json({ ok: true, configured: false, items: naiveSplit(text) });
      return;
    }

    const fenced = fenceUserText(text, 'walkaround_list');
    let apiResponse;
    try {
      apiResponse = await callAnthropic(buildPrompt(fenced));
    } catch (err) {
      // Same posture as every other AI-calling endpoint here — a model-side
      // failure degrades to the deterministic fallback, never a 500 that
      // strands the owner mid-onboarding.
      res.status(200).json({ ok: true, configured: false, items: naiveSplit(text) });
      return;
    }

    if (apiResponse.stop_reason === 'refusal') {
      res.status(200).json({ ok: true, configured: false, items: naiveSplit(text) });
      return;
    }

    const textBlock = Array.isArray(apiResponse.content) ? apiResponse.content.find((b) => b.type === 'text') : null;
    let items = null;
    try {
      const parsed = JSON.parse(textBlock && textBlock.text);
      items = Array.isArray(parsed.items) ? parsed.items.filter((s) => typeof s === 'string' && s.trim()).slice(0, MAX_ITEMS) : null;
    } catch (err) {
      items = null;
    }

    if (!items || items.length === 0) {
      res.status(200).json({ ok: true, configured: false, items: naiveSplit(text) });
      return;
    }

    res.status(200).json({ ok: true, configured: true, items });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
