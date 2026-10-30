(async () => {
  const $ = (id) => document.getElementById(id);
  const getData = async () => I18n.localize(await (await fetch('/api/map', { cache: 'no-cache' })).json()); // teksten in de gekozen taal
  let data = await getData();

  I18n.mountPrefs($('prefs'));

  // ---------- kop, logo en uitleg ----------
  function applyMeta(first) {
    Wijk.setLabels(data.labels);
    Wijk.setHeading($('title'), data.title);
    document.title = Wijk.docTitle(data.title);
    const iosTitle = data.appShortName || data.appName || data.title;
    document.querySelector('meta[name="apple-mobile-web-app-title"]')?.setAttribute('content', iosTitle);

    const headerLogo = data.logoSmall || data.logo; // het kleine logo is bedoeld voor de kopbalk; zonder valt het terug op het gewone logo
    // Favicon en iOS-beginschermicoon volgen het kleine logo; zonder valt het terug op de standaardlantaarn.
    for (const rel of ['icon', 'apple-touch-icon']) {
      const link = document.querySelector(`link[rel="${rel}"]`);
      if (!link) continue;
      link.dataset.default ??= JSON.stringify({ href: link.getAttribute('href'), sizes: link.getAttribute('sizes') });
      const def = JSON.parse(link.dataset.default);
      link.setAttribute('href', data.logoSmall ? data.logoSmall.url : def.href);
      if (data.logoSmall || !def.sizes) link.removeAttribute('sizes'); else link.setAttribute('sizes', def.sizes); // het formaat van het kleine logo is niet bekend
    }
    if (headerLogo) {
      $('logo').src = headerLogo.url;
      $('logo').alt = `Logo ${data.title}`;
      $('logo').hidden = false;
    } else {
      $('logo').hidden = true;
    }

    document.body.classList.toggle('simple-ui', data.simpleUi === true); // eenvoudige weergave: geen huisnummers/Bewerken/straten
    const intro = data.intro;
    const info = data.residentInfo || ''; // leeg zodra wijzigen door bewoners uit staat
    $('intro-btn').hidden = !(intro || info);
    $('intro-info').hidden = !info;
    $('intro-info-text').textContent = info;
    $('intro-text').hidden = !intro;
    if (intro || info) {
      $('intro-title').textContent = data.title;
      $('intro-text').textContent = intro; // platte tekst; alinea's via CSS
      $('intro-btn').onclick = () => $('intro-dialog').showModal();
      $('intro-close').onclick = $('intro-x').onclick = () => $('intro-dialog').close();
      // de eerste keer (of na een wijziging van de tekst) automatisch tonen
      if (first) {
        let seen = '';
        const key = 'sm-intro-seen';
        const all = intro + info;
        const hash = String(all.length) + ':' + all.slice(0, 40);
        try { seen = localStorage.getItem(key); } catch {}
        if (seen !== hash) {
          $('intro-dialog').showModal();
          try { localStorage.setItem(key, hash); } catch {}
        }
      }
    }
  }
  applyMeta(true);

  const map = Wijk.createMap($('vp'), data.view, data.houses);
  Wijk.map = map;
  const nums = Wijk.createNumberLayer(map);

  // ---------- huizen, straten en aantallen (opnieuw op te bouwen bij een verversing) ----------
  const OTHER = '';
  const streetName = (h) => h.street || OTHER;
  const hidden = new Set(); // verborgen straten (keuze wordt onthouden)
  try { JSON.parse(localStorage.getItem('sm-hidden-streets') || '[]').forEach((x) => hidden.add(x)); } catch {}
  let shownHouses = [];
  let streets = [];
  const polys = new Map(); // huis-id -> polygoon
  const rows = new Map(); // straat -> schakelaar in de popup

  const visibleHouses = () => shownHouses.filter((h) => !hidden.has(streetName(h)));
  const tally = (list) => ({ green: list.filter((h) => h.status === 'green').length, red: list.filter((h) => h.status === 'red').length });
  // "● 5 ● 2" met schermlezer-tekst
  const tallyEl = (t, cls) => {
    const el = document.createElement('span');
    el.className = cls;
    el.setAttribute('aria-label', `${t.green} ${Wijk.STATUS.green.name.toLowerCase()}, ${t.red} ${Wijk.STATUS.red.name.toLowerCase()}`);
    for (const k of ['green', 'red']) {
      const part = document.createElement('span');
      part.setAttribute('aria-hidden', 'true');
      const dot = document.createElement('i'); dot.className = `dot ${k}`;
      part.append(dot, String(t[k]));
      el.append(part);
    }
    return el;
  };
  const renderTotal = () => {
    const box = $('streets-total');
    if (box) box.replaceChildren('Totaal op de kaart: ', tallyEl(tally(visibleHouses()), 'street-tally'));
  };

  function applyStreets() {
    for (const h of shownHouses) {
      const poly = polys.get(h.id);
      const show = !hidden.has(streetName(h));
      if (show && !map.hasLayer(poly)) poly.addTo(map);
      if (!show && map.hasLayer(poly)) { poly.closePopup(); map.removeLayer(poly); }
    }
    nums.rebuild(visibleHouses());
    renderTotal();
    try { localStorage.setItem('sm-hidden-streets', JSON.stringify([...hidden])); } catch {}
  }

  function buildHouses() {
    polys.forEach((p) => map.removeLayer(p));
    polys.clear();
    shownHouses = data.houses.filter((h) => h.status !== 'none');
    if (data.statsPublic) Wijk.renderStats(data.houses, data.statsShow); else $('house-stats').hidden = true;
    for (const h of shownHouses) {
      const poly = L.polygon(h.points, Wijk.houseStyle(h.status));
      const box = document.createElement('div');
      const t = document.createElement('strong');
      t.textContent = Wijk.houseTitle(h);
      box.append(t, document.createElement('br'), `${Wijk.STATUS[h.status].name}${h.note ? ' · ' + h.note : ''}`);
      poly.bindPopup(box);
      polys.set(h.id, poly);
    }
    streets = [...new Set(shownHouses.map(streetName))].sort((a, b) => (a === OTHER) - (b === OTHER) || Wijk.natCompare(a, b));

    // straten-popup
    const list = $('streets-list');
    list.replaceChildren();
    rows.clear();
    for (const name of streets) {
      const t = tally(shownHouses.filter((h) => streetName(h) === name));
      const row = document.createElement('label');
      row.className = 'street-row';
      const cb = document.createElement('input');
      cb.type = 'checkbox'; cb.setAttribute('role', 'switch'); cb.checked = !hidden.has(name);
      cb.onchange = () => { cb.checked ? hidden.delete(name) : hidden.add(name); applyStreets(); };
      const track = document.createElement('span'); track.className = 'track'; track.setAttribute('aria-hidden', 'true');
      const thumb = document.createElement('span'); thumb.className = 'thumb'; track.append(thumb);
      const text = document.createElement('span'); text.className = 'street-name'; text.textContent = name || 'Overige huizen';
      row.append(cb, track, text, tallyEl(t, 'street-tally'));
      list.append(row);
      rows.set(name, cb);
    }
    $('streets-btn').hidden = !(streets.length > 1 || (streets.length === 1 && streets[0] !== OTHER));
    applyStreets();
  }

  const setAll = (on) => { streets.forEach((x) => { on ? hidden.delete(x) : hidden.add(x); rows.get(x).checked = on; }); applyStreets(); };
  $('streets-all').onclick = () => setAll(true);
  $('streets-none').onclick = () => setAll(false);
  $('streets-btn').onclick = () => $('streets-dialog').showModal();
  $('streets-close').onclick = () => $('streets-dialog').close();

  // huisnummers (schakelaar in de menubalk; keuze wordt onthouden, de beheerder bepaalt de standaard)
  let pref = null;
  try { pref = localStorage.getItem('sm-numbers'); } catch {}
  $('num-switch').checked = pref === null ? !!data.view?.showNumbers : pref === '1';
  $('num-switch').onchange = () => {
    nums.setVisible($('num-switch').checked);
    try { localStorage.setItem('sm-numbers', $('num-switch').checked ? '1' : '0'); } catch {}
  };

  buildHouses();
  nums.setVisible($('num-switch').checked);

  // bewoners: Mijn huis. In de geïnstalleerde app staat de knop er altijd; in de browser
  // verschijnt hij na de schakelaar "Bewerken" (dan gaan PDF opslaan en Installeer app naar "Meer").
  const residentsOn = data.residentsEnabled !== false;
  const residentReady = Wijk.initResident?.({ map, houses: data.houses, enabled: residentsOn, mode: data.residentsMode, geofence: data.geofence, deviceCode: data.deviceCode, qrOnly: data.qrOnly });
  // QR-code uit de brief: ?q=... meteen uit de adresbalk halen en verwerken
  const qrParam = new URLSearchParams(location.search).get('q');
  if (qrParam) {
    history.replaceState(null, '', location.pathname + location.hash);
    Promise.resolve(residentReady).then(() => (Wijk.claimFromQr ? Wijk.claimFromQr(qrParam) : Wijk.toast('Wijzigen door bewoners staat uit.')));
  }
  const inApp = window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || window.navigator.standalone === true;

  const bar = document.querySelector('.actions');
  const moreBtn = $('more-btn'), pop = $('more-pop');
  const moved = ['pdf-view', 'pdf-dl'].map($);
  const closeMore = () => { pop.hidden = true; moreBtn.setAttribute('aria-expanded', 'false'); };
  const toggleMore = () => {
    pop.hidden = !pop.hidden;
    moreBtn.setAttribute('aria-expanded', String(!pop.hidden));
  };
  moreBtn.onclick = (e) => { e.stopPropagation(); toggleMore(); };
  pop.addEventListener('click', (e) => { if (e.target.closest('button')) setTimeout(closeMore, 0); });
  document.addEventListener('click', (e) => { if (!pop.hidden && !pop.contains(e.target)) closeMore(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) { closeMore(); moreBtn.focus(); } });

  // PDF opslaan/bekijken staan altijd onder "Meer".
  // In de eenvoudige weergave staan ze juist in de menubalk (naast Uitleg en Mijn huis) en vervalt "Meer".
  function layoutMenu() {
    if (data.simpleUi) { closeMore(); moved.forEach((b) => bar.insertBefore(b, moreBtn)); moreBtn.hidden = true; }
    else { moved.forEach((b) => pop.append(b)); moreBtn.hidden = false; }
  }
  layoutMenu();

  function setEditing(on) {
    document.body.classList.toggle('edit-mode', on);
    $('house-edit').hidden = !on || !!Wijk.residentNoAccess?.();
    if (!on) Wijk.leaveResident?.(); // wijzigmodus en venster sluiten
  }
  // De beheerder kan Bewerken in de browser uitzetten (alleen de geïnstalleerde app mag dan wijzigen).
  $('edit-switch').onchange = () => setEditing($('edit-switch').checked);
  // Bewerken staat standaard aan (de keuze van de bezoeker om het uit te zetten wordt onthouden).
  const EDIT_KEY = 'sm-edit-off';
  const editPref = () => { if (data.simpleUi) return true; try { return localStorage.getItem(EDIT_KEY) !== '1'; } catch { return true; } };
  let editDefaulted = false;
  $('edit-switch').addEventListener('change', () => { try { localStorage.setItem(EDIT_KEY, $('edit-switch').checked ? '0' : '1'); } catch {} });
  function applyEditUi() {
    layoutMenu();
    const allowed = data.residentsEnabled !== false && !inApp && !data.residentsAppOnly && !Wijk.residentNoAccess?.();
    $('edit-switch-wrap').hidden = !allowed;
    if (!allowed) {
      editDefaulted = false;
      if ($('edit-switch').checked) { $('edit-switch').checked = false; setEditing(false); }
    } else if (!editDefaulted || (data.simpleUi && !$('edit-switch').checked)) {
      editDefaulted = true;
      if (editPref()) { $('edit-switch').checked = true; setEditing(true); }
    }
  }
  applyEditUi();
  window.addEventListener('sm-resident', () => { applyEditUi(); if (inApp) $('house-edit').hidden = !!Wijk.residentNoAccess?.(); });

  // Dubbelklik (muis) op een huis: Bewerken aan en dit huis selecteren. Elders zoomt een dubbelklik gewoon in.
  const insidePoly = (pt, poly) => {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [yi, xi] = poly[i], [yj, xj] = poly[j];
      if ((yi > pt.lat) !== (yj > pt.lat) && pt.lng < ((xj - xi) * (pt.lat - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  // Bewerken aan + huis selecteren; false als hier geen huis is of wijzigen niet kan.
  function editHouseAt(latlng) {
    const house = data.houses.find((h) => insidePoly(latlng, h.points));
    const allowed = data.residentsEnabled !== false && (inApp || !data.residentsAppOnly);
    if (!house || !allowed || !Wijk.selectResidentHouse) return false;
    map.closePopup();
    if (!inApp && !$('edit-switch').checked) { $('edit-switch').checked = true; setEditing(true); }
    Wijk.selectResidentHouse(house.id);
    return true;
  }
  map.doubleClickZoom.disable();
  map.on('dblclick', (e) => {
    if (matchMedia('(pointer: fine)').matches && editHouseAt(e.latlng)) return;
    map.setZoomAround(e.latlng, map.getZoom() + (e.originalEvent.shiftKey ? -1 : 1));
  });

  // Touchscreen: lang indrukken op een huis doet hetzelfde als dubbelklikken met de muis.
  {
    const el = map.getContainer();
    let timer = null, start = null, swallow = false;
    const cancel = () => { clearTimeout(timer); timer = null; };
    el.addEventListener('pointerdown', (e) => {
      cancel();
      if (e.pointerType !== 'touch' || !e.isPrimary) return;
      start = { x: e.clientX, y: e.clientY };
      timer = setTimeout(() => {
        timer = null;
        const r = el.getBoundingClientRect();
        const latlng = map.containerPointToLatLng([start.x - r.left, start.y - r.top]);
        if (editHouseAt(latlng)) { swallow = true; setTimeout(() => { swallow = false; }, 800); navigator.vibrate?.(30); }
      }, 600);
    });
    el.addEventListener('pointermove', (e) => { if (timer && Math.hypot(e.clientX - start.x, e.clientY - start.y) > 10) cancel(); });
    for (const t of ['pointerup', 'pointercancel']) el.addEventListener(t, cancel);
    // de klik/het contextmenu dat op het loslaten volgt mag geen popup of selectie veroorzaken
    for (const t of ['click', 'contextmenu']) el.addEventListener(t, (e) => { if (swallow) { e.preventDefault(); e.stopPropagation(); } }, true);
  }

  // ---------- automatisch verversen (o.a. nadat de beheerder een wijziging goedkeurt) ----------
  const signature = (d) => JSON.stringify([d.houses, d.labels, d.title, d.intro, d.translations, d.multilingual, d.defaultLang, d.logo, d.logoSmall, d.appName, d.appShortName, d.residentsEnabled, d.residentsMode, d.geofence, d.deviceCode, d.qrOnly, d.residentsAppOnly, d.residentInfo, d.simpleUi, d.statsPublic, d.statsShow]);
  let lastSig = signature(data);
  let busy = false;
  let lastSync = new Date();
  // manual = true: door de gebruiker gevraagd (sync-knop): ook als de pagina op de achtergrond staat, met terugmelding
  async function refresh(manual) {
    if (busy) return false;
    if (!manual && (document.hidden || !navigator.onLine)) return false;
    if (manual && !navigator.onLine) { Wijk.toast('Geen verbinding'); return false; }
    busy = true;
    let ok = false, changed = false;
    try {
      const next = await getData();
      if (signature(next) !== lastSig) {
        lastSig = signature(next);
        data = next;
        applyMeta(false);
        buildHouses();
        Wijk.setResidentMode?.(data.residentsMode);
        Wijk.setResidentGeofence?.(data.geofence);
        Wijk.setResidentCode?.(data.deviceCode);
        Wijk.setResidentQrOnly?.(data.qrOnly);
        applyEditUi();
        changed = true;
      }
      // ook de eigen status (en een uitslag van de beheerder) opnieuw ophalen
      await Wijk.refreshResident?.(data.houses);
      lastSync = new Date();
      ok = true;
    } catch { /* offline of server even weg: volgende poging */ }
    busy = false;
    if (manual) Wijk.toast(ok ? (changed ? 'Bijgewerkt ✔' : 'Alles is up-to-date ✔') : 'Bijwerken mislukt, probeer het later opnieuw');
    return ok;
  }
  setInterval(() => refresh(), 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  window.addEventListener('online', () => refresh());
  window.addEventListener('pageshow', (e) => { if (e.persisted) refresh(); });
  Wijk.refresh = refresh;

  // sync-knop (alleen in de geïnstalleerde app)
  if (inApp) {
    const sync = $('sync-btn');
    sync.hidden = false;
    sync.onclick = async () => {
      sync.classList.add('sync-spin');
      sync.disabled = true;
      await refresh(true);
      sync.disabled = false;
      sync.classList.remove('sync-spin');
      sync.title = `Huizen bijwerken (laatst bijgewerkt ${lastSync.toLocaleTimeString(I18n.locale, { hour: '2-digit', minute: '2-digit' })})`;
    };
  }

  // kaart alvast klaarzetten voor offline gebruik
  if (navigator.serviceWorker) navigator.serviceWorker.ready.then(() => Wijk.prefetchTiles(data.houses, data.view, data.pdfView));

  // ---------- PDF ----------
  const pdfName = () => `${data.title.replace(/[^\w-]+/g, '-')}.pdf`;
  const pdfButtons = ['pdf-view', 'pdf-dl'].map($);
  async function run(btn, fn) {
    const html = btn.innerHTML;
    pdfButtons.forEach((b) => (b.disabled = true));
    btn.innerHTML = `<span class="ico">${MDI.html('timer-sand')}</span><span class="lbl">Bezig…</span>`;
    try { await fn(); }
    catch (e) { alert(I18n.tr('PDF maken mislukt: ' + e.message)); }
    finally { btn.innerHTML = html; pdfButtons.forEach((b) => (b.disabled = false)); }
  }
  const make = () => Wijk.buildPdf({ title: data.title, houses: data.houses.filter((h) => h.status === 'none' || !hidden.has(streetName(h))), view: data.view, pdfView: data.pdfView, intro: data.intro, logo: data.logo, showNumbers: $('num-switch').checked });

  $('pdf-dl').onclick = (e) => run(e.currentTarget, async () => (await make()).save(pdfName()));
  $('pdf-view').onclick = (e) => {
    const win = window.open('', '_blank'); // synchroon openen i.v.m. pop-up blokkers
    run(e.currentTarget, async () => {
      const url = (await make()).output('bloburl');
      if (win) win.location.href = url; else location.href = url;
    });
  };
})();
