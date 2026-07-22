const { kv } = require('@vercel/kv');

// Single shared business instance, no auth — one profile, overwritten on
// every onboarding completion (re-running onboarding just corrects it).
module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  try {
    const body = req.body || {};

    if (!Number.isFinite(body.employees) || body.employees < 0) {
      res.status(400).json({ error: 'employees must be a finite number >= 0' });
      return;
    }
    if (body.assistantManager !== 'Yes' && body.assistantManager !== 'No') {
      res.status(400).json({ error: 'assistantManager must be "Yes" or "No"' });
      return;
    }
    if (!Number.isFinite(body.yearsInBusiness) || body.yearsInBusiness < 0) {
      res.status(400).json({ error: 'yearsInBusiness must be a finite number >= 0' });
      return;
    }

    const profile = {
      employees: body.employees,
      assistantManager: body.assistantManager,
      yearsInBusiness: body.yearsInBusiness,
      savedAt: new Date().toISOString(),
    };

    await kv.set('businessProfile', profile);

    res.status(200).json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong.' });
  }
};
