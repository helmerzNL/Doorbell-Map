// Twee standen van de huizen vergelijken (bijvoorbeeld een eerdere editie en de live kaart). Gedeeld door het beheer
// en de tests. Huizen worden gekoppeld op id (blijft gelijk zolang een huis niet opnieuw getekend is) en anders op
// adres (straat + huisnummer, als dat aan beide kanten precies één keer voorkomt).
// "Meedoen" is de groene status; de vergelijking deelt elk huis in: groen in beide, alleen groen in a, alleen groen
// in b, of in geen van beide groen.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api; else root.SMCompare = api;
})(typeof self !== 'undefined' ? self : this, function () {
  const STATUSES = ['green', 'red', 'none'];
  const statusOf = (h) => (h && STATUSES.includes(h.status) ? h.status : 'none');
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  // Adressleutel, of '' als het huis geen huisnummer heeft (dan koppelen we niet op adres).
  const addressKey = (h) => (norm(h.number) ? `${norm(h.street)}|${norm(h.number)}` : '');

  function counts(houses) {
    const c = { total: 0, green: 0, red: 0, none: 0 };
    for (const h of houses || []) { c.total++; c[statusOf(h)]++; }
    return c;
  }

  // Elk huis uit a en uit b komt precies één keer voor: [{ a, b }] met a of b null als er geen tegenhanger is.
  function match(a, b) {
    a = a || []; b = b || [];
    const pairs = [];
    const usedB = new Set();
    const byId = new Map();
    b.forEach((h, i) => { if (h.id && !byId.has(h.id)) byId.set(h.id, i); });
    const restA = [];
    for (const h of a) {
      const i = h.id ? byId.get(h.id) : undefined;
      if (i !== undefined && !usedB.has(i)) { usedB.add(i); pairs.push({ a: h, b: b[i] }); } else restA.push(h);
    }
    // Overgebleven huizen op adres koppelen, alleen als het adres aan beide kanten uniek is.
    const index = (list) => {
      const m = new Map();
      for (const x of list) { const k = addressKey(x.h); if (k) m.set(k, m.has(k) ? null : x); }
      return m;
    };
    const restB = b.map((h, i) => ({ h, i })).filter((x) => !usedB.has(x.i));
    const ia = index(restA.map((h) => ({ h }))), ib = index(restB);
    const pairedA = new Set();
    for (const [k, xa] of ia) {
      const xb = ib.get(k);
      if (!xa || !xb) continue;
      usedB.add(xb.i); pairedA.add(xa.h);
      pairs.push({ a: xa.h, b: xb.h });
    }
    for (const h of restA) if (!pairedA.has(h)) pairs.push({ a: h, b: null });
    b.forEach((h, i) => { if (!usedB.has(i)) pairs.push({ a: null, b: h }); });
    return pairs;
  }

  // Categorie van een gekoppeld paar: 'both', 'onlyA', 'onlyB' of 'neither' (op basis van groen).
  const category = (p) => {
    const ga = statusOf(p.a) === 'green', gb = statusOf(p.b) === 'green';
    return ga && gb ? 'both' : ga ? 'onlyA' : gb ? 'onlyB' : 'neither';
  };

  function compare(a, b) {
    const pairs = match(a, b).map((p) => ({ ...p, cat: category(p) }));
    const cats = { both: 0, onlyA: 0, onlyB: 0, neither: 0 };
    for (const p of pairs) cats[p.cat]++;
    return { pairs, a: counts(a), b: counts(b), cats };
  }

  return { match, compare, counts, addressKey, statusOf };
});
