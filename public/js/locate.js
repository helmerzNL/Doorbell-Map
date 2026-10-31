// "Mijn locatie": knop op de publieke kaart die de GPS-positie van het apparaat als stip toont.
// Staat standaard aan: bij het openen van de kaart vraagt de browser om toestemming (zodra er geen venster meer open staat).
// Na toestemming staat de knop aan, verschijnt de stip, volgt de kaart de positie en blijft het scherm aan (Screen Wake Lock),
// precies als na een tik op de knop; zonder toestemming blijft alles zoals het was en volgt er geen melding. Zet de bezoeker
// de locatie zelf uit, dan onthoudt dit apparaat dat (alleen die keuze, in localStorage) en start hij niet meer vanzelf.
// Er wordt niets verstuurd; de positie blijft op het apparaat. De beheerder kan de knop verbergen.
//
// Community (alleen als de beheerder die aanzet): een tweede, eveneens opt-in knop deelt je positie met anderen die ook
// delen. De bezoeker moet dat eerst bevestigen; de server bewaart de positie kort in het geheugen en verwijdert haar
// zodra je stopt of de pagina sluit. Wie niet deelt, ziet de anderen niet. Titel en tekst van de bevestiging stelt de beheerder
// in; is dat aan, dan kiest de bezoeker ook een kleur en symbool waarmee anderen hem zien (alleen die keuze wordt onthouden).
(function () {
  const LOOK_KEY = 'sm-community-look'; // laatst gekozen kleur en symbool, als voorstel bij de volgende keer
  const OFF_KEY = 'sm-locate-off'; // de bezoeker heeft "Mijn locatie" zelf uitgezet: niet meer vanzelf starten
  const FOLLOW_ZOOM = 18; // zoom bij het volgen: huisnummers zijn dan goed leesbaar
  const MAX_ACC_CIRCLE = 500; // m; een nauwkeurigheidscirkel groter dan dit zegt niets bruikbaars
  const PING_MS = 8000; // hoe vaak de eigen positie wordt doorgegeven (en de anderen worden ververst); de server laat 45 s toe
  const newId = () => {
    if (crypto.randomUUID) return crypto.randomUUID().replace(/-/g, '');
    return [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');
  };

  // Geeft { setEnabled(bool), stop() } terug. Zonder geolocation-ondersteuning komt er nooit een knop.
  function createLocate(map, toast) {
    let control = null, button = null;
    let watchId = null, following = false, announced = false, fresh = false;
    let dot = null, ring = null;
    let wake = null, asking = false; // Screen Wake Lock: houdt het scherm aan zolang de locatie aan staat
    let silent = false, autoTried = false; // silent: vanzelf gestart, dus geen meldingen als de bezoeker niets deed
    // community
    let communityOn = false, commControl = null, commButton = null, commBadge = null, layer = null;
    let sharing = false, cid = '', lastFix = null, pingTimer = null, limitToasted = false;
    let commOpts = { title: '', text: '', looks: true }; // instellingen van de beheerder voor het bevestigingsvenster
    let look = loadLook(); // { c: hex-kleur, i: symbool-sleutel }

    function loadLook() {
      const first = window.Wijk.COMMUNITY_COLORS[0].c;
      try {
        const v = JSON.parse(localStorage.getItem(LOOK_KEY) || '{}');
        const c = window.Wijk.COMMUNITY_COLORS.some((x) => x.c === v.c) ? v.c : first;
        const i = window.Wijk.COMMUNITY_ICONS.some((x) => x.i === v.i) ? v.i : '';
        return { c, i };
      } catch { return { c: first, i: '' }; }
    }
    const saveLook = () => { try { localStorage.setItem(LOOK_KEY, JSON.stringify(look)); } catch {} };

    const supported = () => 'geolocation' in navigator;
    const isOff = () => { try { return localStorage.getItem(OFF_KEY) === '1'; } catch { return false; } };
    const setOff = (off) => { try { if (off) localStorage.setItem(OFF_KEY, '1'); else localStorage.removeItem(OFF_KEY); } catch {} };

    function paint() {
      if (!button) return;
      const on = watchId !== null;
      button.classList.toggle('on', on);
      button.classList.toggle('following', on && following);
      button.setAttribute('aria-pressed', String(on));
      const label = !on ? 'Mijn locatie tonen' : following ? 'Mijn locatie verbergen' : 'Naar mijn locatie';
      button.setAttribute('aria-label', label);
      button.title = label;
      paintCommunity();
    }

    function paintCommunity() {
      if (!commButton) return;
      commButton.classList.toggle('on', sharing);
      commButton.setAttribute('aria-pressed', String(sharing));
      const label = sharing ? 'Stoppen met delen met de community' : 'Mijn positie delen met de community';
      commButton.setAttribute('aria-label', label);
      commButton.title = label;
      const n = sharing && layer ? layer.count : 0;
      commBadge.textContent = n ? String(n) : '';
      commBadge.hidden = !n;
    }

    // zoomIn: bij het starten (en bij "Naar mijn locatie") dicht genoeg inzoomen om huizen te zien;
    // daarna schuift de kaart alleen mee en blijft de zoom zoals de bezoeker die koos
    function center(latlng, zoomIn) {
      if (zoomIn) map.setView(latlng, Math.min(Math.max(map.getZoom(), FOLLOW_ZOOM), map.getMaxZoom()));
      else map.panTo(latlng);
    }

    function draw(pos) {
      const latlng = [pos.coords.latitude, pos.coords.longitude];
      const acc = pos.coords.accuracy || 0;
      if (!dot) {
        ring = L.circle(latlng, { radius: acc, interactive: false, className: 'locate-ring', weight: 1 }).addTo(map);
        dot = L.circleMarker(latlng, { radius: 9, interactive: false, className: 'locate-dot', weight: 3, fillOpacity: 1 }).addTo(map);
      } else {
        ring.setLatLng(latlng); dot.setLatLng(latlng);
      }
      ring.setRadius(acc);
      ring.getElement()?.classList.toggle('locate-ring-hidden', acc > MAX_ACC_CIRCLE);
      return latlng;
    }

    function onFix(pos) {
      const latlng = draw(pos);
      const first = !lastFix;
      lastFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy || 0 };
      if (sharing && first) sendPing(); // meteen de eerste positie delen, de timer doet de rest
      if (following) center(latlng, fresh);
      fresh = false;
    }

    function onError(err) {
      if (err.code === 1) { // toestemming geweigerd: terug naar uit
        if (!silent) toast('Je hebt geen toegang tot je locatie gegeven. Sta locatie toe voor deze site in de instellingen van je browser of telefoon en probeer het opnieuw.');
        stop();
      } else if (!announced) { // tijdelijk geen signaal: de browser blijft proberen, we melden het één keer
        announced = true;
        toast('Je locatie kon nog niet worden bepaald. Ga naar buiten of zet GPS aan; we blijven het proberen.');
      }
    }

    // Een wake lock vervalt vanzelf als de pagina naar de achtergrond gaat; bij terugkomen vragen we hem opnieuw.
    // Geen ondersteuning of een weigering (bijv. batterijbesparing) is geen fout: het scherm dimt dan gewoon.
    async function holdScreen() {
      if (!('wakeLock' in navigator) || watchId === null || wake || asking || document.visibilityState !== 'visible') return;
      asking = true;
      try {
        const lock = await navigator.wakeLock.request('screen');
        if (watchId === null) { lock.release().catch(() => {}); return; } // intussen uitgezet
        wake = lock;
        lock.addEventListener('release', () => { if (wake === lock) wake = null; });
      } catch { /* niet beschikbaar: het scherm mag dimmen */ }
      finally { asking = false; }
    }
    function releaseScreen() {
      const lock = wake;
      wake = null;
      lock?.release().catch(() => {});
    }
    document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') holdScreen(); });

    // auto: vanzelf gestart bij het openen; werkt als een tik op de knop, maar meldt niets als het niet lukt
    function start(auto) {
      if (!window.isSecureContext) { if (!auto) toast('Je locatie tonen kan alleen via een beveiligde (https) verbinding.'); return; }
      silent = !!auto;
      announced = silent;
      following = true;
      fresh = true; // de eerste positie zoomt de kaart erheen
      watchId = navigator.geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
      holdScreen();
      paint();
    }

    // Standaard aan: één keer per paginalading proberen, behalve als de bezoeker de locatie zelf uitzette of de browser
    // de toestemming al geweigerd heeft. Een open venster (de uitleg) gaat voor.
    async function autoStart() {
      if (autoTried) return;
      if (!supported() || !window.isSecureContext || watchId !== null || isOff()) return;
      autoTried = true;
      try { if ((await navigator.permissions?.query({ name: 'geolocation' }))?.state === 'denied') return; } catch { /* geen Permissions API: gewoon proberen */ }
      const go = () => {
        if (!control || watchId !== null || isOff()) return;
        if (document.querySelector('dialog[open]')) return setTimeout(go, 1500);
        start(true);
      };
      go();
    }

    function stop() {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null; following = false; lastFix = null;
      stopSharing();
      releaseScreen();
      dot?.remove(); ring?.remove(); dot = ring = null;
      paint();
    }

    // ---------- community ----------
    async function sendPing() {
      if (!sharing || !lastFix) return;
      try {
        const r = await fetch('/api/community/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cid, ...lastFix, ...(commOpts.looks ? { color: look.c, icon: look.i } : {}) }) });
        if (!sharing) return; // intussen gestopt
        if (r.status === 403) { stopSharing(); toast('De community is uitgezet.'); return; }
        if (r.status === 429) { if (!limitToasted) { limitToasted = true; toast('Delen lukt nu niet (te druk). We proberen het straks opnieuw.'); } return; }
        if (!r.ok) return;
        limitToasted = false;
        layer.update((await r.json()).peers);
        paintCommunity();
      } catch { /* offline: volgende poging */ }
    }

    function leave() { // best effort; de server verwijdert de positie anders na 45 s vanzelf
      if (!cid) return;
      const body = JSON.stringify({ id: cid });
      if (!navigator.sendBeacon?.('/api/community/leave', new Blob([body], { type: 'application/json' }))) {
        fetch('/api/community/leave', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, keepalive: true }).catch(() => {});
      }
    }

    function stopSharing() {
      clearInterval(pingTimer); pingTimer = null;
      if (sharing) leave();
      sharing = false; cid = '';
      layer?.clear();
      paintCommunity();
    }

    // Titel en tekst van het bevestigingsvenster (instelling van de beheerder): alinea's staan gescheiden door een lege regel,
    // de eerste is de uitleg en de rest de toelichting.
    function fillDialog() {
      const o = commOpts;
      if (o.title) document.getElementById('community-title').textContent = o.title;
      if (o.text) {
        const box = document.getElementById('community-text');
        box.replaceChildren(...o.text.split(/\n\s*\n/).map((t) => t.trim()).filter(Boolean).map((t, n) => {
          const p = document.createElement('p');
          if (n) p.className = 'muted';
          p.textContent = t;
          return p;
        }));
      }
      const fs = document.getElementById('community-looks');
      fs.hidden = !o.looks;
      if (o.looks) buildLooks();
    }

    // Kleuren en symbolen als keuzerondjes; de keuze staat in `look` en het voorbeeld toont meteen hoe de stip eruitziet.
    function buildLooks() {
      const W = window.Wijk, tr = (x) => (window.I18n ? window.I18n.tr(x) : x);
      const preview = document.getElementById('community-preview');
      const paint = () => {
        const v = W.communityLook(look.c, look.i);
        preview.style.setProperty('--pin', v.c);
        preview.textContent = v.e;
        preview.classList.toggle('has-icon', !!v.e);
        for (const b of document.querySelectorAll('#community-looks .look-btn')) b.setAttribute('aria-checked', String(b.dataset.c ? b.dataset.c === look.c : b.dataset.i === look.i));
      };
      const make = (host, items, label, pick) => {
        host.setAttribute('aria-label', tr(label));
        host.replaceChildren(...items.map((x) => {
          const b = document.createElement('button');
          b.type = 'button'; b.className = 'look-btn'; b.setAttribute('role', 'radio');
          b.title = tr(x.name); b.setAttribute('aria-label', tr(x.name));
          pick(b, x);
          b.onclick = () => { b.dataset.c ? (look.c = b.dataset.c) : (look.i = b.dataset.i); paint(); };
          return b;
        }));
      };
      make(document.getElementById('community-colors'), W.COMMUNITY_COLORS, 'Kleur', (b, x) => { b.classList.add('swatch'); b.dataset.c = x.c; b.style.setProperty('--sw', x.c); });
      make(document.getElementById('community-icons'), W.COMMUNITY_ICONS, 'Symbool', (b, x) => { b.dataset.i = x.i; b.textContent = x.e || '∅'; if (!x.i) b.classList.add('none'); });
      paint();
    }

    // De bezoeker bevestigt eerst wat er gedeeld wordt; er is geen standaardkeuze en de toestemming wordt niet onthouden.
    function consent() {
      const dlg = document.getElementById('community-dialog');
      if (!dlg?.showModal) return Promise.resolve(false);
      fillDialog();
      return new Promise((resolve) => {
        let yes = false;
        dlg.onclose = () => resolve(yes);
        document.getElementById('community-yes').onclick = () => { yes = true; if (commOpts.looks) saveLook(); dlg.close(); };
        document.getElementById('community-no').onclick = () => dlg.close();
        document.getElementById('community-x').onclick = () => dlg.close();
        dlg.showModal();
      });
    }

    async function pressCommunity() {
      if (sharing) return stopSharing();
      if (!(await consent())) return;
      if (watchId === null) start(); // delen heeft de positie nodig; ook zonder eerst op "Mijn locatie" te tikken
      if (watchId === null) return;
      cid = newId(); sharing = true; limitToasted = false;
      layer = layer || Wijk.createCommunityLayer(map);
      pingTimer = setInterval(sendPing, PING_MS);
      if (lastFix) sendPing();
      paintCommunity();
    }
    window.addEventListener('pagehide', () => { if (sharing) leave(); });

    function press() {
      if (watchId === null) { setOff(false); return start(); }
      if (!following) { // kaart is weggeschoven: terug naar de positie en weer volgen
        following = true;
        if (dot) center(dot.getLatLng(), true);
        return paint();
      }
      setOff(true); // de bezoeker zet de locatie uit: onthouden, zodat hij niet meer vanzelf start
      stop();
    }

    // zelf de kaart verschuiven stopt het volgen (de stip blijft); 'dragstart' komt alleen van de bezoeker zelf
    map.on('dragstart', () => { if (following) { following = false; paint(); } });

    function mount() {
      const Ctl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
          const box = L.DomUtil.create('div', 'leaflet-bar locate-ctl');
          button = L.DomUtil.create('button', 'locate-btn', box);
          button.type = 'button';
          button.innerHTML = MDI.html('crosshairs-gps');
          L.DomEvent.disableClickPropagation(box);
          L.DomEvent.on(button, 'click', press);
          paint();
          return box;
        },
      });
      control = new Ctl().addTo(map);
      if (communityOn) mountCommunity();
    }

    function mountCommunity() {
      if (commControl || !control) return;
      const Ctl = L.Control.extend({
        options: { position: 'topleft' },
        onAdd() {
          const box = L.DomUtil.create('div', 'leaflet-bar locate-ctl community-ctl');
          commButton = L.DomUtil.create('button', 'locate-btn community-btn', box);
          commButton.type = 'button';
          commButton.innerHTML = MDI.html('account-group');
          commBadge = L.DomUtil.create('span', 'community-badge', commButton);
          commBadge.hidden = true;
          L.DomEvent.disableClickPropagation(box);
          L.DomEvent.on(commButton, 'click', pressCommunity);
          paintCommunity();
          return box;
        },
      });
      commControl = new Ctl().addTo(map);
    }

    function unmountCommunity() {
      stopSharing();
      commControl?.remove();
      commControl = commButton = commBadge = null;
    }

    return {
      // aan: knop tonen en de locatie vanzelf starten (tenzij de bezoeker die zelf uitzette); uit: knop weg en meteen stoppen met meten
      setEnabled(on) {
        if (on && supported() && !control) mount();
        if (on && control) autoStart();
        if (!on && control) { stop(); unmountCommunity(); control.remove(); control = button = null; }
      },
      // aan: de beheerder heeft de community aangezet; de knop komt er alleen als ook "Mijn locatie" beschikbaar is
      // opts: { title, text, looks } uit de instellingen van de beheerder (leeg = het standaardvenster)
      setCommunity(on, opts) {
        communityOn = on;
        commOpts = { title: opts?.title || '', text: opts?.text || '', looks: opts?.looks !== false };
        if (on) mountCommunity(); else unmountCommunity();
      },
      stop,
    };
  }

  window.Wijk = window.Wijk || {};
  window.Wijk.createLocate = createLocate;
})();
