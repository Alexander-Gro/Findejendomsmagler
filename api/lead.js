// Vercel serverless function — receives lead form submissions and writes to
// Airtable (record store), Klaviyo (email) and GoHighLevel (CRM) as siblings.
// Env vars required (set in Vercel dashboard):
//   AIRTABLE_TOKEN     Personal access token with data.records:write
//   AIRTABLE_BASE_ID   e.g. appXXXXXXXXXXXXXX
//   AIRTABLE_TABLE     Table name, defaults to "Leads"
//   KLAVIYO_API_KEY    Private API key (pk_...) with profile + list write scopes
//   KLAVIYO_LIST_ID    List the lead is subscribed to (optional — profile is
//                      still created/updated without it)
//   GHL_API_KEY        GoHighLevel Private Integration Token (pit-...) with the
//                      contacts.write scope
//   GHL_LOCATION_ID    GoHighLevel sub-account (location) the contact lands in
//   GHL_FIELD_PROPERTY_TYPE  Custom field id to receive the property type
//                      (optional — it is always sent as a tag regardless)

const KLAVIYO_REVISION = '2024-10-15';
const GHL_VERSION = '2021-07-28';

// Normalize to E.164 (Klaviyo rejects anything else). Danish numbers are
// 8 digits with first digit 2–9, optional +45/0045/45 prefix; full
// international numbers (+ and 8–15 digits) pass through. Returns '' when
// the value isn't a plausible phone number — the handler rejects those.
// Mirrors isValidPhone in index.html.
function toE164(phone) {
  let digits = phone.replace(/[\s\-().]/g, '');
  if (digits.startsWith('0045')) digits = `+45${digits.slice(4)}`;
  if (/^\+45[2-9]\d{7}$/.test(digits)) return digits;
  if (/^45[2-9]\d{7}$/.test(digits)) return `+${digits}`;
  if (/^[2-9]\d{7}$/.test(digits)) return `+45${digits}`;
  if (/^\+\d{8,15}$/.test(digits)) return digits;
  return '';
}

async function klaviyoFetch(path, payload) {
  const r = await fetch(`https://a.klaviyo.com/api/${path}`, {
    method: 'POST',
    headers: {
      Authorization: `Klaviyo-API-Key ${process.env.KLAVIYO_API_KEY}`,
      'Content-Type': 'application/json',
      revision: KLAVIYO_REVISION,
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Klaviyo ${path} ${r.status}: ${text.slice(0, 500)}`);
  }
}

// Create/update the profile with lead details, then subscribe it to the list.
// Consent is collected on the form ("Ved at trykke på knappen giver du samtykke…").
async function sendToKlaviyo(lead) {
  const attributes = {};
  if (lead.email) attributes.email = lead.email;
  const phone = lead.phone ? toE164(lead.phone) : '';
  if (phone) attributes.phone_number = phone;
  if (lead.firstName) attributes.first_name = lead.firstName;
  if (lead.lastName) attributes.last_name = lead.lastName;
  attributes.properties = {
    Source: lead.source,
    'Property type': lead.propertyType,
    Address: lead.address,
  };

  await klaviyoFetch('profile-import/', {
    data: { type: 'profile', attributes },
  });

  const listId = process.env.KLAVIYO_LIST_ID;
  if (!listId || !lead.email) return;

  await klaviyoFetch('profile-subscription-bulk-create-jobs/', {
    data: {
      type: 'profile-subscription-bulk-create-job',
      attributes: {
        profiles: {
          data: [{
            type: 'profile',
            attributes: {
              email: lead.email,
              subscriptions: {
                email: { marketing: { consent: 'SUBSCRIBED' } },
              },
            },
          }],
        },
        historical_import: false,
      },
      relationships: {
        list: { data: { type: 'list', id: listId } },
      },
    },
  });
}

// Upsert rather than create: GoHighLevel dedupes on email/phone within the
// location, so a seller who submits two forms updates one contact instead of
// failing as a duplicate. Source and property type ride along as tags, which
// auto-create in GHL and so need no setup there; set GHL_FIELD_PROPERTY_TYPE to
// also fill a real custom field.
async function sendToGoHighLevel(lead) {
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) throw new Error('GHL_LOCATION_ID is not set');

  const payload = { locationId, source: lead.source, country: 'DK' };
  if (lead.firstName) payload.firstName = lead.firstName;
  if (lead.lastName) payload.lastName = lead.lastName;
  if (lead.email) payload.email = lead.email;
  const phone = lead.phone ? toE164(lead.phone) : '';
  if (phone) payload.phone = phone;
  if (lead.address) payload.address1 = lead.address;

  const tags = [lead.source, lead.propertyType].filter(Boolean);
  if (tags.length) payload.tags = tags;

  const propertyTypeField = process.env.GHL_FIELD_PROPERTY_TYPE;
  if (propertyTypeField && lead.propertyType) {
    payload.customFields = [{ id: propertyTypeField, field_value: lead.propertyType }];
  }

  const r = await fetch('https://services.leadconnectorhq.com/contacts/upsert', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${process.env.GHL_API_KEY}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`GoHighLevel upsert ${r.status}: ${text.slice(0, 500)}`);
  }
}

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
  if (phone && !toE164(phone)) {
    return res.status(400).json({ ok: false, error: 'Invalid phone' });
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

    // A downstream failure must not lose the lead — it's already in Airtable —
    // so each sibling is logged and swallowed. They run together so the visitor
    // waits for the slowest one rather than the sum.
    const lead = { source, propertyType, address, firstName, lastName, email, phone };
    const siblings = [];
    if (process.env.KLAVIYO_API_KEY) siblings.push(['Klaviyo', sendToKlaviyo]);
    if (process.env.GHL_API_KEY) siblings.push(['GoHighLevel', sendToGoHighLevel]);

    const outcomes = await Promise.allSettled(siblings.map(([, send]) => send(lead)));
    outcomes.forEach((outcome, i) => {
      if (outcome.status === 'rejected') {
        console.error(`${siblings[i][0]} error`, outcome.reason);
      }
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Lead handler error', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
