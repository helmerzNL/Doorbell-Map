#!/usr/bin/env node
// Maakt de screenshots voor de README (docs/screenshots) met de laatste versie van de app.
//
//   node tools/screenshots.js            alle screenshots
//   node tools/screenshots.js pdf qr     alleen de screenshots waarvan de naam dit bevat
//
// Het script start zelf een server met een tijdelijke datamap, maakt een passkey aan (virtuele WebAuthn-
// authenticator), zet voorbeeldgegevens klaar (echte gebouwen van de Loerikseweg uit OpenStreetMap, zie
// tools/screenshots/demo-houses.json) en fotografeert de pagina's met Playwright. Nodig: Chromium + Playwright,
// internet voor de kaarttegels, en `pdftoppm` (poppler) voor de PDF-afbeeldingen.
'use strict';
const { spawn, execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

let playwright;
try { playwright = require('playwright'); } catch { playwright = require(path.join(process.env.PLAYWRIGHT_MODULE || '/opt/node22/lib/node_modules', 'playwright')); }
const { chromium, request } = playwright;

const ROOT = path.join(__dirname, '..');
const OUT = path.join(ROOT, 'docs', 'screenshots');
const DEMO = path.join(__dirname, 'screenshots');
const PORT = 9878;
const BASE = `http://localhost:${PORT}`;
const TOKEN = 'screenshot-setup-token-123';
const only = process.argv.slice(2);
const wanted = (name) => !only.length || only.some((o) => name.includes(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const DESKTOP = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 1 };
const RETINA = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
const MOBILE = { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };

const INTRO = `Welkom bij de wijkkaart van onze wijkvereniging!

Op deze kaart zie je welke huizen graag bezoek krijgen aan de deur: groen = welkom, rood = liever niet.

Woon je zelf in de wijk? Dan kun je de status van je eigen huis aanpassen. De beheerder keurt dat goed.

Veel plezier!`;

let server; let dataDir;

async function startServer() {
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sm-shots-'));
  server = spawn('node', ['server/index.js'], {
    cwd: ROOT,
    env: { ...process.env, DATA_DIR: dataDir, PORT: String(PORT), ORIGIN: BASE, RP_ID: 'localhost', SETUP_TOKEN: TOKEN, SESSION_SECRET: 'screenshot-session-secret-123', PUSH_DELAY_MS: '50' },
    stdio: 'ignore',
  });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(`${BASE}/api/map`)).ok) return; } catch { /* nog niet klaar */ } await sleep(200); }
  throw new Error('server start niet');
}

const shot = async (page, name, opts = {}) => {
  if (!wanted(name)) return;
  fs.mkdirSync(OUT, { recursive: true });
  await page.screenshot({ path: path.join(OUT, `${name}.png`), ...opts });
  console.log('  ✓', name);
};

async function closeIntro(page) {
  await page.evaluate(() => { const d = document.getElementById('intro-dialog'); if (d && d.open) d.close(); });
}

