'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { classify, summarize, render, prNumbers, clean } = require('../tools/release-notes');
const fixture = require('./fixtures/prs.json');

test('release notes: indeling in nieuwe functies, opgeloste problemen en documentatie', () => {
  assert.equal(classify({ head: 'feature/qr-claim', title: 'Toegang via QR-code' }), 'feature');
  assert.equal(classify({ head: 'fix/cache-busting', title: 'Cache-busting' }), 'fix');
  assert.equal(classify({ head: 'feature/x', title: 'Docker: arm64-build crashte' }), 'fix');
  assert.equal(classify({ head: 'docs/readme-grid', title: 'README met grids' }), 'docs');
  assert.equal(classify({ head: '', title: 'Nieuwe knop' }), 'feature');
});

test('release notes: samenvatting uit het kopje Wijzigingen, opgeschoond en beperkt', () => {
  const s = summarize(fixture.prs[0].body);
  assert.equal(s.length, 3);
  assert.equal(s[0], 'Geheim per huis (houseSecrets), nooit in /api/map.');
  assert.ok(!s.join(' ').includes('**') && !s.join(' ').includes('`'));
  assert.deepEqual(summarize(fixture.prs[1].body), ['Dependencies op het build-platform installeren.', 'Verder niets gewijzigd.']);
  assert.deepEqual(summarize('geen kopje hier'), []);
  assert.deepEqual(summarize('## Summary\n\nTekst.\n- Eerste punt\n- Tweede punt\n\n## Limits\n- niet'), ['Eerste punt', 'Tweede punt']);
  assert.equal(summarize('## Wijzigingen\n- ' + 'x'.repeat(300))[0].length, 168);
  assert.equal(clean('[tekst](http://x) ![img](a.png) **vet**'), 'tekst vet');
});

test('release notes: PR-nummers uit merge- en squashcommits', () => {
  const commits = [
    { commit: { message: 'Merge pull request #12 from o/fix/x\n\nTitel' } },
    { commit: { message: 'Iets gedaan (#15)' } },
    { commit: { message: 'Merge pull request #12 from o/fix/x' } },
    { commit: { message: 'Gewone commit' } },
  ];
  assert.deepEqual(prNumbers(commits), [12, 15]);
});

test('release notes: renderen met volgorde, lege secties weg en footer', () => {
  const md = render({ tag: 'v1.0.12', prev: 'v1.0.11', repo: 'helmerzNL/Sintmaarten', prs: fixture.prs });
  const order = ['Nieuwe functies', 'Opgeloste problemen', 'Documentatie', 'Installeren'].map((t) => md.indexOf(t));
  assert.ok(order.every((i, k) => i > (order[k - 1] ?? -1)), 'volgorde van de secties');
  assert.match(md, /\*\*Toegang via QR-code[^\n]*\*\* \(#32\)/);
  assert.match(md, /docker pull ghcr\.io\/helmerznl\/sintmaarten:v1\.0\.12/);
  assert.match(md, /compare\/v1\.0\.11\.\.\.v1\.0\.12/);
  const only = render({ tag: 'v1.0.13', prev: 'v1.0.12', repo: 'o/r', prs: [fixture.prs[1]] });
  assert.ok(!only.includes('Nieuwe functies') && !only.includes('Documentatie'));
  assert.match(render({ tag: 'v1.0.14', prs: [] }), /Geen functionele wijzigingen/);
  // zonder PR's: gewone commits onder Overig
  assert.match(render({ tag: 'v1.0.15', prs: [], commits: ['Direct gepusht'] }), /Overig[\s\S]*Direct gepusht/);
});

test('release notes: de CLI draait met een fixture zonder netwerk', () => {
  const { execFileSync } = require('node:child_process');
  const out = execFileSync('node', [path.join(__dirname, '..', 'tools', 'release-notes.js'), 'v1.0.12', 'v1.0.11', '--fixture', path.join(__dirname, 'fixtures', 'prs.json')], { encoding: 'utf8' });
  assert.match(out, /Release \*\*v1\.0\.12\*\*/);
  assert.match(out, /Opgeloste problemen/);
});

test('handgeschreven notes voor v1.0.0 bestaan en bevatten de installatie-instructie', () => {
  const md = require('node:fs').readFileSync(path.join(__dirname, '..', 'docs', 'releases', 'v1.0.0.md'), 'utf8');
  assert.match(md, /docker pull ghcr\.io\/helmerznl\/sintmaarten:v1\.0\.0/);
  assert.match(md, /Opgeloste problemen/);
});
