// "Mijn locatie" en de community-knop (public/js/locate.js):
// - het scherm blijft aan zolang de locatie aan staat en dus ook zolang de positie met de community wordt gedeeld;
// - staat de locatie geblokkeerd, dan tonen beide knoppen een uitleg voor iOS en Android om hem weer toe te staan.
// locate.js is browsercode; hier draait hij in een vm met stubs voor Leaflet, de DOM, navigator.wakeLock en navigator.geolocation.
const test = require('node:test');
const { afterEach } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'locate.js'), 'utf8');
const tick = () => new Promise((resolve) => setImmediate(resolve));
const element = () => ({ classList: { toggle() {} }, setAttribute() {}, replaceChildren() {}, remove() {}, hidden: false });

// Een nagebootste Screen Wake Lock. `fail`: aantal vragen dat wordt geweigerd; `hold`: de volgende vraag blijft hangen
// tot de test hem afrondt. Net als in de browser meldt een lock 'release' ook als hij door de pagina zelf wordt losgelaten.
function fakeWakeLock() {
  const w = {
    requests: 0, fail: 0, hold: null, locks: [],
    get active() { return w.locks.filter((l) => !l.released); },
    async request() {
      w.requests++;
      if (w.hold) { const h = w.hold; w.hold = null; return h.promise; }
      if (w.fail > 0) { w.fail--; throw Object.assign(new Error('geweigerd'), { name: 'NotAllowedError' }); }
      return w.grant();
    },
    grant() {
      const lock = {
        released: false, handlers: [],
        addEventListener(type, fn) { if (type === 'release') this.handlers.push(fn); },
        async release() { if (this.released) return; this.released = true; this.handlers.forEach((fn) => fn()); },
      };
      w.locks.push(lock);
      return lock;
    },
  };
  return w;
}

// Delen start een timer; zonder stop() houdt die het testproces open.
const created = [];
afterEach(() => { for (const locate of created.splice(0)) locate.stop(); });

// permission: wat de Permissions API meldt (geen waarde = de browser heeft die API niet); denyWatch: de browser weigert het meten
function setup({ wakeLock = fakeWakeLock(), permission, denyWatch = false } = {}) {
  const ids = {};
  const docHandlers = {};
  const clicks = new Map();
  const shown = []; // ids van de vensters die zijn geopend
  const toasts = [];
  const document = {
    visibilityState: 'visible',
    addEventListener(type, fn) { (docHandlers[type] = docHandlers[type] || []).push(fn); },
    querySelector: () => null,
    createElement: element,
    getElementById(id) {
      if (ids[id]) return ids[id];
      const el = (ids[id] = element());
      if (id === 'community-dialog') { // de bezoeker bevestigt meteen
        el.showModal = () => { shown.push(id); ids['community-yes'].onclick(); };
        el.close = () => el.onclose();
      }
      if (id === 'locate-blocked-dialog') {
        el.open = false;
        el.showModal = () => { shown.push(id); el.open = true; };
        el.close = () => { el.open = false; };
      }
      return el;
    },
  };
  const navigator = {
    wakeLock,
    geolocation: {
      watches: 0, cleared: 0,
      watchPosition(onFix, onError) {
        navigator.geolocation.watches++;
        if (navigator.geolocation.denyWatch) setImmediate(() => onError({ code: 1 })); // net als in de browser: asynchroon
        return navigator.geolocation.watches;
      },
      clearWatch() { navigator.geolocation.cleared++; },
      denyWatch,
    },
  };
  if (permission) navigator.permissions = { query: async () => ({ state: permission }) };
  const Control = { extend: (opts) => class { addTo(map) { this.el = opts.onAdd.call(this); return this; } remove() {} } };
  const sandbox = {
    document, navigator, isSecureContext: true, console,
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    crypto: { randomUUID: () => 'a'.repeat(32) },
    fetch: async () => ({ status: 200, ok: true, json: async () => ({ peers: [] }) }),
    setInterval, clearInterval, setTimeout,
    MDI: { html: () => '' },
    L: {
      Control,
      DomUtil: { create: () => element() },
      DomEvent: { disableClickPropagation() {}, on: (el, type, fn) => clicks.set(el, fn) },
    },
  };
  sandbox.window = sandbox;
  sandbox.addEventListener = () => {};
  sandbox.Wijk = {
    COMMUNITY_COLORS: [{ c: '#7e57c2' }], COMMUNITY_ICONS: [{ i: '' }],
    createCommunityLayer: () => ({ count: 0, update() {}, clear() {} }),
  };
  vm.runInNewContext(SRC, sandbox);
  const map = { on() {}, setView() {}, panTo() {}, getZoom: () => 15, getMaxZoom: () => 19 };
  const locate = sandbox.Wijk.createLocate(map, (msg) => toasts.push(msg));
  created.push(locate);
  return {
    locate, document, navigator, wakeLock, shown, toasts,
    pressLocate: async () => { [...clicks.values()][0](); await tick(); await tick(); }, // eerste knop = mijn locatie
    pressCommunity: async () => { [...clicks.values()][1](); await tick(); await tick(); }, // tweede knop = community
    visibility: (state) => { document.visibilityState = state; (docHandlers.visibilitychange || []).forEach((fn) => fn()); },
  };
}

