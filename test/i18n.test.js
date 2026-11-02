const test = require('node:test');
const assert = require('node:assert');
const { makeTranslator } = require('../public/js/lang-core');
const dicts = require('../public/js/lang-en');

const T = makeTranslator(dicts.en);
const names = (s) => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort().join(',');

test('vertaalmotor: exacte tekst, witruimte, regelafbrekingen en onbekende tekst', () => {
  assert.equal(T.tr('Opslaan'), 'Save');
  assert.equal(T.tr('  Opslaan\n'), '  Save\n');
  assert.equal(T.tr('Alles\n   tonen'), 'Show all');
  assert.equal(T.tr('Iets wat niet in het woordenboek staat'), 'Iets wat niet in het woordenboek staat');
  assert.equal(T.tr(''), '');
});

test('vertaalmotor: sjablonen met variabelen, ook geneste en samengestelde regels', () => {
  assert.equal(T.tr('Passkey "Telefoon" verwijderen?'), 'Remove passkey "Telefoon"?');
  assert.equal(T.tr('5 min geleden'), '5 min ago');
  assert.equal(T.tr('aangemeld 5 min geleden · laatst actief zojuist · 1.2.3.4'), 'registered 5 min ago · last active just now · 1.2.3.4');
  assert.equal(T.tr('Groen → Rood'), 'Green → Red');
  assert.equal(T.t('{n} berichten', { n: 3 }), '3 messages');
  assert.equal(T.t('Onbekend sjabloon {n}', { n: 3 }), 'Onbekend sjabloon 3');
});

test('in het Engels heet Sint Maarten Halloween', () => {
  assert.equal(T.tr('Sint Maarten Hoogland'), 'Halloween Hoogland');
  assert.equal(T.tr('Onze wijk'), 'Our neighbourhood');
});

test('woordenboek: elke vertaling heeft dezelfde variabelen als de bron', () => {
  for (const [k, v] of Object.entries(dicts.en)) {
    if (k === '@words') continue;
    assert.equal(typeof v, 'string', k);
    assert.ok(v.trim(), `lege vertaling voor ${k}`);
    assert.equal(names(v), names(k), `variabelen verschillen: ${k}`);
  }
});

test('woordenboek: dubbele spaties, onjuiste hoofdletters in knoppen en Nederlandse resten', () => {
  for (const [k, v] of Object.entries(dicts.en)) {
    if (k === '@words') continue;
    assert.ok(!/ {2}/.test(v), `dubbele spatie in vertaling: ${v}`);
    assert.ok(!/\b(Sint Maarten)\b/.test(v), `Sint Maarten hoort Halloween te heten: ${v}`);
  }
});

test('edities: eigen namen blijven staan, sjablonen voor de vergelijking zijn vertaald', () => {
  assert.equal(T.t('{status} alleen in {naam}', { status: 'Green', naam: 'X' }), 'Green only in X');
  assert.equal(T.tr('De naam mag maximaal 60 tekens zijn'), 'The name can be at most 60 characters');
  assert.equal(T.tr('Het jaartal moet tussen 1900 en 2100 liggen'), 'The year must be between 1900 and 2100');
  assert.equal(T.tr('3 editie(s) verwijderd'), '3 edition(s) deleted');
});
