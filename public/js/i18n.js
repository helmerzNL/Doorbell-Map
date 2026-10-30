// Meertaligheid: de bron van alle teksten is Nederlands; in een andere taal vertaalt dit script de pagina met het
// woordenboek (lang-en.js): bestaande en later toegevoegde tekst en kenmerken (placeholder, title, aria-label, alt).
// Teksten met variabelen in de code gaan via I18n.t(). Taal: standaardtaal van de site (beheer); is meertaligheid
// aan, dan kiest de bezoeker zelf met de vlag rechtsboven (onthouden in localStorage).
(function () {
  const meta = document.querySelector('meta[name="sm-lang"]');
  const LANGS = [
    { code: 'nl', name: 'Nederlands', locale: 'nl-NL' },
    { code: 'en', name: 'English', locale: 'en-GB' },
  ];
  const def = LANGS.some((l) => l.code === meta?.content) ? meta.content : 'nl';
  const multi = meta?.dataset.multi === '1';
  let lang = def;
  if (multi) { try { const s = localStorage.getItem('sm-lang'); if (LANGS.some((l) => l.code === s)) lang = s; } catch { /* geen opslag */ } }
  document.documentElement.lang = lang;

  const dict = (window.SM_DICT && window.SM_DICT[lang]) || null;
  const core = window.SMLangCore && dict ? window.SMLangCore.makeTranslator(dict) : null;
  const tr = core ? core.tr : (s) => s;
  const t = core ? core.t : (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m));

  // ---------- vertalen van de pagina ----------
  const SKIP_TAG = new Set(['SCRIPT', 'STYLE', 'TEXTAREA', 'SVG', 'CODE', 'PRE']);
  const SKIP_CLASS = ['leaflet-tile-pane', 'leaflet-overlay-pane', 'leaflet-marker-pane', 'leaflet-shadow-pane'];
  const ATTRS = ['placeholder', 'title', 'aria-label', 'alt'];
  const MIXED = new Set(['P', 'LABEL', 'DIV', 'SPAN', 'LI', 'H1', 'H2', 'H3', 'H4', 'H5', 'BUTTON', 'A', 'SUMMARY', 'TD', 'SMALL']);
  const skipped = (el) => el.nodeType === 1 && (SKIP_TAG.has(el.tagName.toUpperCase()) || el.hasAttribute('data-i18n-skip') || SKIP_CLASS.some((c) => el.classList.contains(c)));
  const inSkipped = (n) => { for (let e = n.nodeType === 1 ? n : n.parentElement; e; e = e.parentElement) if (skipped(e)) return true; return false; };
  const norm = (s) => s.replace(/\s+/g, ' ').trim();

  function translateAttrs(el) {
    for (const a of ATTRS) {
      const v = el.getAttribute && el.getAttribute(a);
      if (v) { const o = tr(v); if (o !== v) el.setAttribute(a, o); }
    }
  }
  function walk(node) {
    if (node.nodeType === 3) {
      const v = node.nodeValue;
      if (v && v.trim()) { const o = tr(v); if (o !== v) node.nodeValue = o; }
      return;
    }
    if (node.nodeType !== 1) return;
    translateAttrs(node);
    if (skipped(node)) return;
    // lopende tekst met opmaak (<code>, <em>…): de hele inhoud als één zin vertalen
    if (MIXED.has(node.tagName) && node.firstElementChild && [...node.childNodes].some((c) => c.nodeType === 3 && c.nodeValue.trim())) {
      const key = norm(node.innerHTML), o = tr(key);
      if (o !== key) { node.innerHTML = o; return; }
    }
    for (const c of [...node.childNodes]) walk(c);
  }

  function start() {
    walk(document.documentElement);
    new MutationObserver((muts) => {
      for (const m of muts) {
        if (m.type === 'childList') m.addedNodes.forEach((n) => { if (!inSkipped(n)) walk(n); });
        else if (m.type === 'characterData') {
          if (!inSkipped(m.target)) { const v = m.target.nodeValue, o = v && v.trim() ? tr(v) : v; if (o !== v) m.target.nodeValue = o; }
        } else if (m.type === 'attributes' && !inSkipped(m.target)) translateAttrs(m.target);
      }
    }).observe(document.documentElement, { childList: true, subtree: true, characterData: true, attributes: true, attributeFilter: ATTRS });
  }
  if (core) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
  }

  // ---------- vlaggen, taalkeuze en licht/donker ----------
  const FLAGS = {
    nl: '<svg viewBox="0 0 9 6" aria-hidden="true"><rect width="9" height="2" fill="#AE1C28"/><rect y="2" width="9" height="2" fill="#fff"/><rect y="4" width="9" height="2" fill="#21468B"/></svg>',
    en: '<svg viewBox="0 0 60 30" aria-hidden="true"><clipPath id="fl-s"><path d="M0,0 v30 h60 v-30 z"/></clipPath><clipPath id="fl-t"><path d="M30,15 h30 v15 z v15 h-30 z h-30 v-15 z v-15 h30 z"/></clipPath><g clip-path="url(#fl-s)"><path d="M0,0 v30 h60 v-30 z" fill="#012169"/><path d="M0,0 L60,30 M60,0 L0,30" stroke="#fff" stroke-width="6"/><path d="M0,0 L60,30 M60,0 L0,30" clip-path="url(#fl-t)" stroke="#C8102E" stroke-width="4"/><path d="M30,0 v30 M0,15 h60" stroke="#fff" stroke-width="10"/><path d="M30,0 v30 M0,15 h60" stroke="#C8102E" stroke-width="6"/></g></svg>',
  };
  const flag = (code) => { const s = document.createElement('span'); s.className = 'flag'; s.innerHTML = FLAGS[code] || ''; return s; };

  // Uitklapmenu met vlaggen. onSelect(code) wordt aangeroepen bij een keuze.
  function picker({ value, onSelect, label = 'Taal', id }) {
    const wrap = document.createElement('div');
    wrap.className = 'lang-picker';
    const btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'lang-btn'; btn.setAttribute('aria-haspopup', 'listbox'); btn.setAttribute('aria-expanded', 'false');
    if (id) btn.id = id;
    btn.title = label; btn.setAttribute('aria-label', label);
    const pop = document.createElement('div');
    pop.className = 'lang-pop'; pop.setAttribute('role', 'listbox'); pop.hidden = true;
    let cur = value;
    const draw = () => {
      const l = LANGS.find((x) => x.code === cur) || LANGS[0];
      btn.replaceChildren(flag(l.code), Object.assign(document.createElement('span'), { className: 'lang-name', textContent: l.name }), Object.assign(document.createElement('span'), { className: 'caret', textContent: '▾' }));
      pop.replaceChildren(...LANGS.map((x) => {
        const o = document.createElement('button');
        o.type = 'button'; o.setAttribute('role', 'option'); o.setAttribute('aria-selected', String(x.code === cur));
        o.className = x.code === cur ? 'active' : '';
        o.append(flag(x.code), Object.assign(document.createElement('span'), { textContent: x.name }));
        o.onclick = () => { close(); if (x.code !== cur) { cur = x.code; draw(); onSelect && onSelect(x.code); } };
        return o;
      }));
    };
    const close = () => { pop.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.onclick = (e) => { e.stopPropagation(); const open = pop.hidden; pop.hidden = !open; btn.setAttribute('aria-expanded', String(open)); };
    document.addEventListener('click', (e) => { if (!wrap.contains(e.target)) close(); });
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
    wrap.append(btn, pop);
    draw();
    wrap.setValue = (v) => { cur = v; draw(); };
    return wrap;
  }

  const SUN = window.MDI ? MDI.html('white-balance-sunny') : '';
  const MOON = window.MDI ? MDI.html('weather-night') : '';

  // Zet de vlaggenkeuze (alleen als meertaligheid aan staat) en de licht/donker-knop in een kopbalk.
  function mountPrefs(container) {
    if (!container) return;
    container.replaceChildren();
    if (multi) {
      container.append(picker({
        value: lang, label: t('Taal'),
        onSelect: (code) => { try { localStorage.setItem('sm-lang', code); } catch { /* geen opslag */ } location.reload(); },
      }));
    }
    const b = document.createElement('button');
    b.type = 'button'; b.className = 'theme-btn';
    const sync = () => {
      const dark = window.SMTheme && window.SMTheme.current() === 'dark';
      b.innerHTML = dark ? SUN : MOON;
      const label = dark ? t('Lichte weergave') : t('Donkere weergave');
      b.title = label; b.setAttribute('aria-label', label);
    };
    b.onclick = () => { window.SMTheme && window.SMTheme.toggle(); sync(); };
    window.addEventListener('sm-theme', sync);
    sync();
    container.append(b);
  }

  // Vertaler voor een andere taal dan de huidige (bijvoorbeeld voor een QR-kaartje in de taal van de bewoners)
  const translators = {};
  function tFor(l) {
    if (l === lang) return { tr, t };
    if (!translators[l]) {
      const d = window.SM_DICT && window.SM_DICT[l];
      translators[l] = d && window.SMLangCore ? window.SMLangCore.makeTranslator(d) : { tr: (s) => s, t: (tpl, vars) => String(tpl).replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m)) };
    }
    return translators[l];
  }

  window.I18n = {
    LANGS, lang, multi, defaultLang: def, tr, t, tFor, picker, flag, mountPrefs,
    locale: (LANGS.find((l) => l.code === lang) || LANGS[0]).locale,
    // Gegevens van /api/map in de gekozen taal: de tekst van de beheerder in die taal (als ingevuld), anders de Nederlandse.
    localize(d, l = lang) {
      const T = tFor(l);
      const own = (l !== 'nl' && d.translations && d.translations[l]) || {};
      const has = (v) => typeof v === 'string' && v.trim();
      const out = { ...d };
      for (const k of ['siteTitle', 'appName', 'appShortName', 'intro', 'residentInfo']) if (has(own[k])) out[k] = own[k];
      // het communityvenster: eigen tekst in die taal, anders de standaardtekst vertaald (een eigen Nederlandse tekst blijft Nederlands)
      for (const k of ['communityTitle', 'communityText']) out[k] = has(own[k]) ? own[k] : String(d[k] || '').split('\n\n').map((p) => T.tr(p)).join('\n\n');
      out.title = has(own.siteTitle) ? own.siteTitle : T.tr(d.title);
      out.labels = { ...(d.labels || {}) };
      for (const k of Object.keys(out.labels)) if (has(own.labels && own.labels[k])) out.labels[k] = own.labels[k];
      return out;
    },
  };
})();
