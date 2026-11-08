const test = require('node:test');
const assert = require('node:assert');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { zipSync, unzipSync, strToU8 } = require('fflate');

// Een datamap met backups van vóór de ZIP: die worden bij het starten omgezet.
const DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-bk-'));
process.env.DATA_DIR = DATA;
process.env.SETUP_TOKEN = 'test-setup-token-123';
process.env.SESSION_SECRET = 'test-session-secret-123';
const BK = path.join(DATA, 'backups');
fs.mkdirSync(BK, { recursive: true });
const sq = [[52.02, 5.16], [52.02, 5.161], [52.021, 5.161]];
const LEGACY_ID = '1700000000000-abcdef';
const legacy = {
  id: LEGACY_ID, createdAt: '2023-11-14T22:13:20.000Z', reason: 'Layout opgeslagen', title: 'Oud', ok: true, hash: 'x',
  houses: [{ id: 'o1', street: 'Oudestraat', number: '1', status: 'green', note: '', points: sq }], view: null, pdfView: null,
  texts: { labels: { green: 'Groen', red: 'Rood', none: 'Niet gemarkeerd' }, siteTitle: 'Oude wijk', intro: 'Oude uitleg', appName: '', appShortName: '', translations: {} },
  editions: [],
};
fs.writeFileSync(path.join(BK, `${LEGACY_ID}.json`), JSON.stringify(legacy));
fs.writeFileSync(path.join(BK, 'onzin.json'), '{}'); // geen backup: blijft staan
fs.writeFileSync(path.join(BK, '1700000000001-abcdef.json'), 'kapot'); // onleesbaar: blijft staan
fs.writeFileSync(path.join(BK, 'sint_maarten-backup-1700000000002-abcdef.zip.tmp'), 'half'); // onderbroken schrijfactie

const app = require('../server/index.js');
const backups = require('../server/backups');
const store = require('../server/store');

let server, base;
test.before(() => new Promise((r) => { server = app.listen(0, () => { base = `http://localhost:${server.address().port}`; r(); }); }));
test.after(() => server.close());

const exp = String(Date.now() + 3600e3);
const cookie = `sm_session=${exp}.${crypto.createHmac('sha256', 'test-session-secret-123').update(exp).digest('base64url')}`;
store.db().users.push({ id: 'owner', username: 'beheerder', createdAt: new Date().toISOString(), epoch: 0, webauthnId: 'dGVzdA', password: null, mfa: null, recovery: [] });

const j = (p, o) => fetch(base + p, o);
const H = { 'Content-Type': 'application/json', cookie };
const put = (p, body) => j(p, { method: 'PUT', headers: H, body: JSON.stringify(body) });
const post = (p, body) => j(p, { method: 'POST', headers: H, body: JSON.stringify(body) });
const upload = (p, buf, c = cookie) => j(p, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream', ...(c ? { cookie: c } : {}) }, body: buf });
const tick = () => new Promise((r) => setTimeout(r, 50));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
// Een PNG-kop met afmetingen en een eigen vulling (zo is elk plaatje anders).
const png = (w, h, fill) => {
  const b = Buffer.alloc(64, fill);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b);
  b.writeUInt32BE(13, 8); b.write('IHDR', 12); b.writeUInt32BE(w, 16); b.writeUInt32BE(h, 20);
  return b;
};
const map = async () => (await j('/api/map')).json();
const adminSettings = async () => (await j('/api/admin/settings', { headers: { cookie } })).json();
const download = async (id) => Buffer.from(await (await j(`/api/admin/backups/${id}`, { headers: { cookie } })).arrayBuffer());
const entries = (zip) => Object.fromEntries(Object.entries(unzipSync(zip)).map(([k, v]) => [k, Buffer.from(v)]));
const docIn = (zip) => JSON.parse(entries(zip)['backup.json'].toString());
const rezip = (files) => Buffer.from(zipSync(Object.fromEntries(Object.entries(files).map(([k, v]) => [k, typeof v === 'string' ? strToU8(v) : v]))));
const uploaded = (url) => fs.readFileSync(path.join(store.uploadDir, path.basename(url)));
const uploadExists = (url) => fs.existsSync(path.join(store.uploadDir, path.basename(url)));

