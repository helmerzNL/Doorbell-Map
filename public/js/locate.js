// "Mijn locatie": knop op de publieke kaart die de GPS-positie van het apparaat als stip toont.
// Staat standaard aan: bij het openen van de kaart vraagt de browser om toestemming (zodra er geen venster meer open staat).
// Na toestemming staat de knop aan, verschijnt de stip, volgt de kaart de positie en blijft het scherm aan (Screen Wake Lock),
// precies als na een tik op de knop; zonder toestemming blijft alles zoals het was en volgt er geen melding. Zet de bezoeker
// de locatie zelf uit, dan onthoudt dit apparaat dat (alleen die keuze, in localStorage) en start hij niet meer vanzelf.
// Er wordt niets verstuurd; de positie blijft op het apparaat. De beheerder kan de knop verbergen.
//
// Community (alleen als de beheerder die aanzet): een tweede, eveneens opt-in knop deelt je positie met anderen die ook
// delen. De bezoeker moet dat eerst bevestigen; de server bewaart de positie kort in het geheugen en verwijdert haar
// zodra je stopt of de pagina sluit. Wie niet deelt, ziet de anderen niet.
(function () {
  const OFF_KEY = 'sm-locate-off'; // de bezoeker heeft "Mijn locatie" zelf uitgezet: niet meer vanzelf starten
  const FOLLOW_ZOOM = 18; // zoom bij het volgen: huisnummers zijn dan goed leesbaar
  const MAX_ACC_CIRCLE = 500; // m; een nauwkeurigheidscirkel groter dan dit zegt niets bruikbaars
  const PING_MS = 8000; // hoe vaak de eigen positie wordt doorgegeven (en de anderen worden ververst); de server laat 45 s toe
  // Meldt dat de locatiekeuze van de bezoeker bekend is (toegestaan, geweigerd of niet van toepassing). De installatiemelding
  // (pwa.js) wacht daarop, zodat de uitleg, de locatievraag en de installatiemelding na elkaar komen en niet door elkaar.
  function settle() {
    if (window.Wijk.locateSettled) return;
    window.Wijk.locateSettled = true;
    window.dispatchEvent(new Event('sm-locate-settled'));
  }
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
      settle();
      const latlng = draw(pos);
      const first = !lastFix;
      lastFix = { lat: pos.coords.latitude, lng: pos.coords.longitude, acc: pos.coords.accuracy || 0 };
      if (sharing && first) sendPing(); // meteen de eerste positie delen, de timer doet de rest
      if (following) center(latlng, fresh);
      fresh = false;
    }

    function onError(err) {
      settle();
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
    // de toestemming al geweigerd heeft. Een open venster (uitleg, installatiemelding) gaat voor.
    async function autoStart() {
      if (autoTried) return;
      if (!supported() || !window.isSecureContext || watchId !== null || isOff()) return settle();
      autoTried = true;
      try { if ((await navigator.permissions?.query({ name: 'geolocation' }))?.state === 'denied') return settle(); } catch { /* geen Permissions API: gewoon proberen */ }
      const go = () => {
        if (!control || watchId !== null || isOff()) return settle();
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
        const r = await fetch('/api/community/ping', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: cid, ...lastFix }) });
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

    // De bezoeker bevestigt eerst wat er gedeeld wordt; er is geen standaardkeuze en niets wordt onthouden.
    function consent() {
      const dlg = document.getElementById('community-dialog');
      if (!dlg?.showModal) return Promise.resolve(false);
      return new Promise((resolve) => {
        let yes = false;
        dlg.onclose = () => resolve(yes);
        document.getElementById('community-yes').onclick = () => { yes = true; dlg.close(); };
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
        if (!on || !supported()) settle(); // geen locatie bij deze kaart: er valt niets af te wachten
        if (!on && control) { stop(); unmountCommunity(); control.remove(); control = button = null; }
      },
      // aan: de beheerder heeft de community aangezet; de knop komt er alleen als ook "Mijn locatie" beschikbaar is
      setCommunity(on) {
        communityOn = on;
        if (on) mountCommunity(); else unmountCommunity();
      },
      stop,
    };
  }

  window.Wijk = window.Wijk || {};
  window.Wijk.createLocate = createLocate;
})();
