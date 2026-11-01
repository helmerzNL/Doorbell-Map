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
      'Tik op het paginamenu bij de adresbalk en kies "Deel". Zie je al een deelknop (vierkantje met pijl omhoog) in de werkbalk, tik dan daarop.',
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

  // Een klik op de knop: met de installatieprompt van de browser (Android, Windows, desktop) start het installeren meteen.
  // Anders (iOS, of de prompt is al weggeklikt) opent een venster met de stappen voor het platform. Op iOS bestaat geen
  // installatieprompt, en een pagina kan de deelknop van Safari zelf niet openen: navigator.share() toont een ander
  // deelvenster, zonder "Zet in beginscherm". Daar kan alleen uitleg helpen.
  function install() {
    if (deferred) {
      const d = deferred;
      deferred = null;
      Promise.resolve(d.prompt()).catch(() => {});
      return;
    }
    const dlg = $('install-dialog');
    if (!dlg || dlg.open) return;
    $('install-text').textContent = INTRO[guide];
    $('install-steps').replaceChildren(...STEPS[guide].map((t) => Object.assign(document.createElement('li'), { textContent: t })));
    dlg.showModal();
  }

  function wire() {
    const dlg = $('install-dialog');
    if (dlg) $('install-close').onclick = $('install-x').onclick = () => dlg.close();
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
