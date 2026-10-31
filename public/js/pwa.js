// PWA: service worker registreren en de knop "Installeer app" in de menubalk.
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  // Er opent niets vanzelf: wie de app nog niet geïnstalleerd heeft, ziet de knop #install-btn in de menubalk. In de
  // geïnstalleerde app zelf (en na het installeren) verdwijnt hij. De knop komt op Android, iOS en Windows (Chrome/Edge)
  // en in elke andere browser die zelf een installatieprompt aanbiedt (bijv. Chrome op macOS of Linux).
  const ua = navigator.userAgent;
  const modes = ['standalone', 'fullscreen'].map((m) => window.matchMedia(`(display-mode: ${m})`));
  const standalone = () => modes.some((m) => m.matches) || navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const platform = isIos ? 'ios' : /android/i.test(ua) ? 'android' : /windows/i.test(ua) && /chrome|edg/i.test(ua) ? 'windows' : null; // Windows: alleen Chrome/Edge kunnen installeren
  const guide = platform || 'windows'; // uitleg voor andere desktopbrowsers met installatieprompt: dezelfde als voor Chrome/Edge op Windows

  const STEPS = {
    ios: [
      'Open deze pagina in Safari.',
      'Tik op het deel-icoon (vierkantje met pijl omhoog) onderaan of bovenaan het scherm.',
      'Scrol omlaag en kies "Zet in beginscherm".',
      'Tik op "Voeg toe". De app staat nu op je beginscherm.',
    ],
    android: [
      'Tik op de drie puntjes (⋮) rechtsboven in Chrome.',
      'Kies "App installeren" (of "Toevoegen aan startscherm").',
      'Tik op "Installeren". De app staat nu tussen je apps.',
    ],
    windows: [
      'Klik in Chrome of Edge op het installeer-icoon rechts in de adresbalk.',
      'Zie je dat icoon niet? Open het menu (⋮ of ...) en kies "App installeren". In Edge: "Apps" en dan "Deze site als app installeren".',
      'Klik op "Installeren". De app opent in een eigen venster.',
    ],
  };
  const INTRO = {
    ios: 'Zet de kaart op je beginscherm: dan werkt hij als een app, met een eigen icoon en ook zonder internet.',
    android: 'Installeer de kaart als app: sneller openen, een eigen icoon en gebruik zonder internet.',
    windows: 'Installeer de kaart als app: sneller openen, een eigen icoon en gebruik zonder internet.',
  };

  let deferred = null; // installatieprompt van de browser; kan maar één keer gebruikt worden
  let offered = false; // de browser heeft installeren aangeboden (blijft waar als de prompt is weggeklikt)
  let installed = false; // zojuist geïnstalleerd, terwijl deze pagina nog open staat
  const $ = (id) => document.getElementById(id);

  function sync() {
    const btn = $('install-btn');
    if (btn) btn.hidden = installed || standalone() || !(platform || offered);
  }

  // iOS kent geen installatieprompt: installeren gaat via het deelvenster ("Zet in beginscherm"). Dat mag alleen worden geopend
  // vanuit een tik van de bezoeker, dus rechtstreeks in de klik-handler (niet na een await of een timeout).
  const canShare = () => platform === 'ios' && typeof navigator.share === 'function';
  // Lukt het deelvenster niet, dan staat de reden (naam van de fout) in het venster, boven de stappen die er dan altijd zijn.
  async function share() {
    const note = $('install-note');
    if (note) note.hidden = true;
    try {
      await navigator.share({ title: document.title, url: location.origin + '/' });
    } catch (e) {
      if (e?.name === 'AbortError' || !note) return; // de bezoeker sloot het deelvenster zelf
      note.textContent = I18n.t('Het deelvenster kon niet worden geopend ({naam}). Volg de stappen hierboven.', { naam: e?.name || 'onbekende fout' });
      note.hidden = false;
    }
  }

  // Een klik op de knop: met de installatieprompt van de browser (Android, Windows, desktop) start het installeren meteen.
  // Op iOS opent het deelvenster meteen, met daarachter een venster met de stappen. Anders (of als de prompt al is
  // weggeklikt) opent alleen het venster met de stappen voor het platform.
  function install() {
    if (deferred) {
      const d = deferred;
      deferred = null;
      Promise.resolve(d.prompt()).catch(() => {});
      return;
    }
    if (canShare()) share();
    const dlg = $('install-dialog');
    if (!dlg || dlg.open) return;
    $('install-text').textContent = INTRO[guide];
    $('install-steps').replaceChildren(...STEPS[guide].map((t) => Object.assign(document.createElement('li'), { textContent: t })));
    $('install-go').hidden = !canShare(); // "Installeer nu" opent het deelvenster opnieuw, als je het hebt weggeklikt
    dlg.showModal();
  }

  function wire() {
    const dlg = $('install-dialog');
    if (dlg) {
      $('install-x').onclick = $('install-later').onclick = () => dlg.close();
      $('install-go').onclick = share; // de stappen blijven zichtbaar, ook als het deelvenster niet opent
    }
    if ($('install-btn')) $('install-btn').onclick = install;
    sync();
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault(); // geen mini-infobalk van de browser: de knop in de menubalk is de plek om te installeren
    deferred = e;
    offered = true;
    sync();
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installed = true;
    if ($('install-dialog')?.open) $('install-dialog').close();
    sync();
  });
  modes.forEach((m) => m.addEventListener?.('change', sync));
  document.addEventListener('DOMContentLoaded', wire);

  // offline-indicator
  function syncOffline() {
    const el = document.getElementById('offline');
    if (el) el.hidden = navigator.onLine;
  }
  window.addEventListener('online', syncOffline);
  window.addEventListener('offline', syncOffline);
  document.addEventListener('DOMContentLoaded', syncOffline);
})();
