// The three places a visitor can pick a boligtype — the hero select, the modal
// buttons and the bottom form's select — must offer the same words. They are
// posted verbatim and become GoHighLevel tags, so one form saying
// "Ejerlejlighed" where the others say "Lejlighed" silently splits the same
// property type across two tags in the CRM.
//
// No dependencies and no network:  node scripts/test-forms.mjs

import fs from 'node:fs';

const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');

// Options inside <select id="…">…</select>, minus the empty placeholder.
function selectOptions(id) {
  const block = html.match(new RegExp(`<select[^>]*id="${id}"[\\s\\S]*?</select>`));
  if (!block) throw new Error(`no <select id="${id}"> in index.html`);
  return [...block[0].matchAll(/<option(?![^>]*value="")[^>]*>([^<]+)<\/option>/g)]
    .map((m) => m[1].trim());
}

// The modal posts data-value, not the visible label, so check that.
const modalButtons = [...html.matchAll(/class="prop-type-btn"\s+data-value="([^"]+)"/g)]
  .map((m) => m[1]);

const sources = {
  'hero select (#hero-type)': selectOptions('hero-type'),
  'modal buttons (data-value)': modalButtons,
  'bottom form select (#cf-type)': selectOptions('cf-type'),
};

let fail = 0;
const reference = sources['modal buttons (data-value)'];
console.log(`\nBoligtyper offered: ${reference.join(', ')}\n`);

for (const [label, list] of Object.entries(sources)) {
  if (!list.length) {
    console.log(`  FAIL  ${label}: found none`);
    fail++;
    continue;
  }
  const same = JSON.stringify(list) === JSON.stringify(reference);
  console.log(`${same ? '  ok  ' : '  FAIL'}  ${label}: ${list.join(', ')}`);
  if (!same) fail++;
}

// The modal's visible labels should say what the buttons post, too.
const modalLabels = [...html.matchAll(/<div class="prop-type-label">([^<]+)<\/div>/g)]
  .map((m) => m[1].trim());
const labelsMatch = JSON.stringify(modalLabels) === JSON.stringify(reference);
console.log(`${labelsMatch ? '  ok  ' : '  FAIL'}  modal labels match their data-value`);
if (!labelsMatch) fail++;

console.log(fail ? `\n${fail} mismatch(es)` : '\nAll forms agree.');
process.exit(fail ? 1 : 0);