// locatie vanzelf aan (zoals bij het openen van de kaart), community beschikbaar
async function started(opts) {
  const t = setup(opts);
  t.locate.setCommunity(true, { looks: false });
  t.locate.setEnabled(true);
  await tick();
  return t;
}

test('locatie aan: het scherm blijft aan; locatie uit: het scherm wordt losgelaten', async () => {
  const t = await started();
  assert.equal(t.navigator.geolocation.watches, 1);
  assert.equal(t.wakeLock.active.length, 1);
  t.locate.stop();
  assert.equal(t.wakeLock.active.length, 0);
});

test('delen met de community houdt het scherm aan', async () => {
  const t = await started();
  await t.pressCommunity(); // begint met delen
  assert.equal(t.wakeLock.active.length, 1, 'er hoort precies één wake lock te zijn, ook tijdens het delen');
  assert.equal(t.wakeLock.requests, 1, 'geen dubbele aanvraag');
});

test('delen vraagt de wake lock opnieuw als de eerste vraag (bij het openen van de kaart) was geweigerd', async () => {
  const t = setup(); // eerste vraag wordt geweigerd; delen begint met een tik van de bezoeker
  t.wakeLock.fail = 1;
  t.locate.setCommunity(true, { looks: false });
  t.locate.setEnabled(true);
  await tick();
  assert.equal(t.wakeLock.active.length, 0, 'de eerste vraag is geweigerd');
  await t.pressCommunity();
  assert.equal(t.wakeLock.active.length, 1, 'bij het starten van delen wordt hij opnieuw gevraagd');
});

test('een wake lock die de browser intrekt terwijl de pagina zichtbaar is, wordt opnieuw gevraagd', async () => {
  const t = await started();
  await t.pressCommunity();
  await t.wakeLock.locks[0].release(); // bijv. batterijbesparing
  await tick();
  assert.equal(t.wakeLock.active.length, 1, 'het scherm blijft aan');
  assert.equal(t.wakeLock.requests, 2);
});

test('op de achtergrond wordt niets gevraagd; bij terugkomen wel', async () => {
  const t = await started();
  await t.pressCommunity();
  t.visibility('hidden');
  await t.wakeLock.locks[0].release(); // de browser laat hem los zodra de pagina verborgen is
  await tick();
  assert.equal(t.wakeLock.requests, 1, 'verborgen pagina: geen nieuwe vraag');
  t.visibility('visible');
  await tick();
  assert.equal(t.wakeLock.active.length, 1);
  assert.equal(t.wakeLock.requests, 2);
});

test('een vraag die loopt terwijl de pagina even naar de achtergrond gaat, wordt na terugkomen opnieuw gedaan', async () => {
  const wakeLock = fakeWakeLock();
  let resolve;
  wakeLock.hold = { promise: new Promise((r) => { resolve = r; }) };
  const t = setup({ wakeLock });
  t.locate.setEnabled(true);
  await tick();
  assert.equal(wakeLock.requests, 1, 'de eerste vraag hangt nog');
  t.visibility('hidden');
  t.visibility('visible'); // de vraag loopt nog: dit mag niet verloren gaan
  assert.equal(wakeLock.requests, 1);
  resolve(Promise.reject(Object.assign(new Error('pagina was verborgen'), { name: 'NotAllowedError' })));
  await tick(); await tick();
  assert.equal(wakeLock.requests, 2, 'na de mislukte vraag wordt het nog één keer geprobeerd');
  assert.equal(wakeLock.active.length, 1);
});

