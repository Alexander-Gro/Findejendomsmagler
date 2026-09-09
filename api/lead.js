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
//   GHL_FIELD_PROPERTY_TYPE  Custom field id for "Boligtype" (optional — the
//                      field is looked up by name, and created, when unset)
//   GHL_FIELD_ADDRESS  Custom field id for "Boligadresse" (same — optional)
//   GHL_FIELD_FORM / GHL_FIELD_REFERRER / GHL_FIELD_USER_AGENT
//                      Custom field ids for "Formular", "Henvisning" and
//                      "Browser" (same — optional)
// The GHL token also wants locations/customFields.readonly and .write so those
// fields can be resolved and created; without them the lead still lands, with
// everything in the standard fields, the tags and the contact note.

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

async function sendToAirtable(fields) {
  const baseId = process.env.AIRTABLE_BASE_ID;
  const table = process.env.AIRTABLE_TABLE || 'Leads';
  const r = await fetch(
    `https://api.airtable.com/v0/${baseId}/${encodeURIComponent(table)}`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.AIRTABLE_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ records: [{ fields }], typecast: true }),
    },
  );
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`Airtable ${r.status}: ${text.slice(0, 500)}`);
  }
  try {
    return JSON.parse(text)?.records?.[0]?.id || '';
  } catch {
    return '';
  }
}

// Everything the lead carries that GoHighLevel has no standard field for.
// Boligtype has no home at all in GHL; the address does, but in a panel away
// from the rest of the lead, so it is mirrored here where the mægler reads it
// next to name and phone. Each is resolved by name against the location and
// created if absent; set the env var to pin an existing field id instead
// (find ids via GET /locations/<id>/customFields?model=contact).
const GHL_CUSTOM_FIELDS = [
  { name: 'Boligtype', env: 'GHL_FIELD_PROPERTY_TYPE', value: (l) => l.propertyType },
  { name: 'Boligadresse', env: 'GHL_FIELD_ADDRESS', value: (l) => l.address },
  { name: 'Formular', env: 'GHL_FIELD_FORM', value: (l) => l.source },
  { name: 'Henvisning', env: 'GHL_FIELD_REFERRER', value: (l, m) => m.referrer },
  { name: 'Browser', env: 'GHL_FIELD_USER_AGENT', value: (l, m) => m.userAgent },
];

// Resolving costs two extra API calls, so the id map is memoised for the life
// of the warm serverless instance. A failed resolve is cached too, briefly, so
// a missing scope doesn't add two doomed calls to every single submission.
let ghlFieldCache = null;
let ghlFieldCacheUntil = 0;
const GHL_FIELD_CACHE_MS = 5 * 60 * 1000;

async function ghlFetch(path, { method = 'GET', body } = {}) {
  const r = await fetch(`https://services.leadconnectorhq.com${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${process.env.GHL_API_KEY}`,
      Version: GHL_VERSION,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* non-JSON error bodies happen */ }
  return { ok: r.ok, status: r.status, text, json };
}

// Map field name -> custom field id, creating any the location doesn't have.
// Best effort throughout: the caller still writes the standard fields, the tags
// and the note, so a token without the locations scopes degrades instead of
// costing us the lead.
async function resolveGhlCustomFields(locationId) {
  const now = Date.now();
  if (ghlFieldCache && now < ghlFieldCacheUntil) return ghlFieldCache;

  const map = {};
  const wanted = [];
  for (const spec of GHL_CUSTOM_FIELDS) {
    const pinned = process.env[spec.env];
    if (pinned) map[spec.name] = pinned;
    else wanted.push(spec);
  }
  if (!wanted.length) {
    ghlFieldCache = map;
    ghlFieldCacheUntil = now + GHL_FIELD_CACHE_MS;
    return map;
  }

  const list = await ghlFetch(`/locations/${locationId}/customFields?model=contact`);
  if (!list.ok) {
    console.warn(
      `[lead] GHL custom fields unreadable (${list.status}) — property type and ` +
      'address fall back to tags, the standard address field and the contact note. ' +
      'Give the token locations/customFields.readonly + .write, or set ' +
      `${GHL_CUSTOM_FIELDS.map((f) => f.env).join(' / ')}. Raw: ${list.text.slice(0, 200)}`,
    );
    ghlFieldCache = map;
    ghlFieldCacheUntil = now + GHL_FIELD_CACHE_MS;
    return map;
  }

  const existing = list.json?.customFields || [];
  for (const spec of wanted) {
    const match = existing.find(
      (f) => String(f?.name || '').trim().toLowerCase() === spec.name.toLowerCase(),
    );
    if (match?.id) {
      map[spec.name] = match.id;
      continue;
    }
    const created = await ghlFetch(`/locations/${locationId}/customFields`, {
      method: 'POST',
      body: { name: spec.name, dataType: 'TEXT', model: 'contact' },
    });
    if (created.ok && created.json?.customField?.id) {
      map[spec.name] = created.json.customField.id;
      console.log(`[lead] GHL created custom field "${spec.name}" id=${map[spec.name]}`);
    } else {
      console.warn(
        `[lead] GHL could not create custom field "${spec.name}" (${created.status}): ` +
        created.text.slice(0, 200),
      );
    }
  }

  ghlFieldCache = map;
  // Only hold a complete map for long; an incomplete one retries sooner.
  const complete = GHL_CUSTOM_FIELDS.every((f) => map[f.name]);
  ghlFieldCacheUntil = now + (complete ? 60 * 60 * 1000 : GHL_FIELD_CACHE_MS);
  return map;
}

