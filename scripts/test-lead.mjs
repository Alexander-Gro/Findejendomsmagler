// Drives api/lead.js with every upstream mocked, asserting that each data point
// the visitor supplied reaches somewhere GoHighLevel will actually show it, and
// that no single upstream being down can cost us the lead.
//
// No dependencies and no network — run it before deploying a change to the
// handler:  node scripts/test-lead.mjs
process.env.GHL_API_KEY = 'pit-test';
process.env.GHL_LOCATION_ID = 'loc123';
process.env.AIRTABLE_TOKEN = 't';
process.env.AIRTABLE_BASE_ID = 'app1';
process.env.KLAVIYO_API_KEY = 'pk_test';

const MOD = new URL('../api/lead.js', import.meta.url).href;
let pass = 0, fail = 0;
const check = (label, cond) => { console.log(`${cond ? '  ok  ' : '  FAIL'}  ${label}`); cond ? pass++ : fail++; };

let scenario, calls, created;
globalThis.fetch = async (url, opts = {}) => {
  const body = opts.body ? JSON.parse(opts.body) : null;
  calls.push({ url, method: opts.method || 'GET', body });
  const j = (s, o) => new Response(JSON.stringify(o), { status: s });
  if (url.includes('airtable.com')) return j(scenario.airtable || 200, { records: [{ id: 'rec1' }] });
  if (url.includes('klaviyo.com')) return j(200, {});
  if (url.includes('/customFields') && (opts.method || 'GET') === 'GET') {
    return scenario.listStatus === 200 ? j(200, { customFields: created }) : j(scenario.listStatus, { message: 'scope' });
  }
  if (url.includes('/customFields')) {
    const f = { id: 'cf_' + created.length, name: body.name, dataType: body.dataType, model: body.model };
    created.push(f); return j(201, { customField: f });
  }
  if (url.includes('/contacts/upsert')) return j(scenario.upsert || 200, { contact: { id: 'c1' } });
  if (url.includes('/notes')) return j(scenario.noteStatus || 201, {});
  return j(404, {});
};

async function post(sc, lead, headers = {}) {
  scenario = sc; calls = []; created = sc.existing ? [...sc.existing] : [];
  const { default: handler } = await import(`${MOD}?v=${Math.random()}`);
  const out = {};
  await handler({ method: 'POST', body: lead, headers },
    { status(c) { out.status = c; return this; }, json(b) { out.body = b; return out; } });
  return {
    out,
    upsert: calls.find(c => c.url.includes('/contacts/upsert'))?.body,
    note: calls.find(c => c.url.includes('/notes'))?.body?.body,
    lookups: calls.filter(c => c.url.includes('/customFields') && c.method === 'GET').length,
    created,
  };
}

// Exactly what the browser posts, verified by test-form.mjs.
const submission = {
  source: 'modal', propertyType: 'Andelsbolig', address: 'Testvej 7, 8000 Aarhus C',
  firstName: 'Jens', lastName: 'Jensen', email: 'jens@eksempel.dk', phone: '22 34 56 78',
};
const headers = { 'user-agent': 'Mozilla/5.0 TestBrowser', referer: 'https://www.google.com/' };

console.log('\n== every data point reaches GoHighLevel ==');
{
  const r = await post({ listStatus: 200 }, submission, headers);
  const cf = Object.fromEntries((r.upsert.customFields || []).map(f => [
    r.created.find(c => c.id === f.id)?.name, f.fieldValue]));
  check('lead accepted', r.out.status === 200 && r.out.body.ok === true);
  check('firstName', r.upsert.firstName === 'Jens');
  check('lastName', r.upsert.lastName === 'Jensen');
  check('email', r.upsert.email === 'jens@eksempel.dk');
  check('phone normalised to E.164', r.upsert.phone === '+4522345678');
  check('address split: address1', r.upsert.address1 === 'Testvej 7');
  check('address split: postalCode', r.upsert.postalCode === '8000');
  check('address split: city', r.upsert.city === 'Aarhus C');
  check('source as standard field', r.upsert.source === 'modal');
  check('tags carry source + boligtype', JSON.stringify(r.upsert.tags) === '["modal","Andelsbolig"]');
  check('custom field Boligtype', cf.Boligtype === 'Andelsbolig');
  check('custom field Boligadresse (as typed)', cf.Boligadresse === 'Testvej 7, 8000 Aarhus C');
  check('custom field Formular', cf.Formular === 'modal');
  check('custom field Henvisning', cf.Henvisning === 'https://www.google.com/');
  check('custom field Browser', cf.Browser === 'Mozilla/5.0 TestBrowser');
  check('all five fields sent', (r.upsert.customFields || []).length === 5);
  check('every fieldValue is camelCase (GHL drops field_value)',
    (r.upsert.customFields || []).every(f => 'fieldValue' in f && !('field_value' in f)));
  check('fields created as contact TEXT fields',
    r.created.every(f => f.dataType === 'TEXT' && f.model === 'contact'));
  for (const line of ['Boligtype:   Andelsbolig', 'Adresse:     Testvej 7, 8000 Aarhus C',
    'Navn:        Jens Jensen', 'E-mail:      jens@eksempel.dk', 'Telefon:     22 34 56 78',
    'Formular:    modal', 'Kom fra:     https://www.google.com/', 'Browser:     Mozilla/5.0 TestBrowser']) {
    check(`note contains "${line.split(':')[0]}"`, r.note.includes(line));
  }
}

