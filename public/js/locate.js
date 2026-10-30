// "Mijn locatie": optionele knop op de publieke kaart die de GPS-positie van het apparaat als stip toont.
// Staat standaard uit: de browser vraagt pas om toestemming nadat de bezoeker op de knop tikt, en er wordt
// niets onthouden of verstuurd; de positie blijft op het apparaat. Zolang de locatie aan staat blijft het scherm
// aan (Screen Wake Lock), zodat je de telefoon tijdens het lopen niet steeds hoeft te ontgrendelen. De beheerder kan de knop verbergen.
(function () {
  const FOLLOW_ZOOM = 18; // zoom bij het volgen: huisnummers zijn dan goed leesbaar
  const MAX_ACC_CIRCLE = 500; // m; een nauwkeurigheidscirkel groter dan dit zegt niets bruikbaars

  // Geeft { setEnabled(bool), stop() } terug. Zonder geolocation-ondersteuning komt er nooit een knop.
  function createLocate(map, toast) {
    let control = null, button = null;
    let watchId = null, following = false, announced = false, fresh = false;
    let dot = null, ring = null;
    let wake = null, asking = false; // Screen Wake Lock: houdt het scherm aan zolang de locatie aan staat

    const supported = () => 'geolocation' in navigator;

    function paint() {
      if (!button) return;
      const on = watchId !== null;
      button.classList.toggle('on', on);
      button.classList.toggle('following', on && following);
      button.setAttribute('aria-pressed', String(on));
      const label = !on ? 'Mijn locatie tonen' : following ? 'Mijn locatie verbergen' : 'Naar mijn locatie';
      button.setAttribute('aria-label', label);
      button.title = label;
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
      if (following) center(latlng, fresh);
      fresh = false;
    }

    function onError(err) {
      if (err.code === 1) { // toestemming geweigerd: terug naar uit
        toast('Je hebt geen toegang tot je locatie gegeven. Sta locatie toe voor deze site in de instellingen van je browser of telefoon en probeer het opnieuw.');
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

    function start() {
      if (!window.isSecureContext) { toast('Je locatie tonen kan alleen via een beveiligde (https) verbinding.'); return; }
      announced = false;
      following = true;
      fresh = true; // de eerste positie zoomt de kaart erheen
      watchId = navigator.geolocation.watchPosition(onFix, onError, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
      holdScreen();
      paint();
    }

    function stop() {
      if (watchId !== null) navigator.geolocation.clearWatch(watchId);
      watchId = null; following = false;
      releaseScreen();
      dot?.remove(); ring?.remove(); dot = ring = null;
      paint();
    }

    function press() {
      if (watchId === null) return start();
      if (!following) { // kaart is weggeschoven: terug naar de positie en weer volgen
        following = true;
        if (dot) center(dot.getLatLng(), true);
        return paint();
      }
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
    }

    return {
      // aan: knop tonen (de positie blijft uit tot er getikt wordt); uit: knop weg en meteen stoppen met meten
      setEnabled(on) {
        if (on && supported() && !control) mount();
        if (!on && control) { stop(); control.remove(); control = button = null; }
      },
      stop,
    };
  }

  window.Wijk = window.Wijk || {};
  window.Wijk.createLocate = createLocate;
})();
