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

test('vertaalmotor: een algemeen sjabloon ("{n} van {m}") loopt niet over een scheidingsteken heen', () => {
  // Losse redenen en een gewoon "x van y" werken zoals altijd.
  assert.equal(T.tr('Wijzigingen van bewoners goedgekeurd'), 'Changes by residents approved');
  assert.equal(T.tr('3 van 5'), '3 of 5');
  // Samengestelde backuprij (admin.js: reden · huizen · instellingen): eerst per stuk, niet "van" -> "of".
  assert.equal(T.tr('Wijzigingen van bewoners goedgekeurd · 8 huizen · instellingen'), 'Changes by residents approved · 8 houses · settings');
  assert.equal(T.tr('Wijziging van bewoner goedgekeurd · 1 huizen · instellingen'), 'Change by resident approved · 1 houses · settings');
  assert.equal(T.tr('Wijziging van bewoner afgewezen · 8 huizen'), 'Change by resident rejected · 8 houses');
  assert.equal(T.tr('Wijzigingen van bewoners goedgekeurd (mislukt) · 8 huizen'), 'Changes by residents approved (failed) · 8 houses');
  assert.equal(T.tr('13 nov 2026 12:00 · Wijzigingen van bewoners goedgekeurd · 8 huizen · uitleg 120 tekens'), '13 nov 2026 12:00 · Changes by residents approved · 8 houses · explanation 120 characters');
  assert.equal(T.tr('Wijzigingen van bewoners goedgekeurd → 8 huizen'), 'Changes by residents approved → 8 houses');
  // Sjablonen met een scheidingsteken in de sleutel zelf blijven in één keer passen.
  assert.equal(T.tr('Kaart nu: zoom 5 · startweergave is ingesteld'), 'Map now: zoom 5 · start view is set');
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