const LOGO = png(400, 100, 1);
const FAVICON = png(512, 512, 2);
const CODE = '918273';

test('oude .json-backups worden bij het starten omgezet naar sint_maarten-backup-<id>.zip', () => {
  const files = fs.readdirSync(BK).sort();
  assert.ok(files.includes(`sint_maarten-backup-${LEGACY_ID}.zip`));
  assert.ok(!files.includes(`${LEGACY_ID}.json`));
  assert.ok(files.includes('onzin.json') && files.includes('1700000000001-abcdef.json')); // geen backup of onleesbaar: blijft staan
  assert.ok(!files.some((f) => f.endsWith('.tmp')));
  const b = backups.read(LEGACY_ID);
  assert.equal(b.texts.intro, 'Oude uitleg');
  assert.equal(b.title, 'Oud');
  assert.equal(b.format_version, 1);
  assert.equal(b.settings, undefined);
  assert.equal(b.logos, undefined);
  const item = backups.list().find((x) => x.id === LEGACY_ID);
  assert.equal(item.settings, false);
  assert.equal(item.logos, null);
});

test("een backup bevat de app-instellingen en de logo's, als ZIP met backup.json en files/", async () => {
  assert.equal((await put('/api/admin/houses', { houses: [{ id: 'n1', street: 'Nieuwstraat', number: '1', status: 'red', points: sq }] })).status, 200);
  const settings = { simpleUi: true, statsPublic: true, statsShow: { red: false }, residentsCode: CODE, residentsCodeOn: true, communityEnabled: true, multilingual: true, defaultLang: 'en', residentsGeofenceRadius: 800, residentInfo: 'Info voor bewoners', qrShareText: 'Deel dit', communityTitle: 'Doe mee' };
  assert.equal((await put('/api/admin/settings', settings)).status, 200);
  // een logo opslaan of verwijderen maakt een backup, net als andere instellingen
  const before = backups.list().length;
  assert.equal((await upload('/api/admin/logo', LOGO)).status, 200);
  assert.equal((await upload('/api/admin/favicon', FAVICON)).status, 200);
  assert.equal((await upload('/api/admin/logo-small', png(64, 64, 3))).status, 200);
  assert.equal((await j('/api/admin/logo-small', { method: 'DELETE', headers: { cookie } })).status, 200);
  await tick();
  assert.deepEqual(backups.list().slice(0, 4).map((x) => x.reason), ['Klein logo verwijderd', 'Klein logo opgeslagen', 'Favicon opgeslagen', 'Logo opgeslagen']);
  assert.equal(backups.list().length, before + 4);

  const { id } = await (await post('/api/admin/backups', { title: 'Alles' })).json();
  const item = backups.list().find((x) => x.id === id);
  assert.equal(item.settings, true);
  assert.equal(item.logos, 2);
  // het bestand staat in DATA_PATH/backups, met het voorvoegsel sint_maarten-backup-
  assert.ok(fs.existsSync(path.join(BK, `sint_maarten-backup-${id}.zip`)));

  const zip = await download(id);
  assert.deepEqual(zip.subarray(0, 4), Buffer.from('PK\x03\x04', 'latin1'));
  const files = entries(zip);
  assert.deepEqual(Object.keys(files).sort(), ['backup.json', 'files/favicon.png', 'files/logo.png']);
  assert.deepEqual(files['files/logo.png'], LOGO); // byte voor byte
  assert.deepEqual(files['files/favicon.png'], FAVICON);
  // afbeeldingen worden opgeslagen, niet gecomprimeerd; backup.json wel
  const how = {};
  unzipSync(zip, { filter: (f) => { how[f.name] = f.compression; return false; } });
  assert.deepEqual(how, { 'backup.json': 8, 'files/favicon.png': 0, 'files/logo.png': 0 });

  const doc = docIn(zip);
  assert.equal(doc.format, 'doorbell-map-backup');
  assert.equal(doc.format_version, 2);
  assert.equal(doc.includes_files, true);
  assert.equal(doc.title, 'Alles');
  assert.deepEqual(doc.logos.logo, { archive_path: 'files/logo.png', sha256: sha(LOGO), size: LOGO.length });
  assert.equal(doc.logos.logoSmall, null);
  assert.equal(doc.settings.simpleUi, true);
  assert.equal(doc.settings.communityEnabled, true);
  assert.equal(doc.settings.residentsCodeOn, true);
  assert.equal(doc.settings.defaultLang, 'en');
  assert.equal(doc.settings.residentsGeofenceRadius, 800);
  assert.equal(doc.settings.statsShow.red, false);
  assert.equal(doc.settings.locateEnabled, true); // standaard aan
  assert.equal(doc.texts.residentInfo, 'Info voor bewoners');
  assert.equal(doc.texts.qrShareText, 'Deel dit');
  assert.equal(doc.texts.communityTitle, 'Doe mee');
  // niets waarmee je ergens binnenkomt: geen toegangscode, inloggegevens, QR-geheimen of pushsleutels
  const text = files['backup.json'].toString();
  assert.ok(!text.includes(CODE));
  for (const w of ['"residentsCode"', 'houseSecrets', 'passkey', 'webauthn', 'password', 'recovery', 'vapid', 'subscription']) assert.ok(!text.toLowerCase().includes(w.toLowerCase()), w);

  // een titel wijzigen laat de logo's in de ZIP staan
  assert.equal((await put(`/api/admin/backups/${id}/title`, { title: 'Alles, ook logo' })).status, 200);
  const again = entries(await download(id));
  assert.deepEqual(again['files/logo.png'], LOGO);
  assert.equal(JSON.parse(again['backup.json'].toString()).title, 'Alles, ook logo');
});

