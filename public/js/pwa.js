// PWA: service worker registreren en de eenmalige melding "Installeer de app" met stappen per platform.
(function () {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
  }

  // Eenmalig (per apparaat) een melding om de app te installeren: Android, iOS en Windows.
  // De melding heeft een knop "Installeer nu" die het installeren start, plus de stappen voor het platform.
  const KEY = 'sm-install-asked';
  const ua = navigator.userAgent;
  const standalone = () => window.matchMedia('(display-mode: standalone)').matches || window.matchMedia('(display-mode: fullscreen)').matches || navigator.standalone === true;
  const isIos = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const platform = isIos ? 'ios' : /android/i.test(ua) ? 'android' : /windows/i.test(ua) && /chrome|edg/i.test(ua) ? 'windows' : null; // Windows: alleen Chrome/Edge kunnen installeren
  const asked = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
  const markAsked = () => { try { localStorage.setItem(KEY, '1'); } catch {} };

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

  let deferred = null, shown = false;
  const $ = (id) => document.getElementById(id);

  // "Installeer nu" start het installatieproces: met de installatieprompt van de browser (Android, Windows) direct,
  // op iOS via het deelvenster (daar staat "Zet in beginscherm" in). De stappen blijven zichtbaar zolang de
  // browser zelf niet kan installeren, ook als terugval wanneer het deelvenster of de prompt niet opent.
  async function install() {
    if (deferred) {
      const d = deferred;
      deferred = null;
      $('install-dialog').close();
      d.prompt();
      await d.userChoice.catch(() => {});
    } else if (platform === 'ios' && navigator.share) {
      await navigator.share({ title: document.title, url: location.origin + '/' }).catch(() => {});
    } else {
      $('install-steps').hidden = false;
      $('install-steps').scrollIntoView?.({ block: 'nearest' });
    }
  }

  function open() {
    const dlg = $('install-dialog');
    $('install-text').textContent = INTRO[platform];
    const steps = $('install-steps');
    steps.replaceChildren(...(deferred ? [] : STEPS[platform]).map((t) => Object.assign(document.createElement('li'), { textContent: t })));
    steps.hidden = !steps.children.length;
    $('install-x').onclick = $('install-later').onclick = () => dlg.close();
    $('install-go').onclick = install;
    dlg.showModal();
  }

  function show() {
    if (shown || !$('install-dialog') || !platform || standalone() || asked()) return;
    // wacht tot er geen ander venster (bijv. de uitleg) open staat
    if (document.querySelector('dialog[open]')) return setTimeout(show, 1500);
    shown = true;
    markAsked();
    open();
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    if ($('install-dialog')?.open) $('install-steps').hidden = true; // melding stond al open: de knop volstaat nu
  });
  window.addEventListener('appinstalled', () => { deferred = null; markAsked(); if ($('install-dialog')?.open) $('install-dialog').close(); });
  document.addEventListener('DOMContentLoaded', () => { if (platform) setTimeout(show, 3000); });

  // offline-indicator
  function sync() {
    const el = document.getElementById('offline');
    if (el) el.hidden = navigator.onLine;
  }
  window.addEventListener('online', sync);
  window.addEventListener('offline', sync);
  document.addEventListener('DOMContentLoaded', sync);
})();