// "Eksempelvej 1, 2000 Frederiksberg" -> street + 4-digit postcode + city, so
// leads can be filtered by area in GHL. Anything that isn't clearly a Danish
// postcode tail is left whole in address1 rather than guessed at.
function splitDanishAddress(address) {
  const m = address.match(/^(.*?)[,\s]+(\d{4})\s+([^\d,]{2,40})$/);
  if (!m || !m[1].trim()) return { address1: address };
  return { address1: m[1].trim().replace(/,$/, ''), postalCode: m[2], city: m[3].trim() };
}

// Everything the visitor typed, in one block. The contact fields above are the
// structured copy; this is the copy that is visible no matter how the location
// is configured, and it carries the context (referrer, user agent, timestamp)
// that has no field of its own.
function ghlNoteBody(lead, meta) {
  const lines = [
    'Ny lead fra findejendomsmægler.nu',
    '',
    `Boligtype:   ${lead.propertyType || '(ikke angivet)'}`,
    `Adresse:     ${lead.address || '(ikke angivet)'}`,
    `Navn:        ${[lead.firstName, lead.lastName].filter(Boolean).join(' ') || '(ikke angivet)'}`,
    `E-mail:      ${lead.email || '(ikke angivet)'}`,
    `Telefon:     ${lead.phone || '(ikke angivet)'}`,
    `Formular:    ${lead.source}`,
    `Modtaget:    ${new Date().toISOString()}`,
  ];
  if (meta.referrer) lines.push(`Kom fra:     ${meta.referrer}`);
  if (meta.userAgent) lines.push(`Browser:     ${meta.userAgent}`);
  return lines.join('\n');
}

