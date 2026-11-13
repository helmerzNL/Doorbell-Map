// Vertaalmotor, gedeeld door de browser en de server. De bron van alle teksten is Nederlands; een
// woordenboek (lang-en.js) vertaalt een Nederlandse tekst naar een andere taal. Sleutels met {naam}
// zijn sjablonen: "{n} huizen" vertaalt ook "12 huizen" en vult {n} in de vertaling in.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.SMLangCore = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  function makeTranslator(dict) {
    const exact = new Map();
    const all = new Map(Object.entries(dict || {})); // ook sjablonen, voor t()
    const pats = [];
    const words = (dict && dict['@words']) || []; // losse woorden die overal vervangen worden (bv. een eigennaam)
    for (const [k, v] of Object.entries(dict || {})) {
      if (k === '@words') continue;
      if (/\{\w+\}/.test(k)) {
        const names = [];
        const src = k.split(/(\{\w+\})/).map((part) => {
          const m = /^\{(\w+)\}$/.exec(part);
          if (m) { names.push(m[1]); return '([\\s\\S]+?)'; }
          return esc(part);
        }).join('');
        pats.push({ re: new RegExp(`^${src}$`), names, to: v, len: k.length });
      } else exact.set(k, v);
    }
    pats.sort((a, b) => b.len - a.len); // het meest specifieke sjabloon eerst
    const swap = (s) => words.reduce((acc, [from, to]) => acc.split(from).join(to), s);
    const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (m, n) => (vars && n in vars ? String(vars[n]) : m));
    // Scheidingstekens van samengestelde regels ("a · b · c", "a → b"). Een sjabloonvariabele is één stuk
    // tekst: loopt hij over zo'n teken heen, dan was het sjabloon te gretig (bv. "{n} van {m}" op
    // "Wijzigingen van bewoners goedgekeurd · 8 huizen") en worden de stukken apart vertaald.
    const SEPS = [' · ', ' → '];
    const spans = (s) => SEPS.some((x) => s.includes(x));

    // Vertaalt één tekst; ongewijzigd als er geen vertaling is. Witruimte aan de randen blijft behouden.
    function tr(str) {
      if (typeof str !== 'string' || !str) return str;
      const m = /^(\s*)([\s\S]*?)(\s*)$/.exec(str);
      const core = m[2];
      if (!core) return str;
      const flat = core.replace(/\s+/g, ' '); // regelafbrekingen in de HTML tellen niet mee
      let out = exact.get(core);
      if (out === undefined) out = exact.get(flat);
      if (out === undefined) {
        for (const p of pats) {
          const r = p.re.exec(core) || p.re.exec(flat);
          if (r && !r.slice(1).some(spans)) { out = fill(p.to, Object.fromEntries(p.names.map((n, i) => [n, tr(r[i + 1])]))); break; }
        }
      }
      if (out === undefined) { // samengestelde regels: "a · b · c" of "a → b" per stuk vertalen
        const sep = SEPS.find((x) => core.includes(x));
        if (sep) {
          const parts = core.split(sep), done = parts.map((x) => tr(x));
          if (done.some((x, i) => x !== parts[i])) out = done.join(sep);
        }
      }
      return out === undefined ? swap(str) : m[1] + swap(out) + m[3];
    }
    // Sjabloon met variabelen, bijvoorbeeld t('Nog {n} dagen', { n: 3 }).
    function t(template, vars) {
      const base = all.get(template);
      return swap(fill(base !== undefined ? base : template, vars));
    }
    return { tr, t, fill };
  }
  return { makeTranslator };
});
