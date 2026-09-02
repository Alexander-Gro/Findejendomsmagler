// One-shot: verify GHL_API_KEY and GHL_LOCATION_ID work together before
// relying on them in /api/lead.
// Usage:
//   GHL_API_KEY=pit_xxx GHL_LOCATION_ID=xxx node scripts/check-ghl.mjs
//   …same, plus --live   to also upsert a throwaway test contact
//
// Token needs scope contacts.readonly for the read check (contacts.write is
// what /api/lead actually uses — a token with only write still works there).

const GHL_VERSION = '2021-07-28';
const BASE = 'https://services.leadconnectorhq.com';

const apiKey = process.env.GHL_API_KEY;
const locationId = process.env.GHL_LOCATION_ID;

if (!apiKey || !locationId) {
  console.error('Missing GHL_API_KEY and/or GHL_LOCATION_ID env var.');
  process.exit(1);
}
if (!apiKey.startsWith('pit-')) {
  console.warn(`! Token starts with "${apiKey.slice(0, 4)}…", not "pit-". A v1 API key`);
  console.warn('  will not work against the v2 endpoints /api/lead uses.\n');
}

const headers = {
  Authorization: `Bearer ${apiKey}`,
  Version: GHL_VERSION,
  'Content-Type': 'application/json',
  Accept: 'application/json',
};

async function call(method, path, body) {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, ok: r.ok, text: await r.text() };
}

// 401/403 usually mean the token, 404 usually means the location — but GHL is
// not perfectly consistent, so the raw body is printed either way.
function explain(status) {
  if (status === 401) {
    return 'Token rejected. Either it is wrong/expired, or it lacks the scope\n' +
           '  this call needs. If /api/lead works anyway, the token simply has\n' +
           '  contacts.write without contacts.readonly — that is fine.';
  }
  if (status === 403) {
    return 'Token is valid but not authorised for this location. Most likely\n' +
           '  GHL_LOCATION_ID belongs to a different sub-account than the one\n' +
           '  the Private Integration was created in.';
  }
  if (status === 404) {
    return 'Location not found — check GHL_LOCATION_ID is the id from the\n' +
           '  /location/<id>/ part of the URL, not the sub-account name.';
  }
  return 'Unexpected status.';
}

(async () => {
  console.log(`Location: ${locationId}`);
  console.log(`Token:    ${apiKey.slice(0, 8)}…${apiKey.slice(-4)}\n`);

  // Best effort — needs locations.readonly, which the form does not require.
  const loc = await call('GET', `/locations/${locationId}`);
  if (loc.ok) {
    try {
      const name = JSON.parse(loc.text)?.location?.name;
      if (name) console.log(`Sub-account name: ${name}  <- confirm this is the right one\n`);
    } catch { /* shape changed; not worth failing over */ }
  }

  console.log('Read check (GET /contacts/)…');
  const read = await call('GET', `/contacts/?locationId=${encodeURIComponent(locationId)}&limit=1`);
  if (read.ok) {
    console.log('  ✓ token and location accepted\n');
  } else {
    console.log(`  ✗ HTTP ${read.status}`);
    console.log(`  ${explain(read.status)}`);
    console.log(`  Raw: ${read.text.slice(0, 300)}\n`);
  }

  if (!process.argv.includes('--live')) {
    console.log('Run again with --live to upsert a real test contact.');
    process.exit(read.ok ? 0 : 1);
  }

  console.log('Live check (POST /contacts/upsert)…');
  const write = await call('POST', '/contacts/upsert', {
    locationId,
    firstName: 'Test',
    lastName: 'Testsen',
    email: 'api-check@example.invalid',
    source: 'api-test',
    country: 'DK',
    tags: ['api-test'],
  });
  if (write.ok) {
    console.log('  ✓ contact upserted — find "Test Testsen" in GHL and delete it.');
  } else {
    console.log(`  ✗ HTTP ${write.status}`);
    console.log(`  ${explain(write.status)}`);
    console.log(`  Raw: ${write.text.slice(0, 300)}`);
    process.exit(1);
  }
})().catch(err => { console.error(err.message); process.exit(1); });
