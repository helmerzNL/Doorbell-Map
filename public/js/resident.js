// "Mijn huis": in de geïnstalleerde app (of in de browser na de schakelaar "Bewerken") kiest een bewoner één huis (per apparaat) en stelt een
// nieuwe status voor (niet gemarkeerd → groen → rood; de namen zijn instelbaar). De beheerder moet dat goedkeuren.
(function () {
  const ORDER = ['none', 'green', 'red'];
  const cycle = (s) => ORDER[(ORDER.indexOf(s) + 1) % ORDER.length];
  const NAME = new Proxy({}, { get: (_, k) => Wijk.STATUS[k]?.name }); // volgt de instelbare namen
  const $ = (id) => document.getElementById(id);

  const isInstalledApp = Wijk.isInstalledApp = () => window.matchMedia('(display-mode: standalone)').matches
    || window.matchMedia('(display-mode: fullscreen)').matches || window.navigator.standalone === true;

  // ---- geofence: de beheerder kan wijzigen beperken tot mensen die (volgens GPS/wifi-locatie) in de wijk zijn ----
  let geo = null; // { center: [lat, lng], radius } of null
  let codeRequired = false; // de beheerder vraagt een toegangscode voor apparaten zonder GPS
  let codeOk = false; // dit apparaat heeft de code al ingevuld (cookie)
  let qrOnly = false; // een huis kiezen kan alleen met de QR-code uit de brief
  let fix = null; // laatste bepaalde positie
  const distanceM = (a, b) => {
    const rad = (x) => (x * Math.PI) / 180, dLat = rad(b[0] - a[0]), dLng = rad(b[1] - a[1]);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a[0])) * Math.cos(rad(b[0])) * Math.sin(dLng / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.sqrt(h));
  };
  // Alleen telefoons/tablets hebben GPS. Laptops en desktops worden niet door de geofence beperkt (hun wifi/IP-locatie is te grof).
  const hasGps = () => navigator.userAgentData?.mobile === true || /android|iphone|ipad|ipod/i.test(navigator.userAgent)
    || (/macintosh/i.test(navigator.userAgent) && navigator.maxTouchPoints > 1) // iPadOS meldt zich als Mac
    || matchMedia('(pointer: coarse)').matches; // telefoon in "desktopsite"-modus
  const MAX_ACC = 200; // m; zelfde grens als op de server
  function getFix() {
    if (fix && Date.now() - fix.t < 45000) return Promise.resolve(fix);
    return new Promise((resolve, reject) => {
      if (!navigator.geolocation) return reject(new Error('Dit apparaat ondersteunt geen locatiebepaling. Wijzigen kan alleen in de wijk.'));
      navigator.geolocation.getCurrentPosition(
        (p) => { fix = { lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy || 0), t: Date.now() }; resolve(fix); },
        (err) => reject(new Error(err.code === 1
          ? 'Wijzigen kan alleen in de wijk. Geef deze site toegang tot je locatie (instellingen van je browser of telefoon) en probeer het opnieuw.'
          : 'Je locatie kon niet worden bepaald. Probeer het buiten of met wifi/GPS aan opnieuw.')),
        { enableHighAccuracy: true, timeout: 12000, maximumAge: 30000 });
    });
  }
  // true als wijzigen hier mag; anders een melding (geen geofence = altijd toegestaan)
  async function checkGeo() {
    if (!geo) return true;
    if (!hasGps()) return true; // desktop/laptop: geen locatiecontrole
    try {
      const f = await getFix();
      if (f.acc > MAX_ACC) { fix = null; toast(`Je GPS-locatie is niet nauwkeurig genoeg (ongeveer ${f.acc} m). Zet GPS aan, ga naar buiten en probeer het opnieuw.`); return false; }
      const dist = distanceM([f.lat, f.lng], geo.center);
      if (dist - Math.min(f.acc, 500) > geo.radius) { toast(`Je lijkt niet in de wijk te zijn (ongeveer ${Math.round(dist / 10) * 10} m van het midden). Wijzigen kan alleen in de wijk.`); return false; }
      return true;
    } catch (e) { toast(e.message); return false; }
  }
  // Apparaten zonder GPS vullen eenmalig de toegangscode in (gedeeld in de buurtapp).
  async function ensureCode() {
    if (!codeRequired || hasGps() || codeOk) return true;
    const dlg = document.getElementById('code-dialog'), input = document.getElementById('code-input'), err = document.getElementById('code-error');
    return new Promise((resolve) => {
      let done = false;
      const finish = (ok) => { if (done) return; done = true; dlg.close(); resolve(ok); };
      input.value = ''; err.textContent = '';
      dlg.onclose = () => finish(false);
      document.getElementById('code-cancel').onclick = () => finish(false);
      document.getElementById('code-x').onclick = () => finish(false);
      document.getElementById('code-form').onsubmit = async (e) => {
        e.preventDefault();
        err.textContent = '';
        try { await api('/code', { code: input.value.trim() }); codeOk = true; finish(true); }
        catch (e2) { err.textContent = e2.message; input.select(); }
      };
      dlg.showModal();
      input.focus();
    });
  }
  Wijk.setResidentGeofence = (g) => { geo = g && g.center ? g : null; };
  Wijk.setResidentCode = (flag) => { codeRequired = flag === true; };
  const QR_HINT = 'Scan de QR-code uit je brief om jouw huis te kiezen.';

  async function api(path, body) {
    const geoHeader = {};
    if ((geo || codeRequired) && body !== undefined && (path === '/set' || path === '/claim')) {
      if (!hasGps()) geoHeader['X-Geo-Device'] = 'desktop';
      else if (geo) {
        const f = await getFix();
        geoHeader['X-Geo-Device'] = 'gps';
        geoHeader['X-Geo'] = `${f.lat.toFixed(6)},${f.lng.toFixed(6)},${f.acc}`;
      }
    }
    const res = await fetch(`/api/resident${path}`, body === undefined ? {} : {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...geoHeader, ...(isInstalledApp() ? { 'X-App-Mode': 'standalone' } : {}) },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if (path === '/me' || path === '/restore') codeOk = data.codeOk === true;
    if (!res.ok) {
      if (data.code === 'required') codeOk = false; // de code is gewijzigd of de cookie is weg
      throw Object.assign(new Error(data.error || `Fout ${res.status}`), { status: res.status, code: data.code });
    }
    return data;
  }

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
    document.body.append(t);
    setTimeout(() => t.remove(), 3500);
  }

  Wijk.initResident = async function ({ map, houses, enabled, mode: startMode, geofence, deviceCode, qrOnly: startQrOnly }) {
    if (!enabled) return;
    qrOnly = startQrOnly === true;
    Wijk.setResidentGeofence(geofence);
    Wijk.setResidentCode(deviceCode);
    let mode = startMode || 'open'; // 'swap': na de einddatum alleen het eigen huis wisselen tussen groen en rood
    const btn = $('house-edit');
    if (!btn) return;
    btn.hidden = !isInstalledApp(); // in de browser tonen we de knop pas na de schakelaar "Bewerken"

    let sorted = [...houses].sort(Wijk.compareHouses);
    let byId = new Map(houses.map((h) => [h.id, h]));
    const store = {
      get: (k) => { try { return localStorage.getItem(k); } catch { return null; } },
      set: (k, v) => { try { v === null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch {} },
    };
    const CACHE = 'sm-resident-me', TOKEN = 'sm-resident-token';

    // De koppeling blijft bewaard: op de server (cookie), met een lokale kopie van het token als reserve
    // en een lokale kopie van de laatste status voor als er even geen verbinding is.
    let me = { claim: null };
    try {
      me = await api('/me');
      if (!me.claim && store.get(TOKEN)) { // cookie weg? herstel met het lokaal bewaarde token
        try { me = await api('/restore', { token: store.get(TOKEN) }); } catch (e) { if (e.status === 404) store.set(TOKEN, null); }
      }
      store.set(CACHE, me.claim ? JSON.stringify(me) : null);
    } catch (e) {
      if (e.status === 403) { btn.hidden = true; return; }
      try { me = JSON.parse(store.get(CACHE) || 'null') || { claim: null }; } catch { me = { claim: null }; } // offline
    }

    let on = false, group = null;
    const layers = new Map();
    const sheet = $('house-sheet');

    const swap = () => mode === 'swap';
    // na de einddatum: groen <-> rood, nooit via "niet gemarkeerd"
    const nextStatus = (st) => (swap() ? (st === 'green' ? 'red' : st === 'red' ? 'green' : st) : cycle(st));
    const changed = () => window.dispatchEvent(new Event('sm-resident'));
    Wijk.residentNoAccess = () => swap() && !me.claim; // geen huis gekozen en wijzigen is gesloten
    Wijk.setResidentQrOnly = (flag) => { qrOnly = flag === true; if (on) render(); };
    Wijk.setResidentMode = (m) => {
      if (!m || m === mode) return;
      mode = m;
      if (on && Wijk.residentNoAccess()) leave();
      else if (on) render();
      changed();
    };

    const statusOf = (h) => (me.claim && h.id === me.claim.houseId ? me.effective : h.status);

    function styleFor(h) {
      const st = statusOf(h);
      const style = Wijk.houseStyle(st);
      if (st === 'none') style.fillOpacity = 0.22; // lege huizen blijven goed aantikbaar
      const mine = me.claim && h.id === me.claim.houseId;
      if (mine) { style.weight = 5; style.color = '#1d4ed8'; }
      if (mine && me.pending) style.dashArray = '10 6';
      return style;
    }

    function restyle() {
      for (const [id, layer] of layers) {
        const h = byId.get(id);
        layer.setStyle(styleFor(h));
        const el = layer.getElement && layer.getElement();
        if (el) el.classList.toggle('pending', !!(me.claim && id === me.claim.houseId && me.pending));
        if (me.claim && id === me.claim.houseId) layer.bringToFront();
      }
    }

    // Het eigen huis blijft ook buiten de wijzigmodus zichtbaar (met de nog niet goedgekeurde status).
    let mine = null;
    function clearMine() { if (mine) { mine.remove(); mine = null; } Wijk.setPublicHouseCovered?.(null); }
    function drawMine() {
      clearMine();
      if (on || !me.claim) return;
      const h = byId.get(me.claim.houseId);
      if (!h) return;
      mine = L.layerGroup().addTo(map);
      // niet-interactief: een enkele klik doet hier hetzelfde als bij elk ander huis; wijzigen kan alleen via dubbelklik of lang indrukken
      const poly = L.polygon(h.points, { ...styleFor(h), interactive: false }).addTo(mine);
      const el = poly.getElement && poly.getElement();
      if (el) el.classList.toggle('pending', !!me.pending);
      const badge = L.marker(Wijk.labelPoint(h.points), {
        icon: L.divIcon({ className: 'mine-badge', html: MDI.html(me.pending ? 'timer-sand' : 'home'), iconSize: [26, 26] }),
        interactive: false, keyboard: false,
      }).addTo(mine);
      badge.getElement()?.setAttribute('title', me.pending ? 'Jouw huis: wacht op goedkeuring' : 'Jouw huis');
      Wijk.setPublicHouseCovered?.(h.id);
    }

    async function enter() {
      if (Wijk.residentNoAccess()) { toast('Wijzigen is gesloten'); return; }
      if (geo && hasGps()) toast('Locatie controleren…');
      if (!(await checkGeo())) return;
      if (!(await ensureCode())) return;
      if (on) return;
      on = true;
      clearMine();
      document.body.classList.add('editing');
      Wijk.setPublicHousesHidden?.(true);
      group = L.layerGroup().addTo(map);
      for (const h of houses) {
        const layer = L.polygon(h.points, styleFor(h)).addTo(group);
        layer.on('click', (e) => { L.DomEvent.stopPropagation(e); tap(h); });
        layers.set(h.id, layer);
      }
      restyle();
      if (me.claim) { const h = byId.get(me.claim.houseId); if (h) map.fitBounds(L.latLngBounds(h.points).pad(2), { maxZoom: 19 }); }
      render();
    }

    function leave() {
      on = false;
      document.body.classList.remove('editing');
      Wijk.setPublicHousesHidden?.(false);
      if (group) { group.remove(); group = null; }
      layers.clear();
      sheet.hidden = true;
      sheet.replaceChildren();
      drawMine();
    }

    async function setStatus(next) {
      try {
        me = { ...me, ...(await api('/set', { status: next })) };
        store.set(CACHE, JSON.stringify(me));
        restyle();
        drawMine();
        render();
      } catch (e) { toast(e.message); }
    }

    function confirmClaim(h) {
      if (swap()) { toast('Wijzigen is gesloten: je kunt geen huis meer kiezen'); return; }
      if (qrOnly) { toast(QR_HINT); return; }
      const dlg = $('claim-dialog');
      $('claim-title').textContent = Wijk.houseTitle(h);
      dlg.returnValue = '';
      dlg.onclose = async () => {
        if (dlg.returnValue !== 'ja') return;
        try {
          me = await api('/claim', { houseId: h.id, token: store.get(TOKEN) || undefined });
          if (me.deviceToken) store.set(TOKEN, me.deviceToken);
          store.set(CACHE, JSON.stringify(me));
          restyle();
          await setStatus(nextStatus(h.status)); // de eerste tik wisselt meteen de kleur
        } catch (e) { toast(e.message); }
      };
      dlg.showModal();
    }

    function tap(h) {
      if (!me.claim) return confirmClaim(h);
      if (h.id === me.claim.houseId) {
        if (swap() && me.approved === 'none') return toast('Jouw huis is niet gemarkeerd; dat kan nu niet meer worden gewijzigd.');
        return setStatus(nextStatus(me.effective));
      }
      toast(`Je kunt alleen jouw eigen huis wijzigen (${me.claim.title}).`);
    }

    function el(tag, props = {}, ...kids) {
      const e = Object.assign(document.createElement(tag), props);
      e.append(...kids);
      return e;
    }

    function render() {
      if (!on) return;
      sheet.hidden = false;
      const parts = [];
      const head = el('div', { className: 'sheet-head' }, el('strong', { textContent: 'Mijn huis' }),
        el('button', { type: 'button', className: 'icon-btn', ariaLabel: 'Sluiten', onclick: leave }, MDI.svg('close')));
      parts.push(head);

      if (me.notice) {
        const ok = me.notice.decision === 'approved';
        parts.push(el('p', { className: `notice ${ok ? 'ok' : 'no'}` },
          ok ? `✔ Je wijziging (${NAME[me.notice.status]}) is goedgekeurd.` : '✖ Je laatste wijziging is niet doorgevoerd.',
          el('button', { type: 'button', textContent: 'OK', onclick: async () => { try { await api('/ack', {}); } catch {} me.notice = null; render(); } })));
      }

      if (!me.claim && qrOnly) {
        parts.push(el('p', { className: 'qr-hint' }, MDI.svg('qrcode'), ' ' + QR_HINT));
        parts.push(el('p', { className: 'muted', textContent: 'Open de camera van je telefoon, richt hem op de QR-code en tik op de link. Geen brief ontvangen of kwijt? Vraag het de beheerder.' }));
      } else if (!me.claim) {
        parts.push(el('p', { textContent: 'Tik op jouw huis op de kaart of kies je adres. Je kunt per apparaat één huis kiezen.' }));
        const sel = el('select', { ariaLabel: 'Kies je adres' }, el('option', { value: '', textContent: 'Kies je adres…' }),
          ...sorted.map((h) => el('option', { value: h.id, textContent: Wijk.houseTitle(h) })));
        sel.onchange = () => {
          const h = byId.get(sel.value);
          sel.value = '';
          if (!h) return;
          map.fitBounds(L.latLngBounds(h.points).pad(2), { maxZoom: 19 });
          confirmClaim(h);
        };
        parts.push(sel);
      } else {
        parts.push(el('p', {}, 'Jouw huis: ', el('strong', { textContent: me.claim.title })));
        parts.push(el('p', { className: 'muted', textContent: swap()
          ? 'Wijzigen is gesloten. Je kunt nog wel jouw huis wisselen tussen groen en rood.'
          : 'Kies de kleur, of tik op je huis op de kaart om te wisselen.' }));
        const choices = swap() ? ORDER.filter((s) => s !== 'none') : ORDER;
        if (swap() && me.approved === 'none') parts.push(el('p', { className: 'muted', textContent: 'Jouw huis is niet gemarkeerd; dat kan nu niet meer worden gewijzigd.' }));
        else parts.push(el('div', { className: 'status-choice' }, ...choices.map((s) => {
          const b = el('button', { type: 'button', className: me.effective === s ? 'active' : '', onclick: () => setStatus(s) },
            el('i', { className: `dot ${s === 'none' ? '' : s}` }), NAME[s]);
          b.setAttribute('aria-pressed', me.effective === s);
          return b;
        })));
        parts.push(el('p', { className: me.pending ? 'pending-msg' : 'muted', textContent: me.pending
          ? '⏳ Wacht op goedkeuring door de beheerder. Pas daarna zien anderen deze kleur.'
          : (me.effective === 'none' ? 'Je huis is niet gemarkeerd.' : '✔ Dit is de huidige (goedgekeurde) kleur.') }));
      }
      sheet.replaceChildren(...parts);
    }

    // Opnieuw ophalen (periodiek en bij terugkeer naar de app): nieuwe huisgegevens + eigen status/uitslag.
    let lastNotice = me.notice ? me.notice.at : null;
    Wijk.refreshResident = async (newHouses) => {
      if (newHouses) {
        houses = newHouses;
        sorted = [...houses].sort(Wijk.compareHouses);
        byId = new Map(houses.map((h) => [h.id, h]));
      }
      try {
        const next = await api('/me');
        me = next.claim ? next : { claim: null };
        if (next.mode && next.mode !== mode) { mode = next.mode; changed(); }
        store.set(CACHE, me.claim ? JSON.stringify(me) : null);
      } catch (e) { if (e.status === 403) { btn.hidden = true; leave(); } return; }
      if (me.notice && me.notice.at !== lastNotice) {
        toast(me.notice.decision === 'approved' ? 'Je wijziging is goedgekeurd ✔' : 'Je wijziging is niet doorgevoerd');
      }
      lastNotice = me.notice ? me.notice.at : null;
      if (on) { // wijzigmodus open: kaartlaag en venster bijwerken
        group && group.clearLayers();
        layers.clear();
        for (const h of houses) {
          const layer = L.polygon(h.points, styleFor(h)).addTo(group);
          layer.on('click', (e) => { L.DomEvent.stopPropagation(e); tap(h); });
          layers.set(h.id, layer);
        }
        restyle();
        render();
      } else {
        drawMine();
      }
    };
    drawMine();
    changed();

    Wijk.leaveResident = () => { if (on) leave(); };
    // Venster om de beheerder een kort bericht te sturen (optioneel met de gescande QR als context).
    function askMessage(intro, q) {
      const dlg = $('msg-dialog'), text = $('msg-text'), err = $('msg-error'), cnt = $('msg-count');
      $('msg-intro').textContent = intro;
      text.value = ''; err.textContent = ''; cnt.textContent = '0';
      text.oninput = () => { cnt.textContent = String(text.value.length); };
      const close = () => { if (dlg.open) dlg.close(); };
      $('msg-x').onclick = $('msg-cancel').onclick = close;
      $('msg-form').onsubmit = async (e) => {
        e.preventDefault();
        err.textContent = '';
        $('msg-send').disabled = true;
        try { await api('/message', { text: text.value, q }); close(); toast('Bericht verstuurd ✔ De beheerder krijgt een melding.'); }
        catch (e2) { err.textContent = e2.message; }
        $('msg-send').disabled = false;
      };
      dlg.showModal();
      text.focus();
    }
    // Gescande QR-code (?q=...): bij welk huis hoort die, bevestigen, koppelen en de wijzigmodus openen.
    Wijk.claimFromQr = async (q) => {
      try { document.getElementById('intro-dialog')?.close(); } catch {}
      if (swap() || mode === 'closed') { toast('Wijzigen is gesloten.'); return; }
      let info;
      try { info = await api('/qr/lookup', { q }); } catch (e) { toast(e.message); return; }
      // Al gekoppeld (aan dit of een ander huis): geen nieuwe koppeling, wel de mogelijkheid de beheerder een bericht te sturen.
      if (me.claim) {
        askMessage(me.claim.houseId === info.houseId
          ? `Dit apparaat is al gekoppeld aan ${me.claim.title}. Je kunt de beheerder een kort bericht sturen als er iets niet klopt.`
          : `Je hebt de QR-code van ${info.title} gescand, maar dit apparaat is al gekoppeld aan ${me.claim.title}. Wil je dat de beheerder iets aanpast? Stuur een kort bericht.`, q);
        return;
      }
      if (info.taken) {
        askMessage(`${info.title} is al aan een ander apparaat gekoppeld (één apparaat per huis). Heb je een nieuwe telefoon of woon je hier? Stuur de beheerder een kort bericht.`, q);
        return;
      }
      const dlg = $('claim-dialog');
      $('claim-title').textContent = info.title;
      dlg.returnValue = '';
      dlg.onclose = async () => {
        if (dlg.returnValue !== 'ja') return;
        try {
          if (!(await checkGeo())) return;
          me = await api('/claim', { q, token: store.get(TOKEN) || undefined });
          if (me.deviceToken) store.set(TOKEN, me.deviceToken);
          store.set(CACHE, JSON.stringify(me));
          changed();
          toast(`Gekoppeld aan ${me.claim.title} ✔`);
          await enter();
        } catch (e) { toast(e.message); }
      };
      dlg.showModal();
    };
    // Dubbelklik op een huis: wijzigmodus aan en dit huis selecteren (inzoomen; nog geen huis? dan vragen of het van jou is).
    Wijk.selectResidentHouse = async (id) => {
      const h = byId.get(id);
      if (!h) return;
      if (!on) await enter();
      if (!on) return;
      map.fitBounds(L.latLngBounds(h.points).pad(2), { maxZoom: 19 });
      const layer = layers.get(id);
      if (layer) layer.bringToFront();
      tapSelect(h);
    };
    function tapSelect(h) {
      if (!me.claim) return confirmClaim(h);
      if (h.id !== me.claim.houseId) toast(`Je kunt alleen jouw eigen huis wijzigen (${me.claim.title}).`);
    }
    btn.onclick = () => (on ? leave() : enter());
    $('claim-no').onclick = () => $('claim-dialog').close('nee');
    $('claim-yes').onclick = () => $('claim-dialog').close('ja');

    // een uitslag van de beheerder die nog niet getoond is
    if (me.notice) { toast(me.notice.decision === 'approved' ? 'Je wijziging is goedgekeurd ✔' : 'Je wijziging is niet doorgevoerd'); }
  };
})();