test("terugzetten zet de instellingen en logo's terug; de toegangscode blijft die van nu", async () => {
  const id = backups.list().find((x) => x.reason === 'Handmatig').id;
  const LOGO2 = png(300, 100, 9);
  const SMALL = png(64, 64, 7);
  await put('/api/admin/settings', { simpleUi: false, communityEnabled: false, defaultLang: 'nl', residentsCode: '555555', residentInfo: 'Anders', statsShow: { red: true } });
  assert.equal((await upload('/api/admin/logo', LOGO2)).status, 200);
  assert.equal((await upload('/api/admin/logo-small', SMALL)).status, 200);
  assert.equal((await j('/api/admin/favicon', { method: 'DELETE', headers: { cookie } })).status, 200);
  await tick();
  const changed = await map();
  // de huidige staat staat zelf ook in een backup, met het nieuwe logo
  assert.ok(backups.list().some((x) => backups.read(x.id).logos?.logo?.sha256 === sha(LOGO2)));

  assert.equal((await post(`/api/admin/backups/${id}/restore`, {})).status, 200);
  const m = await map();
  assert.deepEqual(uploaded(m.logo.url), LOGO);
  assert.deepEqual(uploaded(m.favicon.url), FAVICON);
  assert.equal(m.favicon.width, 512);
  assert.equal(m.favicon.type, 'image/png');
  assert.equal(m.logoSmall, null);
  assert.equal(m.simpleUi, true);
  assert.equal(m.communityEnabled, true);
  assert.equal(m.defaultLang, 'en');
  const s = await adminSettings();
  assert.equal(s.residentInfo, 'Info voor bewoners');
  assert.equal(s.residentsCode, '555555'); // de code ging niet mee in de backup
  assert.equal(s.residentsCodeOn, true);
  assert.equal(s.statsShow.red, false);
  assert.equal(s.residentsGeofenceRadius, 800);
  // de vervangen bestanden zijn weg
  await tick();
  assert.ok(!uploadExists(changed.logo.url));
  assert.ok(!uploadExists(changed.logoSmall.url));

  // nog eens terugzetten: hetzelfde logo blijft hetzelfde bestand (de URL verandert niet)
  assert.equal((await post(`/api/admin/backups/${id}/restore`, {})).status, 200);
  assert.equal((await map()).logo.url, m.logo.url);

  // zonder geldige code gaat de toegangscode niet aan
  await put('/api/admin/settings', { residentsCode: '' });
  assert.equal((await post(`/api/admin/backups/${id}/restore`, {})).status, 200);
  assert.equal((await adminSettings()).residentsCodeOn, false);
});