// Upsert rather than create: GoHighLevel dedupes on email/phone within the
// location, so a seller who submits two forms updates one contact instead of
// failing as a duplicate.
//
// The lead is written three ways on purpose. Standard fields (name, email,
// phone, address) are what GHL's own UI and workflows read. Custom fields carry
// the two things GHL has no standard slot for — boligtype and the address as
// typed. The note repeats the lot as plain text, because it is the only one of
// the three that cannot be defeated by a missing scope or a renamed field.
async function sendToGoHighLevel(lead, meta = {}) {
  const locationId = process.env.GHL_LOCATION_ID;
  if (!locationId) throw new Error('GHL_LOCATION_ID is not set');

  const payload = { locationId, source: lead.source, country: 'DK' };
  if (lead.firstName) payload.firstName = lead.firstName;
  if (lead.lastName) payload.lastName = lead.lastName;
  if (lead.email) payload.email = lead.email;
  const phone = lead.phone ? toE164(lead.phone) : '';
  if (phone) payload.phone = phone;
  if (lead.address) Object.assign(payload, splitDanishAddress(lead.address));

  const tags = [lead.source, lead.propertyType].filter(Boolean);
  if (tags.length) payload.tags = tags;

  // GHL's schema is fieldValue, not field_value — the snake_case spelling is
  // accepted by the endpoint and then silently dropped, which is how property
  // type went missing without a single failed request in the logs.
  const fieldIds = await resolveGhlCustomFields(locationId).catch((err) => {
    console.warn('[lead] GHL custom field resolve failed:', err?.message || err);
    return {};
  });
  const customFields = [];
  for (const spec of GHL_CUSTOM_FIELDS) {
    const value = spec.value(lead, meta);
    const id = fieldIds[spec.name];
    if (id && value) customFields.push({ id, fieldValue: value });
  }
  if (customFields.length) payload.customFields = customFields;

  const r = await ghlFetch('/contacts/upsert', { method: 'POST', body: payload });
  if (!r.ok) {
    throw new Error(`GoHighLevel upsert ${r.status}: ${r.text.slice(0, 500)}`);
  }
  const contactId = r.json?.contact?.id || '';

  // The note is a safety net, not the delivery itself — a lead already in GHL
  // must not be reported as failed because its note didn't attach.
  if (contactId) {
    const note = await ghlFetch(`/contacts/${contactId}/notes`, {
      method: 'POST',
      body: { body: ghlNoteBody(lead, meta) },
    });
    if (!note.ok) {
      console.warn(`[lead] GHL note failed (${note.status}): ${note.text.slice(0, 200)}`);
    }
  }

  const sentFields = Object.keys(payload).filter((k) => k !== 'locationId').join(',');
  console.log(`[lead] GHL sent fields: ${sentFields}; customFields=${customFields.length}`);

  // Returned so the handler can log a contact id — proof the write landed, and
  // which record to open in GHL when someone reports a missing lead.
  return contactId;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const token = process.env.AIRTABLE_TOKEN;
  const baseId = process.env.AIRTABLE_BASE_ID;

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

  const userAgent = String(req.headers['user-agent'] || '').slice(0, 300);
  const referrer = String(req.headers['referer'] || '').slice(0, 300);

  const fields = {
    Source: source,
    'Property type': propertyType,
    Address: address,
    'First name': firstName,
    'Last name': lastName,
    Email: email,
    Phone: phone,
    'User agent': userAgent,
    Referrer: referrer,
  };

  // Strip empty values so Airtable doesn't reject unknown selects with "".
  for (const k of Object.keys(fields)) {
    if (fields[k] === '' || fields[k] == null) delete fields[k];
  }

  // The forms make both required, so a lead arriving without them is a visitor
  // on a cached page or a script posting directly. Still worth taking — a name
  // and a phone number beat nothing — but worth saying so in the log, because
  // "the CRM has no boligtype" now has exactly two possible explanations and
  // this line tells them apart.
  if (!propertyType || !address) {
    console.warn(
      `[lead] incomplete submission from "${source}" — ` +
      `propertyType=${propertyType || '(blank)'} address=${address ? 'set' : '(blank)'}`,
    );
  }

  const lead = { source, propertyType, address, firstName, lastName, email, phone };

  // Every destination is independent and they run together. Airtable used to
  // gate the other two: when it started returning 429 for exceeding its
  // monthly API quota, the handler returned early and the lead never reached
  // GoHighLevel or Klaviyo either. One destination being down, rate-limited or
  // over quota must only ever cost us that destination.
  const destinations = [['Airtable', () => sendToAirtable(fields)]];
  if (process.env.KLAVIYO_API_KEY) destinations.push(['Klaviyo', () => sendToKlaviyo(lead)]);
  else console.warn('[lead] Klaviyo SKIPPED — KLAVIYO_API_KEY not set');
  if (process.env.GHL_API_KEY) destinations.push(['GoHighLevel', () => sendToGoHighLevel(lead, { userAgent, referrer })]);
  else console.warn('[lead] GoHighLevel SKIPPED — GHL_API_KEY not set');

  try {
    const outcomes = await Promise.allSettled(destinations.map(([, send]) => send()));

    let delivered = 0;
    outcomes.forEach((outcome, i) => {
      const name = destinations[i][0];
      if (outcome.status === 'rejected') {
        console.error(`[lead] ${name} FAILED:`, outcome.reason?.message || outcome.reason);
      } else {
        delivered++;
        console.log(`[lead] ${name} OK${outcome.value ? ` id=${outcome.value}` : ''}`);
      }
    });

    // Only a lead that reached nothing at all is worth showing the visitor an
    // error for — otherwise it is recorded somewhere and can be reconciled.
    if (!delivered) {
      console.error('[lead] LOST — every destination failed');
      return res.status(502).json({ ok: false, error: 'Upstream error' });
    }

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('Lead handler error', err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
}