const VIEW = { center: [52.02613, 5.16544], zoom: 19 };
// Schermpositie (Web Mercator) van een punt op de kaart die op VIEW is gecentreerd.
const merc = (lat, lng, z) => { const w = 256 * 2 ** z, s = Math.sin(lat * Math.PI / 180); return [(lng + 180) / 360 * w, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * w]; };
const insidePoly = (p, poly) => { let c = false; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [yi, xi] = poly[i], [yj, xj] = poly[j]; if ((yi > p[0]) !== (yj > p[0]) && p[1] < (xj - xi) * (p[0] - yi) / (yj - yi) + xi) c = !c; } return c; };
let HOUSES = [];
// Klikt (of dubbelklikt) het huis met deze titel (bv. "Loerikseweg 18") op de kaart in #vp.
async function clickHouse(page, title, how = 'click') {
  const h = HOUSES.find((x) => `${x.street} ${x.number}` === title);
  if (!h) throw new Error(`onbekend huis ${title}`);
  const n = h.points.length;
  let c = [h.points.reduce((a, q) => a + q[0], 0) / n, h.points.reduce((a, q) => a + q[1], 0) / n];
  if (!insidePoly(c, h.points)) c = [(h.points[0][0] * 3 + c[0]) / 4, (h.points[0][1] * 3 + c[1]) / 4];
  const [cx, cy] = merc(VIEW.center[0], VIEW.center[1], VIEW.zoom), [px, py] = merc(c[0], c[1], VIEW.zoom);
  const box = await page.locator('#vp').boundingBox();
  await page.mouse[how](box.x + box.width / 2 + (px - cx), box.y + box.height / 2 + (py - cy));
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  await startServer();
  const browser = await chromium.launch({ executablePath: fs.existsSync('/opt/pw-browsers/chromium-1194/chrome-linux/chrome') ? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome' : undefined });
  const hdr = { 'X-Geo-Device': 'desktop' };
  const ctxOpts = (o, extra = {}) => ({ ...o, locale: 'nl-NL', timezoneId: 'Europe/Amsterdam', ...extra });

  // ---------- onboarding en inloggen ----------
  const adminCtx = await browser.newContext(ctxOpts(DESKTOP));
  const ap = await adminCtx.newPage();
  const cdp = await adminCtx.newCDPSession(ap);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'internal', hasResidentKey: true, hasUserVerification: true, isUserVerified: true, automaticPresenceSimulation: true } });
  await ap.goto(`${BASE}/beheer`);
  await ap.waitForSelector('#v-setup:not(.hidden)');
  await ap.fill('#s-token', TOKEN);
  await shot(ap, 'onboarding');
  await ap.click('#s-go');
  await ap.waitForSelector('#v-edit:not(.hidden)');
  await ap.request.post(`${BASE}/api/auth/logout`, { data: {} });
  await ap.goto(`${BASE}/beheer`);
  await ap.waitForSelector('#v-login:not(.hidden)');
  await shot(ap, 'beheer-login');
  await ap.click('#l-go');
  await ap.waitForSelector('#v-edit:not(.hidden)');
  const put = async (url, data) => { const r = await ap.request.put(BASE + url, { data }); if (!r.ok()) throw new Error(`${url} ${r.status()} ${await r.text()}`); return r.json(); };
  const post = async (url, data) => { const r = await ap.request.post(BASE + url, { data: data || {} }); if (!r.ok()) throw new Error(`${url} ${r.status()} ${await r.text()}`); return r.json(); };

  // ---------- voorbeeldgegevens ----------
  const demo = JSON.parse(fs.readFileSync(path.join(DEMO, 'demo-houses.json'), 'utf8'));
  const cycle = ['green', 'red', 'green', 'green', 'red', 'none', 'green', 'red', 'green', 'none'];
  HOUSES = demo;
  const houses = demo.map((h, i) => ({ id: `h${i + 1}`, street: h.street, number: h.number, label: '', note: h.street === 'Loerikseweg' && h.number === '18' ? 'Nog geen reactie' : '', status: cycle[i % cycle.length], points: h.points }));
  const find = (street, number) => houses.find((h) => h.street === street && h.number === number);
  find('Loerikseweg', '14').status = 'green';
  find('Loerikseweg', '18').status = 'red';
  find('Loerikseweg', '20').status = 'green';
  await put('/api/admin/houses', { houses });
  await put('/api/admin/view', { center: VIEW.center, zoom: VIEW.zoom, minZoom: 15, maxZoom: 19, showNumbers: true });
  const logo = fs.readFileSync(path.join(DEMO, 'demo-logo.png'));
  const lr = await ap.request.post(`${BASE}/api/admin/logo`, { data: logo, headers: { 'Content-Type': 'application/octet-stream' } });
  if (!lr.ok()) throw new Error(`logo ${lr.status()}`);
  const baseSettings = { intro: INTRO, siteTitle: '', residentsEnabled: true, residentsAppOnly: false, residentsOff: false, residentsQrOnly: false, residentsCodeOn: false, residentsGeofence: false, multilingual: false, defaultLang: 'nl' };
  await put('/api/admin/settings', baseSettings);

  // bewoners: apparaten die een huis kozen, een paar wijzigingen die op goedkeuring wachten en een bericht
  const device = async () => request.newContext({ baseURL: BASE, extraHTTPHeaders: hdr });
  const residents = [['Loerikseweg', '14', 'red'], ['Loerikseweg', '15', 'green'], ['Loerikseweg', '17', null], ['Loerikseweg', '21', 'red'], ['Loerikseweg', '23', null], ['Loerikseweg', '9', null]];
  const devs = [];
  for (const [st, no, change] of residents) {
    const d = await device();
    const h = find(st, no);
    const c = await d.post('/api/resident/claim', { data: { houseId: h.id } });
    if (!c.ok()) throw new Error(`claim ${st} ${no} ${c.status()} ${await c.text()}`);
    if (change) { const s = await d.post('/api/resident/set', { data: { status: change } }); if (!s.ok()) throw new Error(`set ${s.status()} ${await s.text()}`); }
    devs.push(d);
    await sleep(30);
  }
  await devs[2].post('/api/resident/message', { data: { text: 'Ik heb een nieuwe telefoon: kunnen jullie de koppeling van mijn oude toestel verwijderen?' } });
  const ch = await (await ap.request.get(`${BASE}/api/admin/changes`)).json();
  const toBlock = ch.residents.find((r) => r.title === 'Loerikseweg 9');
  if (toBlock) await post(`/api/admin/residents/${toBlock.rid}/block`, { withIp: false });
  // een paar goedgekeurde wijzigingen zodat de lijst Goedkeuren niet te vol is
  const pend = (await (await ap.request.get(`${BASE}/api/admin/changes`)).json()).pending;
  if (pend.length > 2) await post(`/api/admin/changes/${pend[pend.length - 1].id}/approve`);
  await post('/api/admin/backups', { title: 'Alles, voor de actie' }).catch(() => {});

  const state = await adminCtx.storageState();

  // ---------- publieke site (desktop) ----------
  console.log('publiek');
  {
    const ctx = await browser.newContext(ctxOpts(DESKTOP));
    const p = await ctx.newPage();
    await p.goto(`${BASE}/`);
    await p.waitForSelector('#intro-dialog[open]', { timeout: 5000 }).catch(() => {});
    await shot(p, 'uitleg');
    await closeIntro(p);
    await p.waitForTimeout(1500);
    await clickHouse(p, 'Loerikseweg 18');
    await p.waitForTimeout(500);
    await shot(p, 'publiek');
    await p.keyboard.press('Escape');
    await p.click('#streets-btn');
    await p.waitForTimeout(400);
    await shot(p, 'straten-popup');
    await ctx.close();
  }

  // ---------- publieke site (mobiel) ----------
  console.log('mobiel');
  {
    const ctx = await browser.newContext(ctxOpts(MOBILE));
    const p = await ctx.newPage();
    await p.goto(`${BASE}/`);
    await p.waitForSelector('#intro-dialog[open]', { timeout: 5000 }).catch(() => {});
    await shot(p, 'info-vlak-mobiel');
    await closeIntro(p);
    await p.waitForTimeout(1500);
    await shot(p, 'mobiel');
    await p.click('#streets-btn');
    await p.waitForTimeout(400);
    await shot(p, 'straten-popup-mobiel');
    await p.click('#streets-close');
    await p.click('#more-btn');
    await p.waitForTimeout(300);
    await shot(p, 'bewerken-meer-mobiel');
    await ctx.close();
  }

  // ---------- bewoner: huis kiezen, wijzigen, app heropend ----------
  console.log('bewoner');
  {
    const ctx = await browser.newContext(ctxOpts(MOBILE, { extraHTTPHeaders: hdr }));
    const p = await ctx.newPage();
    await p.goto(`${BASE}/`);
    await p.waitForSelector('#intro-dialog[open]', { timeout: 5000 }).catch(() => {});
    await closeIntro(p);
    await p.click('#house-edit');
    await p.waitForTimeout(800);
    await shot(p, 'bewoner-kies-huis');
    // kies het eigen adres in de lijst en bevestig
    await p.selectOption('#house-sheet select', { label: 'Loerikseweg 19' });
    await p.waitForSelector('#claim-dialog[open]', { timeout: 4000 });
    await p.click('#claim-yes');
    await p.waitForTimeout(900);
    const btn = p.locator('#house-sheet button', { hasText: 'Rood' });
    if (await btn.count()) await btn.first().click();
    await p.waitForTimeout(800);
    await shot(p, 'bewoner-wacht');
    await p.reload();
    await p.waitForTimeout(1500);
    await closeIntro(p);
    await shot(p, 'bewoner-heropend');
    await ctx.close();
  }

  // ---------- beheer (desktop) ----------
  console.log('beheer');
  const admin = await browser.newContext(ctxOpts(DESKTOP, { storageState: state }));
  const a = await admin.newPage();
  const openAdmin = async (pg) => { await pg.goto(`${BASE}/beheer`); await pg.waitForSelector('#v-edit:not(.hidden)'); await pg.waitForTimeout(1500); };
  await openAdmin(a);
  await a.click('#edit-toggle');
  await a.waitForTimeout(600);
  await a.click('#t-draw');
  const box = await a.locator('#vp').boundingBox();
  const pts = [[430, 330], [520, 335], [525, 400], [440, 405]];
  for (const [x, y] of pts.slice(0, 3)) { await a.mouse.click(box.x + x, box.y + y); await sleep(120); }
  await a.mouse.move(box.x + 450, box.y + 395);
  await shot(a, 'beheer-tekenen');
  await a.keyboard.press('Escape');
  await a.click('#t-select');
  await clickHouse(a, 'Loerikseweg 14');
  await a.waitForTimeout(500);
  await shot(a, 'beheer');
  await a.click('#edit-toggle'); // terug naar de weergave
  await a.waitForTimeout(500);

  // popup bij dubbelklik (laptop, 2x)
  {
    const ctx = await browser.newContext(ctxOpts(RETINA, { storageState: state }));
    const p = await ctx.newPage();
    await openAdmin(p);
    await clickHouse(p, 'Loerikseweg 14', 'dblclick');
    await p.waitForSelector('#qr-dialog[open]');
    await p.waitForTimeout(1200);
    await shot(p, 'beheer-huis-popup');
    await ctx.close();
  }

  // QR-dialoog 1280x900
  {
    const ctx = await browser.newContext(ctxOpts({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 }, { storageState: state }));
    const p = await ctx.newPage();
    await openAdmin(p);
    await clickHouse(p, 'Loerikseweg 14', 'dblclick');
    await p.waitForSelector('#qr-dialog[open]');
    await p.waitForTimeout(1200);
    await shot(p, 'qr-dialoog');
    await ctx.close();
  }

  // instellingen
  const openTab = async (pg, tab) => { await pg.evaluate(() => { const s = document.getElementById('settings'); if (!s.classList.contains('open')) document.getElementById('settings-open').click(); }); await pg.click(`#settings [data-tab="${tab}"]`); await pg.evaluate(() => { document.querySelector('#settings .drawer-body').scrollTop = 0; }); await pg.waitForTimeout(700); };
  await openTab(a, 'changes');
  await shot(a, 'instellingen-goedkeuren');
  await openTab(a, 'residents');
  await shot(a, 'instellingen-bewoners');
  await a.evaluate(() => document.querySelector('#res-list').scrollIntoView({ block: 'start' }));
  await a.waitForTimeout(300);
  await shot(a, 'instellingen-bewoners-apparaten');
  await openTab(a, 'org');
  await shot(a, 'instellingen-config');
  await openTab(a, 'security');
  await shot(a, 'instellingen-beveiliging');
  await openTab(a, 'backups');
  await shot(a, 'instellingen-backups');

  // QR-instellingen (1280x900): QR-modus aan, dan de kaart "Toegang via QR-code"
  await put('/api/admin/settings', { residentsQrOnly: true });
  {
    const ctx = await browser.newContext(ctxOpts({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 }, { storageState: state }));
    const p = await ctx.newPage();
    await openAdmin(p);
    await openTab(p, 'residents');
    await p.evaluate(() => { const el = document.getElementById('res-qr-only'); el.closest('.set-card').scrollIntoView({ block: 'start' }); });
    await p.waitForTimeout(400);
    await shot(p, 'qr-instellingen');
    await ctx.close();
  }

  // PDF's: kaart en QR-kaartjes
  console.log('pdf');
  const pdfPage = async (data, name, resolution) => {
    if (!wanted(name)) return;
    const f = path.join(os.tmpdir(), `sm-${name}.pdf`);
    fs.writeFileSync(f, Buffer.from(data.split(',')[1], 'base64'));
    const prefix = path.join(os.tmpdir(), `sm-${name}`);
    execFileSync('pdftoppm', ['-r', String(resolution), '-png', f, prefix]);
    const files = fs.readdirSync(os.tmpdir()).filter((x) => x.startsWith(`sm-${name}-`) && x.endsWith('.png')).sort();
    return files.map((x) => path.join(os.tmpdir(), x));
  };
  {
    const p = await (await browser.newContext(ctxOpts(DESKTOP))).newPage();
    await p.goto(`${BASE}/`);
    await p.waitForFunction(() => window.Wijk && window.jspdf);
    await closeIntro(p);
    await p.waitForTimeout(1500);
    const data = await p.evaluate(async () => {
      const d = await fetch('/api/map').then((r) => r.json());
      const doc = await Wijk.buildPdf({ title: d.title, houses: d.houses, view: d.view, intro: d.intro, logo: d.logo, showNumbers: true });
      return doc.output('datauristring');
    });
    const files = await pdfPage(data, 'pdf', 110);
    if (files) { fs.copyFileSync(files[0], path.join(OUT, 'pdf.png')); console.log('  ✓ pdf'); if (files[1]) { fs.copyFileSync(files[1], path.join(OUT, 'pdf-toelichting.png')); console.log('  ✓ pdf-toelichting'); } }
  }
  {
    const p = await (await browser.newContext(ctxOpts(DESKTOP, { storageState: state }))).newPage();
    await openAdmin(p);
    const data = await p.evaluate(async () => {
      const items = await fetch('/api/admin/qr').then((r) => r.json());
      const m = await fetch('/api/map').then((r) => r.json());
      const doc = await Wijk.buildQrPdf({ title: m.title, items: items.filter((i) => i.street === 'Loerikseweg').slice(8, 16), logo: m.logo });
      return doc.output('datauristring');
    });
    const files = await pdfPage(data, 'qr-pdf', 110);
    if (files) {
      execFileSync('python3', ['-c', `from PIL import Image; im=Image.open(${JSON.stringify(files[0])}); w,h=im.size; im=im.crop((0,0,w,int(h*0.5))); im.save(${JSON.stringify(path.join(OUT, 'qr-pdf.png'))})`]);
      console.log('  ✓ qr-pdf');
    }
  }

  // bewoner: QR scannen (bevestigen) en zonder QR (QR-only)
  console.log('qr');
  {
    const items = await (await ap.request.get(`${BASE}/api/admin/qr`)).json();
    const it = items.find((i) => i.title === 'Loerikseweg 13') || items.find((i) => !i.taken);
    const ctx = await browser.newContext(ctxOpts(MOBILE, { extraHTTPHeaders: hdr }));
    const p = await ctx.newPage();
    await p.addInitScript(() => { try { localStorage.setItem('sm-intro-seen', 'x'); } catch { /* geen opslag */ } });
    await p.goto(it.url.replace(/^https?:\/\/[^/]+/, BASE));
    await p.waitForSelector('#claim-dialog[open]', { timeout: 6000 }).catch(() => {});
    await p.waitForTimeout(800);
    await shot(p, 'qr-bevestigen');
    await ctx.close();
    const ctx2 = await browser.newContext(ctxOpts(MOBILE, { extraHTTPHeaders: hdr }));
    const p2 = await ctx2.newPage();
    await p2.goto(`${BASE}/`);
    await p2.waitForSelector('#intro-dialog[open]', { timeout: 5000 }).catch(() => {});
    await closeIntro(p2);
    await p2.click('#house-edit');
    await p2.waitForTimeout(900);
    await shot(p2, 'qr-zonder-scan');
    await ctx2.close();
  }
  await put('/api/admin/settings', { residentsQrOnly: false });

  // ---------- beheer (mobiel) ----------
  console.log('beheer mobiel');
  {
    const ctx = await browser.newContext(ctxOpts(MOBILE, { storageState: state }));
    const p = await ctx.newPage();
    await openAdmin(p);
    await shot(p, 'beheer-weergave-mobiel');
    await clickHouse(p, 'Loerikseweg 14', 'dblclick').catch(() => {});
    await p.waitForSelector('#qr-dialog[open]', { timeout: 5000 }).catch(() => {});
    await p.waitForTimeout(1200);
    await shot(p, 'beheer-huis-popup-mobiel');
    await p.evaluate(() => document.getElementById('qr-dialog').close());
    await p.waitForTimeout(300);
    await openTab(p, 'changes');
    await shot(p, 'instellingen-mobiel', { clip: { x: 0, y: 0, width: 390, height: 800 } });
    await ctx.close();
  }

  // ---------- Mijn locatie, community, installeren en de instellingen daarvoor ----------
  console.log('locatie en community');
  const HERE = { latitude: 52.02605, longitude: 5.16535, accuracy: 18 };
  const geo = { geolocation: HERE, permissions: ['geolocation'] };
  const seen = () => { try { localStorage.setItem('sm-intro-seen', 'x'); } catch { /* geen opslag */ } };
  // Andere deelnemers van de community (alleen coördinaten, kleur en symbool); ze verlopen na 45 s, dus vlak voor elke foto opnieuw.
  const PEERS = [
    ['screenshot-peer-000000001', 52.02634, 5.16572, '#e67e22', 'dog'], ['screenshot-peer-000000002', 52.02588, 5.16611, '#2980b9', 'bike'],
    ['screenshot-peer-000000003', 52.02641, 5.16506, '#e84393', 'cat'], ['screenshot-peer-000000004', 52.02572, 5.16548, '#00a8a8', ''],
  ];
  const pingPeers = async () => { for (const [id, lat, lng, color, icon] of PEERS) await ap.request.post(`${BASE}/api/community/ping`, { data: { id, lat, lng, acc: 15, color, icon } }); };
  // Opent de publieke kaart en sluit de uitleg (die staat anders open en houdt de locatie tegen).
  const openPublic = async (p) => { await p.goto(`${BASE}/`); await p.waitForSelector('#intro-dialog[open]', { timeout: 5000 }).catch(() => {}); await closeIntro(p); };
  const MIJN_LOCATIE = { viewport: { width: 390, height: 780 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true };
  {
    const ctx = await browser.newContext(ctxOpts(MIJN_LOCATIE, geo));
    await ctx.addInitScript(seen);
    const p = await ctx.newPage();
    await openPublic(p);
    await p.waitForSelector('.locate-btn.on', { timeout: 10000 });
    await p.waitForTimeout(2500);
    await shot(p, 'mijn-locatie-mobiel');
    await ctx.close();
  }
  await put('/api/admin/settings', { communityEnabled: true, communityLooks: true });
  {
    const ctx = await browser.newContext(ctxOpts(MIJN_LOCATIE, geo));
    await ctx.addInitScript(seen);
    const p = await ctx.newPage();
    await openPublic(p);
    await p.waitForSelector('.community-btn', { timeout: 10000 });
    await p.waitForTimeout(1500);
    await p.click('.community-btn');
    await p.waitForSelector('#community-dialog[open]', { timeout: 5000 });
    await p.click('#community-colors .look-btn:nth-child(3)');
    await p.click('#community-icons .look-btn:nth-child(5)');
    await p.waitForTimeout(400);
    await shot(p, 'community-venster-mobiel');
    await p.click('#community-yes');
    await pingPeers();
    await p.waitForTimeout(500);
    await pingPeers();
    await p.waitForTimeout(6000);
    await pingPeers();
    await p.waitForTimeout(4000);
    await shot(p, 'community-kaart-mobiel');
    await ctx.close();
  }
  {
    // beheer: alle deelnemers als stippen, het aantal in de zijbalk
    const ctx = await browser.newContext(ctxOpts(DESKTOP, { storageState: state }));
    const p = await ctx.newPage();
    await openAdmin(p);
    await pingPeers();
    await p.waitForTimeout(6000);
    await pingPeers();
    await p.waitForTimeout(3000);
    await shot(p, 'beheer-community');
    await ctx.close();
  }
  // instellingen: knop Mijn locatie, community en de afbeeldingen (klein logo en favicon)
  for (const route of ['logo-small', 'favicon']) {
    const r = await ap.request.post(`${BASE}/api/admin/${route}`, { data: logo, headers: { 'Content-Type': 'application/octet-stream' } });
    if (!r.ok()) throw new Error(`${route} ${r.status()}`);
  }
  {
    const ctx = await browser.newContext(ctxOpts({ viewport: { width: 1280, height: 900 }, deviceScaleFactor: 1 }, { storageState: state }));
    const p = await ctx.newPage();
    await openAdmin(p);
    await openTab(p, 'org');
    await p.evaluate(() => document.getElementById('org-logo-small').closest('.set-card').scrollIntoView({ block: 'start' }));
    await p.waitForTimeout(400);
    await shot(p, 'instellingen-config-afbeeldingen');
    await p.evaluate(() => document.getElementById('org-locate').closest('.set-card').scrollIntoView({ block: 'start' }));
    await p.waitForTimeout(400);
    await shot(p, 'instellingen-config-locatie');
    await p.evaluate(() => document.getElementById('org-community-default').scrollIntoView({ block: 'center' }));
    await p.waitForTimeout(400);
    await shot(p, 'instellingen-config-communityteksten');
    await ctx.close();
  }
  for (const route of ['logo-small', 'favicon']) await ap.request.delete(`${BASE}/api/admin/${route}`);
  await put('/api/admin/settings', { communityEnabled: false });
  // totaalblok op de voorpagina met de knop om het te verbergen
  await put('/api/admin/settings', { statsPublic: true });
  {
    const ctx = await browser.newContext(ctxOpts(DESKTOP));
    await ctx.addInitScript(seen);
    const p = await ctx.newPage();
    await openPublic(p);
    await p.waitForSelector('.stats-btn:not([hidden])', { timeout: 10000 });
    await p.waitForTimeout(1500);
    await shot(p, 'voorpagina-totaal');
    await p.click('.stats-btn');
    await p.waitForTimeout(500);
    await shot(p, 'voorpagina-totaal-verborgen');
    await ctx.close();
  }
  await put('/api/admin/settings', { statsPublic: false });
  // de knop Installeer in de menubalk (er opent niets vanzelf) en het venster met de stappen per platform
  const PLATFORMS = {
    ios: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1',
    android: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36',
  };
  for (const [name, userAgent] of Object.entries(PLATFORMS)) {
    if (!wanted(`installatiemelding-${name}`)) continue;
    const ctx = await browser.newContext(ctxOpts({ ...MOBILE, userAgent }));
    const p = await ctx.newPage();
    await openPublic(p);
    await p.waitForSelector('#install-btn:not([hidden])', { timeout: 5000 });
    await p.click('#install-btn');
    await p.waitForSelector('#install-dialog[open]', { timeout: 5000 });
    await p.waitForTimeout(600);
    await shot(p, `installatiemelding-${name}`);
    await ctx.close();
  }

  // ---------- meertalig en donker: Config met taalbalk en de Engelse/donkere site ----------
  console.log('talen');
  await put('/api/admin/settings', { multilingual: true, defaultLang: 'nl', translations: { en: { siteTitle: 'Our neighbourhood', intro: 'Welcome to the neighbourhood map of our association! Green houses are happy to receive visitors, red houses prefer not.', labels: { green: '', red: '', none: '' } } } });
  {
    const ctx = await browser.newContext(ctxOpts(DESKTOP, { storageState: state }));
    const p = await ctx.newPage();
    await openAdmin(p);
    await openTab(p, 'org');
    await p.evaluate(() => document.getElementById('cfg-langbar').scrollIntoView({ block: 'start' }));
    await p.waitForTimeout(300);
    await p.click('#cfg-langbar button[data-lang="en"]');
    await p.waitForTimeout(400);
    await shot(p, 'instellingen-config-talen');
    await ctx.close();
  }
  {
    const ctx = await browser.newContext(ctxOpts(DESKTOP));
    await ctx.addInitScript(() => { try { localStorage.setItem('sm-lang', 'en'); localStorage.setItem('sm-intro-seen', 'x'); } catch { /* geen opslag */ } });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/`);
    await p.waitForTimeout(1800);
    await closeIntro(p);
    await clickHouse(p, 'Loerikseweg 20');
    await p.click('.lang-btn');
    await p.waitForTimeout(300);
    await shot(p, 'publiek-engels-taalmenu');
    await p.keyboard.press('Escape');
    await ctx.close();
  }
  {
    const ctx = await browser.newContext(ctxOpts(MOBILE));
    await ctx.addInitScript(() => { try { localStorage.setItem('sm-lang', 'en'); localStorage.setItem('sm-theme', 'dark'); localStorage.setItem('sm-intro-seen', 'x'); } catch { /* geen opslag */ } });
    const p = await ctx.newPage();
    await p.goto(`${BASE}/`);
    await p.waitForTimeout(1800);
    await closeIntro(p);
    await shot(p, 'mobiel-engels-donker');
    await ctx.close();
  }

  await browser.close();
}

main().catch((e) => { console.error(e); process.exitCode = 1; }).finally(() => {
  if (server) server.kill();
  if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
});