test("een backup zonder instellingen en logo's (van vóór de ZIP) laat die bij terugzetten staan", async () => {
  const now = await map();
  assert.equal((await post(`/api/admin/backups/${LEGACY_ID}/restore`, {})).status, 200);
  const m = await map();
  assert.equal(m.intro, 'Oude uitleg');
  assert.equal(m.houses[0].street, 'Oudestraat');
  assert.equal(m.logo.url, now.logo.url);
  assert.equal(m.simpleUi, now.simpleUi);
  assert.equal((await adminSettings()).residentInfo, 'Info voor bewoners');
  // een geüploade .json-backup idem, ook als er logo's in backup.json staan: die horen bij een ZIP
  const doc = backups.read(backups.list().find((x) => x.logos === 2).id);
  const up = await post('/api/admin/backups/import', { ...doc, settings: undefined });
  assert.equal(up.status, 200);
  const newId = (await up.json()).id;
  assert.equal(backups.read(newId).logos, undefined);
  assert.equal(backups.list().find((x) => x.id === newId).logos, null);
});

test('een geüploade ZIP wordt volledig gecontroleerd; een geweigerd bestand verandert niets', async () => {
  const id = backups.list().find((x) => x.logos === 2).id;
  const zip = await download(id);
  const files = entries(zip);
  const doc = JSON.parse(files['backup.json'].toString());
  const withDoc = (d, extra = {}) => rezip({ ...files, 'backup.json': JSON.stringify(d), ...extra });

  // dezelfde ZIP: komt erbij, met de logo's
  const ok = await upload('/api/admin/backups/import', zip);
  assert.equal(ok.status, 200);
  const okId = (await ok.json()).id;
  assert.notEqual(okId, id);
  assert.equal(backups.read(okId).reason, 'Geüpload');
  assert.deepEqual(entries(await download(okId))['files/logo.png'], LOGO);

  const n = backups.list().length;
  const uploadsBefore = fs.readdirSync(store.uploadDir).sort();
  const GIF = Buffer.from('GIF89a-geen-png-of-jpeg');
  const BIG = Buffer.concat([png(10, 10, 1), Buffer.alloc(5 * 1024 * 1024)]);
  const cases = {
    'ander logo dan in backup.json': rezip({ ...files, 'files/logo.png': png(400, 100, 5) }),
    'logo ontbreekt': rezip({ 'backup.json': files['backup.json'], 'files/favicon.png': files['files/favicon.png'] }),
    'geen afbeelding': withDoc({ ...doc, logos: { ...doc.logos, logo: { archive_path: 'files/logo.png', sha256: sha(GIF), size: GIF.length } } }, { 'files/logo.png': GIF }),
    'logo te groot': withDoc({ ...doc, logos: { ...doc.logos, logo: { archive_path: 'files/logo.png', sha256: sha(BIG), size: BIG.length } } }, { 'files/logo.png': BIG }),
    'pad als naam': withDoc({ ...doc, logos: { ...doc.logos, logo: { ...doc.logos.logo, archive_path: '../../db.json' } } }),
    "logo's ongeldig": withDoc({ ...doc, logos: 'nee' }),
    'backup.json ontbreekt': rezip({ 'files/logo.png': LOGO }),
    'backup.json kapot': rezip({ 'backup.json': '{kapot' }),
    'nieuwere versie': withDoc({ ...doc, format_version: 3, app_version: '9.9.9' }),
    'andere app': withDoc({ ...doc, format: 'iets-anders' }),
    'instellingen ongeldig': withDoc({ ...doc, settings: { ...doc.settings, defaultLang: 'xx' } }),
    'straal ongeldig': withDoc({ ...doc, settings: { ...doc.settings, residentsGeofenceRadius: 1 } }),
    'huizen ongeldig': withDoc({ ...doc, houses: 'nee' }),
    'geen ZIP': Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), Buffer.from('onzin')]),
    'geen JSON': Buffer.from('dit is niets'),
  };
  for (const [name, body] of Object.entries(cases)) {
    const r = await upload('/api/admin/backups/import', body);
    assert.equal(r.status, 400, name);
    assert.ok((await r.json()).error, name);
  }
  // een te groot onderdeel wordt niet eens uitgepakt
  assert.match((await (await upload('/api/admin/backups/import', cases['logo te groot'])).json()).error, /te groot/);
  const newer = await upload('/api/admin/backups/import', cases['nieuwere versie']);
  assert.match((await newer.json()).error, /nieuwere versie van de app \(9\.9\.9\)/);
  assert.equal(backups.list().length, n);
  assert.deepEqual(fs.readdirSync(store.uploadDir).sort(), uploadsBefore);
  // alleen met een beheersessie
  assert.equal((await upload('/api/admin/backups/import', zip, '')).status, 401);
});