console.log('\n== existing fields are reused, never duplicated ==');
{
  const existing = [{ id: 'mine_1', name: 'boligtype' }, { id: 'mine_2', name: 'Boligadresse' },
    { id: 'mine_3', name: 'Formular' }, { id: 'mine_4', name: 'Henvisning' }, { id: 'mine_5', name: 'Browser' }];
  const r = await post({ listStatus: 200, existing }, submission, headers);
  check('no new fields created', r.created.length === 5);
  check('uses the location\'s own ids (case-insensitive match)',
    r.upsert.customFields.map(f => f.id).join(',') === 'mine_1,mine_2,mine_3,mine_4,mine_5');
}

console.log('\n== degraded paths still deliver the lead ==');
{
  const r = await post({ listStatus: 401 }, submission, headers);
  check('no locations scope: still 200', r.out.status === 200);
  check('no locations scope: no custom fields sent', !r.upsert.customFields);
  check('no locations scope: boligtype survives as a tag', r.upsert.tags.includes('Andelsbolig'));
  check('no locations scope: adresse survives in address1', r.upsert.address1 === 'Testvej 7');
  check('no locations scope: note still carries everything', r.note.includes('Boligtype:   Andelsbolig'));
}
{
  const r = await post({ listStatus: 200, noteStatus: 500 }, submission, headers);
  check('note failure does not fail the lead', r.out.status === 200 && r.out.body.ok === true);
}
{
  const r = await post({ listStatus: 200, airtable: 429 }, submission, headers);
  check('Airtable over quota does not block GHL', r.out.status === 200 && !!r.upsert);
}
{
  const r = await post({ listStatus: 200, upsert: 401 }, submission, headers);
  check('GHL down but Airtable up: visitor still sees success', r.out.status === 200);
}

console.log('\n== addresses that do not fit the Danish pattern ==');
for (const [addr, expect] of [
  ['Testvej 7, 8000 Aarhus C', { address1: 'Testvej 7', postalCode: '8000', city: 'Aarhus C' }],
  ['Testvej 7 8000 Aarhus', { address1: 'Testvej 7', postalCode: '8000', city: 'Aarhus' }],
  ['Ukendt vej uden postnummer', { address1: 'Ukendt vej uden postnummer' }],
  ['8000', { address1: '8000' }],
]) {
  const r = await post({ listStatus: 200 }, { ...submission, address: addr }, headers);
  const got = { address1: r.upsert.address1 };
  if (r.upsert.postalCode) got.postalCode = r.upsert.postalCode;
  if (r.upsert.city) got.city = r.upsert.city;
  check(`"${addr}" -> ${JSON.stringify(got)}`, JSON.stringify(got) === JSON.stringify(expect));
  const cfAddr = r.upsert.customFields.find(f => r.created.find(c => c.id === f.id)?.name === 'Boligadresse');
  check('  full address kept verbatim in Boligadresse', cfAddr.fieldValue === addr);
}

console.log('\n== a direct post that skips the required fields ==');
{
  const r = await post({ listStatus: 200 }, { ...submission, propertyType: '', address: '' }, headers);
  check('still accepted rather than dropped', r.out.status === 200);
  check('note says what was missing', r.note.includes('Boligtype:   (ikke angivet)'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
