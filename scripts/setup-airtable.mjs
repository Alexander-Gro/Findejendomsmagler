// One-shot: ensure the Leads table has all fields the /api/lead function writes.
// Usage:
//   AIRTABLE_TOKEN=pat_xxx node scripts/setup-airtable.mjs
//
// Token needs scopes: schema.bases:read, schema.bases:write
// (and data.records:write later for the actual function).

const BASE_ID = 'appDKwq8gmVaB0MJ4';
const TABLE_ID = 'tblbn0vXwaoyMKJuF';

const token = process.env.AIRTABLE_TOKEN;
if (!token) {
  console.error('Missing AIRTABLE_TOKEN env var.');
  process.exit(1);
}

const headers = {
  Authorization: `Bearer ${token}`,
  'Content-Type': 'application/json',
};

const DESIRED_FIELDS = [
  { name: 'Source', type: 'singleSelect', options: { choices: [
    { name: 'hero' }, { name: 'modal' }, { name: 'main-form' }, { name: 'exit-popup' },
  ]}},
  // Must match the boligtyper the forms offer — scripts/test-forms.mjs checks
  // the three forms against each other, this list is the fourth copy.
  { name: 'Property type', type: 'singleSelect', options: { choices: [
    { name: 'Villa' }, { name: 'Rækkehus' }, { name: 'Lejlighed' },
    { name: 'Fritidshus' }, { name: 'Andelsbolig' },
  ]}},
  { name: 'Address', type: 'singleLineText' },
  { name: 'First name', type: 'singleLineText' },
  { name: 'Last name', type: 'singleLineText' },
  { name: 'Email', type: 'email' },
  { name: 'Phone', type: 'phoneNumber' },
  { name: 'User agent', type: 'multilineText' },
  { name: 'Referrer', type: 'url' },
  { name: 'Status', type: 'singleSelect', options: { choices: [
    { name: 'new' }, { name: 'contacted' }, { name: 'matched' }, { name: 'lost' },
  ]}},
];

async function getExistingFields() {
  const r = await fetch(`https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables`, { headers });
  if (!r.ok) throw new Error(`Schema fetch failed: ${r.status} ${await r.text()}`);
  const data = await r.json();
  const table = data.tables.find(t => t.id === TABLE_ID);
  if (!table) throw new Error(`Table ${TABLE_ID} not found in base ${BASE_ID}`);
  return new Set(table.fields.map(f => f.name));
}

async function createField(field) {
  const r = await fetch(
    `https://api.airtable.com/v0/meta/bases/${BASE_ID}/tables/${TABLE_ID}/fields`,
    { method: 'POST', headers, body: JSON.stringify(field) }
  );
  if (!r.ok) throw new Error(`Create ${field.name} failed: ${r.status} ${await r.text()}`);
  console.log(`  ✓ created "${field.name}" (${field.type})`);
}

(async () => {
  console.log(`Checking ${BASE_ID} / ${TABLE_ID}…`);
  const existing = await getExistingFields();
  console.log(`Existing fields: ${[...existing].join(', ') || '(none beyond primary)'}`);

  for (const field of DESIRED_FIELDS) {
    if (existing.has(field.name)) {
      console.log(`  · skip "${field.name}" (already exists)`);
      continue;
    }
    await createField(field);
  }
  console.log('Done.');
})().catch(err => { console.error(err.message); process.exit(1); });