test('een backup op schijf met een beschadigd logo wordt niet teruggezet en verandert niets', async () => {
  const id = backups.list().find((x) => x.logos === 2).id;
  const file = path.join(BK, `sint_maarten-backup-${id}.zip`);
  const files = entries(fs.readFileSync(file));
  fs.writeFileSync(file, rezip({ ...files, 'files/logo.png': png(400, 100, 6) }));
  const before = JSON.stringify(await map());
  const n = backups.list().length;
  const r = await post(`/api/admin/backups/${id}/restore`, {});
  assert.equal(r.status, 400);
  assert.match((await r.json()).error, /beschadigd/);
  assert.equal(JSON.stringify(await map()), before);
  assert.equal(backups.list().length, n);
});

test('apparaten van bewoners en geblokkeerde apparaten gaan mee in de backup en komen terug', async () => {
  assert.equal((await put('/api/admin/settings', { residentsEnabled: true, residentsAppOnly: false, residentsCodeOn: false, residentsQrOnly: false, residentsGeofence: false })).status, 200);
  const d = (id, n) => ({ id, street: 'Apparaatstraat', number: n, status: 'none', points: sq });
  assert.equal((await put('/api/admin/houses', { houses: [d('d1', '1'), d('d2', '2')] })).status, 200);
  const claim = async (houseId) => {
    const r = await j('/api/resident/claim', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ houseId }) });
    assert.equal(r.status, 200);
    return { cookie: r.headers.get('set-cookie').split(';')[0], token: (await r.json()).deviceToken };
  };
  const me = async (c) => (await j('/api/resident/me', { headers: { cookie: c } })).json();
  const changes = async () => (await j('/api/admin/changes', { headers: { cookie } })).json();
  const a = await claim('d1');
  const b = await claim('d2');
  const rb = (await changes()).residents.find((r) => r.houseId === 'd2');
  assert.equal((await post(`/api/admin/residents/${rb.rid}/block`, {})).status, 200);
  await tick();
  assert.equal(backups.list()[0].reason, 'Apparaat geblokkeerd'); // blokkeren maakt een backup

  const { id } = await (await post('/api/admin/backups', { title: 'Met apparaten' })).json();
  const item = backups.list().find((x) => x.id === id);
  assert.deepEqual([item.devices, item.blocked], [1, 1]);
  const doc = docIn(await download(id));
  assert.equal(doc.devices[0].houseId, 'd1');
  assert.equal(doc.devices[0].tokenHash, sha(a.token)); // alleen de hash, zoals in de database
  assert.equal(doc.blocked[0].tokenHash, sha(b.token));
  assert.equal(doc.blocked[0].title, 'Apparaatstraat 2');
  const text = JSON.stringify(doc);
  assert.ok(!text.includes(a.token) && !text.includes(b.token));

  // het laatste gebruik van een apparaat is geen reden voor een nieuwe backup
  const n = backups.list().length;
  assert.equal((await j('/api/resident/set', { method: 'POST', headers: { 'Content-Type': 'application/json', cookie: a.cookie }, body: JSON.stringify({ status: 'green' }) })).status, 200);
  assert.equal((await j('/api/admin/view', { method: 'DELETE', headers: { cookie } })).status, 200); // was al leeg: niets veranderd
  await tick();
  assert.equal(backups.list().length, n);

  // ontkoppelen en deblokkeren maken elk een backup
  assert.equal((await j(`/api/admin/residents/${(await changes()).residents[0].rid}`, { method: 'DELETE', headers: { cookie } })).status, 200);
  assert.equal((await j(`/api/admin/blocks/${(await changes()).blocked[0].id}`, { method: 'DELETE', headers: { cookie } })).status, 200);
  await tick();
  assert.deepEqual(backups.list().slice(0, 2).map((x) => x.reason), ['Blokkade opgeheven', 'Apparaat ontkoppeld']);
  assert.equal((await me(a.cookie)).claim, null);
  assert.notEqual((await me(b.cookie)).blocked, true);

  // terugzetten: het apparaat is weer gekoppeld en het geblokkeerde apparaat weer geblokkeerd
  assert.equal((await post(`/api/admin/backups/${id}/restore`, {})).status, 200);
  assert.equal((await me(a.cookie)).claim.houseId, 'd1');
  assert.equal((await me(b.cookie)).blocked, true);
  const ch = await changes();
  assert.deepEqual([ch.residents.length, ch.blocked.length, ch.pending.length], [1, 1, 0]); // openstaande wijzigingen gaan niet mee

  // een backup van een kaart zonder dat huis: de koppeling verdwijnt bij terugzetten
  const legacyLike = { ...doc, houses: [d('d2', '2')] };
  delete legacyLike.logos;
  const up = await post('/api/admin/backups/import', legacyLike);
  assert.equal(up.status, 200);
  assert.equal((await post(`/api/admin/backups/${(await up.json()).id}/restore`, {})).status, 200);
  assert.equal((await changes()).residents.length, 0);

  // ongeldige apparaten of blokkades worden geweigerd
  const dev = doc.devices[0];
  for (const bad of [
    { devices: 'nee' }, { devices: [{ ...dev, tokenHash: 'x' }] }, { devices: [dev, dev] }, { devices: [{ ...dev, rid: '../x' }] },
    { devices: [{ ...dev, createdAt: 'gisteren' }] }, { devices: [{ ...dev, notice: { decision: 'misschien', status: 'green', at: dev.createdAt } }] },
    { blocked: 'nee' }, { blocked: [{ id: 'abcdefabcdef', at: dev.createdAt }] }, { blocked: [{ ...doc.blocked[0], tokenHash: 'kort' }] },
  ]) {
    const r = await post('/api/admin/backups/import', { ...doc, ...bad });
    assert.equal(r.status, 400, JSON.stringify(bad).slice(0, 80));
  }
});

test('een onleesbare backup blokkeert de lijst niet', async () => {
  const bad = '1700000000003-abcdef';
  fs.writeFileSync(path.join(BK, `sint_maarten-backup-${bad}.zip`), 'geen zip');
  const r = await j('/api/admin/backups', { headers: { cookie } });
  assert.equal(r.status, 200);
  const list = await r.json();
  assert.ok(list.length > 0 && !list.some((x) => x.id === bad));
  assert.equal((await post(`/api/admin/backups/${bad}/restore`, {})).status, 400);
});
