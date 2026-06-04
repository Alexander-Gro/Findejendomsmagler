// Vercel serverless function — receives lead form submissions and writes to Airtable.
// Env vars required (set in Vercel dashboard):
//   AIRTABLE_TOKEN     Personal access token with data.records:write
//   AIRTABLE_BASE_ID   e.g. appXXXXXXXXXXXXXX
//   AIRTABLE_TABLE     Table name, defaults to "Leads"

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_TABLE || 'Leads';

  if (!token || !baseId) {
    return res.status(500).json({ ok: false, error: 'Server not configured' });
  }

  let body = req.body;
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch { body = {}; }
  }
  body = body || {};

  // Honeypot — bots fill hidden fields, real users don't.
  if (body.website) {
    return res.status(200).json({ ok: true });
  }

  const source = String(body.source || '').slice(0, 40);
  const propertyType = String(body.propertyType || '').slice(0, 60);
  const address = String(body.address || '').slice(0, 200);
  const firstName = String(body.firstName || '').slice(0, 80);
  const lastName = String(body.lastName || '').slice(0, 80);
  const email = String(body.email || '').slice(0, 160).trim();
  const phone = String(body.phone || '').slice(0, 40).trim();

  // Minimum data check — at least an email or phone, and a source tag.
  if (!source) {
    return res.status(400).json({ ok: false, error: 'Missing source' });
  }
  if (!email && !phone) {
    return res.status(400).json({ ok: false, error: 'Email or phone required' });
  }
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ ok: false, error: 'Invalid email' });
  }

  const fields = {
    Source: source,
    'Property type': propertyType,
    Address: address,
    'First name': firstName,
    'Last name': lastName,
    Email: email,
    Phone: phone,
    'User agent': String(req.headers['user-agent'] || '').slice(0, 300),
    Referrer: String(req.headers['referer'] || '').slice(0, 300),
  };

  // Strip empty values so Airtable doesn't reject unknown selects with "".
  for (const k of Object.keys(fields)) {
    if (fields[k] === '' || fields[k] == null) delete fields[k];
  }

  const url = `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`;

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        records: [{ fields }],
        typecast: true,
      }),
    });

    if (!r.ok) {
      const text = await r.text();
      console.error('Airtable error', r.status, text);
      return res.status(502).json({ ok: false, error: 'Upstream error' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Lead handler error', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