test('stoppen met delen laat de locatie en dus het scherm aan; stoppen met de locatie laat beide los', async () => {
  const t = await started();
  await t.pressCommunity(); // delen aan
  await t.pressCommunity(); // delen uit
  assert.equal(t.wakeLock.active.length, 1, 'de locatie staat nog aan');
  await t.pressCommunity(); // weer delen
  t.locate.stop();
  assert.equal(t.wakeLock.active.length, 0);
  assert.equal(t.navigator.geolocation.cleared, 1);
});

test('zonder Screen Wake Lock-ondersteuning werkt delen gewoon', async () => {
  const t = setup();
  delete t.navigator.wakeLock;
  t.locate.setCommunity(true, { looks: false });
  t.locate.setEnabled(true);
  await tick();
  await t.pressCommunity();
  assert.equal(t.navigator.geolocation.watches, 1);
  t.locate.stop();
});

// ---------- locatie geblokkeerd: uitleg voor iOS en Android ----------

test('tik op "Mijn locatie" terwijl de browser de locatie blokkeert: uitleg in een venster, locatie blijft uit', async () => {
  const t = setup({ permission: 'denied', denyWatch: true });
  t.locate.setEnabled(true);
  await tick();
  assert.deepEqual(t.shown, [], 'bij het openen van de kaart zegt het niets');
  await t.pressLocate();
  await tick();
  assert.deepEqual(t.shown, ['locate-blocked-dialog']);
  assert.deepEqual(t.toasts, [], 'het venster vervangt de korte melding');
  assert.equal(t.navigator.geolocation.cleared, 1, 'de locatie staat weer uit');
  assert.equal(t.wakeLock.active.length, 0);
  t.document.getElementById('locate-blocked-close').onclick();
  assert.equal(t.document.getElementById('locate-blocked-dialog').open, false, 'sluiten werkt');
});

test('tik op de community-knop terwijl de locatie geblokkeerd is: meteen de uitleg, zonder eerst om delen te vragen', async () => {
  const t = setup({ permission: 'denied', denyWatch: true });
  t.locate.setCommunity(true, { looks: false });
  t.locate.setEnabled(true);
  await tick();
  await t.pressCommunity();
  assert.deepEqual(t.shown, ['locate-blocked-dialog']);
  assert.equal(t.navigator.geolocation.watches, 0, 'er is niet eens een poging gedaan');
});

// De Permissions API weet het vooraf niet ('prompt'); de weigering komt pas van het meten zelf. `wait`: hoeveel de weigering van het
// vanzelf gestarte meten (stil) al is aangekomen voordat de bezoeker op de community-knop tikt: 1 = nog niet, 3 = al wel.
for (const wait of [1, 3]) {
  test(`weigert de browser het meten pas na de tik op delen, dan volgt de uitleg alsnog en stopt het delen (aankomst ${wait === 1 ? 'laat' : 'vroeg'})`, async () => {
    const t = setup({ permission: 'prompt', denyWatch: true });
    t.locate.setCommunity(true, { looks: false });
    t.locate.setEnabled(true);
    for (let i = 0; i < wait; i++) await tick();
    assert.deepEqual(t.shown, [], 'vanzelf starten meldt niets');
    await t.pressCommunity();
    await tick(); await tick();
    assert.deepEqual(t.shown, ['community-dialog', 'locate-blocked-dialog']);
    assert.equal(t.wakeLock.active.length, 0, 'er wordt niets gedeeld, dus het scherm hoeft niet aan');
  });
}

test('is de locatie niet geblokkeerd, dan komt de uitleg niet in beeld', async () => {
  const t = await started({ permission: 'granted' });
  await t.pressCommunity();
  assert.ok(!t.shown.includes('locate-blocked-dialog'));
  assert.deepEqual(t.toasts, []);
});

test('de uitleg staat in index.html, voor iOS en Android, en is volledig vertaald', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'index.html'), 'utf8');
  const block = html.match(/<dialog id="locate-blocked-dialog"[\s\S]*?<\/dialog>/)?.[0];
  assert.ok(block, 'venster ontbreekt');
  assert.match(block, /iPhone/);
  assert.match(block, /Android/);
  const { makeTranslator } = require('../public/js/lang-core');
  const T = makeTranslator(require('../public/js/lang-en').en);
  const texts = block.replace(/<[^>]+>/g, '\n').split('\n').map((s) => s.trim()).filter(Boolean);
  for (const s of texts) {
    if (s === 'Android') continue; // eigennaam, in beide talen gelijk
    assert.notEqual(T.tr(s), s, `geen Engelse vertaling voor: ${s}`);
  }
});
