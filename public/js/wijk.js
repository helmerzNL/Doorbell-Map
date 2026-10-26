// Gedeelde code voor publieke pagina en beheer: Leaflet-kaart (OpenStreetMap) en PDF-export.
(function () {
  const STATUS = {
    green: { color: '#1f9d55', stroke: '#0f6b36', name: 'Groen' },
    red: { color: '#d93a3a', stroke: '#8f1f1f', name: 'Rood' },
    none: { color: '#888888', stroke: '#555555', name: 'Niet gemarkeerd' },
  };
  // Namen van de statussen zijn instelbaar (instellingen); elementen met data-label worden meegenomen.
  function applyLabels(root = document) {
    root.querySelectorAll('[data-label]').forEach((el) => {
      const n = STATUS[el.dataset.label]?.name;
      if (n) el.textContent = el.hasAttribute('data-lower') ? n.toLowerCase() : n;
    });
  }
  function setLabels(labels) {
    if (!labels) return;
    for (const k of ['green', 'red', 'none']) if (labels[k]) STATUS[k].name = I18n.tr(labels[k]);
    applyLabels();
  }

  const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
  const ATTRIBUTION = I18n.t('© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bijdragers');
  const DEFAULT_VIEW = { center: [52.1, 5.3], zoom: 8 };

  function createMap(el, view, houses) {
    const map = L.map(el, {
      minZoom: view?.minZoom ?? 1,
      maxZoom: view?.maxZoom ?? 19,
      zoomSnap: 0.25,
      bounceAtZoomLimits: false,
    });
    L.tileLayer(TILE_URL, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(map);
    if (view) map.setView(view.center, view.zoom);
    else if (houses && houses.length) map.fitBounds(L.latLngBounds(houses.flatMap((h) => h.points)).pad(0.2));
    else map.setView(DEFAULT_VIEW.center, DEFAULT_VIEW.zoom);
    return map;
  }

  function houseStyle(status, selected) {
    const s = STATUS[status] || STATUS.none;
    return {
      color: selected ? '#ffffff' : s.stroke,
      weight: selected ? 4 : 2,
      fillColor: s.color,
      fillOpacity: status === 'none' ? 0.15 : 0.55,
      dashArray: status === 'none' ? '5 4' : null,
    };
  }

  // ---------- huizen: titel, sortering, nummerpositie ----------
  const houseTitle = (h) => [h.street, h.number].filter(Boolean).join(' ') || h.label || I18n.t('Huis');
  const natCompare = (a, b) => String(a).localeCompare(String(b), 'nl', { numeric: true, sensitivity: 'base' });
  const compareHouses = (a, b) => natCompare(a.street || '', b.street || '') || natCompare(a.number || a.label || '', b.number || b.label || '');
  const houseNumber = (h) => h.number || '';

  // Beste plek voor het huisnummer: het punt in het vlak dat het verst van de randen ligt
  // (valt ook bij hoekige of L-vormige huizen binnen het huis).
  function labelPoint(points) {
    const lat0 = points.reduce((a, p) => a + p[0], 0) / points.length;
    const kx = Math.cos((lat0 * Math.PI) / 180);
    const P = points.map(([la, ln]) => [ln * kx, la]);
    const xs = P.map((p) => p[0]), ys = P.map((p) => p[1]);
    const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
    const inside = (x, y) => {
      let c = false;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        if ((P[i][1] > y) !== (P[j][1] > y) && x < ((P[j][0] - P[i][0]) * (y - P[i][1])) / (P[j][1] - P[i][1]) + P[i][0]) c = !c;
      }
      return c;
    };
    const edgeDist = (x, y) => {
      let d = Infinity;
      for (let i = 0, j = P.length - 1; i < P.length; j = i++) {
        const [ax, ay] = P[j], [bx, by] = P[i];
        const dx = bx - ax, dy = by - ay;
        const t = Math.max(0, Math.min(1, ((x - ax) * dx + (y - ay) * dy) / (dx * dx + dy * dy || 1)));
        d = Math.min(d, Math.hypot(x - (ax + t * dx), y - (ay + t * dy)));
      }
      return d;
    };
    let best = [(minX + maxX) / 2, (minY + maxY) / 2], bestD = -1;
    const N = 24;
    for (let i = 0; i < N; i++) {
      for (let j = 0; j < N; j++) {
        const x = minX + ((maxX - minX) * (i + 0.5)) / N, y = minY + ((maxY - minY) * (j + 0.5)) / N;
        if (!inside(x, y)) continue;
        const d = edgeDist(x, y);
        if (d > bestD) { bestD = d; best = [x, y]; }
      }
    }
    return [best[1], best[0] / kx];
  }

  // Laag met huisnummers in het midden van elk huis (wit met donkere rand: goed leesbaar op elke kleur).
  // Nummers die niet in het huis passen worden verborgen en komen vanzelf terug bij verder inzoomen.
  function createNumberLayer(map) {
    const group = L.layerGroup();
    let items = [];
    const sizeFor = (z) => Math.max(9, Math.min(22, 6 + (z - 15.5) * 3.4));

    function update() {
      const fs = sizeFor(map.getZoom());
      map.getContainer().style.setProperty('--num-fs', `${fs}px`);
      for (const it of items) {
        const el = it.marker.getElement();
        if (!el) continue;
        const a = map.latLngToContainerPoint(it.bounds.getSouthWest()), b = map.latLngToContainerPoint(it.bounds.getNorthEast());
        const w = Math.abs(b.x - a.x), h = Math.abs(b.y - a.y);
        el.style.display = w >= fs * 0.6 * it.text.length + 6 && h >= fs * 1.3 ? '' : 'none';
      }
    }

    function rebuild(houses) {
      group.clearLayers();
      items = [];
      for (const h of houses) {
        const text = houseNumber(h);
        if (!text) continue;
        const span = document.createElement('span');
        span.textContent = text;
        const marker = L.marker(labelPoint(h.points), {
          icon: L.divIcon({ className: `house-num ${h.status}`, html: span, iconSize: [0, 0] }),
          interactive: false, keyboard: false,
        });
        items.push({ marker, text, bounds: L.latLngBounds(h.points) });
        group.addLayer(marker);
      }
      if (map.hasLayer(group)) update();
    }

    map.on('zoomend', update);
    return {
      rebuild,
      update,
      setVisible(v) {
        if (v && !map.hasLayer(group)) { group.addTo(map); update(); }
        if (!v && map.hasLayer(group)) map.removeLayer(group);
      },
    };
  }

  // ---------- PDF ----------
  const TILE = 256;
  const worldPx = (z) => TILE * 2 ** z;
  function project([lat, lng], z) {
    const n = worldPx(z);
    const s = Math.sin((lat * Math.PI) / 180);
    return [((lng + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
  }

  function loadTile(z, x, y) {
    return new Promise((resolve) => {
      const img = new Image();
      img.crossOrigin = 'anonymous';
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = TILE_URL.replace('{z}', z).replace('{x}', x).replace('{y}', y);
    });
  }

  // Bepaalt welk kaartvlak (midden, zoom) de PDF toont: het ingestelde PDF-vlak, anders het gebied van alle huizen.
  function pdfFrame(houses, view, W, H, pdfView) {
    const pts = houses.flatMap((h) => h.points);
    let center, z;
    if (pdfView && Array.isArray(pdfView.center)) {
      center = pdfView.center; z = Math.min(19, Math.max(1, Math.round(pdfView.zoom)));
    } else if (pts.length) {
      const lats = pts.map((p) => p[0]), lngs = pts.map((p) => p[1]);
      const sw = [Math.min(...lats), Math.min(...lngs)], ne = [Math.max(...lats), Math.max(...lngs)];
      const pad = 0.12;
      for (z = 19; z > 1; z--) {
        const a = project(sw, z), b = project(ne, z);
        if (Math.abs(b[0] - a[0]) <= W * (1 - 2 * pad) && Math.abs(a[1] - b[1]) <= H * (1 - 2 * pad)) break;
      }
      center = [(sw[0] + ne[0]) / 2, (sw[1] + ne[1]) / 2];
    } else {
      const v = view || DEFAULT_VIEW;
      center = v.center; z = Math.min(19, Math.max(1, Math.round(v.zoom)));
    }
    const [cx, cy] = project(center, z);
    return { center, z, left: cx - W / 2, top: cy - H / 2 };
  }

  function frameTiles({ z, left, top }, W, H) {
    const n = 2 ** z, out = [];
    for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + W) / TILE); tx++) {
      for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + H) / TILE); ty++) {
        if (ty >= 0 && ty < n) out.push({ z, x: ((tx % n) + n) % n, y: ty, tx, ty });
      }
    }
    return out;
  }

  const unproject = ([x, y], z) => {
    const n = worldPx(z);
    return [(Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI, (x / n) * 360 - 180];
  };

  const PDF_W = 2000;
  const MAP_MM = { w: 277, h: 168 };
  const pdfH = () => Math.round((PDF_W * MAP_MM.h) / MAP_MM.w);

  // Geografische hoeken [[zuid, west], [noord, oost]] van het kaartvlak dat de PDF toont (voor het kader in het beheer).
  function pdfBounds(houses, view, pdfView) {
    const H = pdfH(), f = pdfFrame(houses, view, PDF_W, H, pdfView);
    return { z: f.z, bounds: [unproject([f.left, f.top + H], f.z), unproject([f.left + PDF_W, f.top], f.z)] };
  }

  // Haalt de tegels voor de PDF en de omgeving alvast op, zodat de kaart ook offline werkt
  // (de service worker bewaart ze). Bewust beperkt om OpenStreetMap niet te belasten.
  async function prefetchTiles(houses, view, pdfView) {
    if (!navigator.onLine || !navigator.serviceWorker?.controller) return;
    const H = pdfH();
    const frame = pdfFrame(houses, view, PDF_W, H, pdfView);
    const list = frameTiles(frame, PDF_W, H);
    // uitzoomen: dezelfde omgeving op lagere zoomniveaus (max. 3 niveaus)
    for (let dz = 1; dz <= 3 && frame.z - dz >= 12; dz++) {
      const f = 2 ** dz;
      list.push(...frameTiles({ z: frame.z - dz, left: frame.left / f, top: frame.top / f }, PDF_W / f, H / f));
    }
    const seen = new Set();
    const urls = list.map((t) => TILE_URL.replace('{z}', t.z).replace('{x}', t.x).replace('{y}', t.y))
      .filter((u) => !seen.has(u) && seen.add(u)).slice(0, 250);
    const key = `sm-prefetch:${urls.length}:${urls[0]}`;
    try { if (localStorage.getItem(key)) return; } catch {}
    let i = 0;
    const worker = async () => {
      while (i < urls.length) {
        const u = urls[i++];
        try { await fetch(u, { mode: 'cors', credentials: 'omit' }); } catch {}
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    try { localStorage.setItem(key, '1'); } catch {}
  }

  // Tekent de kaart (tegels + huizen) op een canvas dat het gebied van alle huizen toont.
  async function renderMapCanvas(houses, view, W, H, showNumbers = true, pdfView) {
    const frame = pdfFrame(houses, view, W, H, pdfView);
    const { z, left, top } = frame;
    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d');
    g.fillStyle = '#e5e5e5'; g.fillRect(0, 0, W, H);

    const jobs = frameTiles(frame, W, H).map((t) =>
      loadTile(t.z, t.x, t.y).then((img) => img && g.drawImage(img, t.tx * TILE - left, t.ty * TILE - top)));
    await Promise.all(jobs);

    const px = (p) => { const [x, y] = project(p, z); return [x - left, y - top]; };
    const scale = W / 1600;
    for (const h of houses) {
      const st = STATUS[h.status] || STATUS.none;
      if (h.status === 'none') continue;
      g.beginPath();
      h.points.map(px).forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath();
      g.globalAlpha = 0.55; g.fillStyle = st.color; g.fill();
      g.globalAlpha = 1; g.lineWidth = 2 * scale; g.strokeStyle = st.stroke; g.stroke();
    }
    if (showNumbers) {
      g.font = `800 ${Math.round(15 * scale)}px system-ui, sans-serif`;
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.lineJoin = 'round'; g.lineWidth = 4.5 * scale;
      for (const h of houses) {
        const text = houseNumber(h);
        if (!text || h.status === 'none') continue;
        const ps = h.points.map(px);
        const xs = ps.map((p) => p[0]), ys = ps.map((p) => p[1]);
        const w = Math.max(...xs) - Math.min(...xs), hh = Math.max(...ys) - Math.min(...ys);
        if (w < g.measureText(text).width + 6 * scale || hh < 18 * scale) continue; // past niet in het huis
        const [x, y] = px(labelPoint(h.points));
        g.strokeStyle = 'rgba(10,30,20,.9)'; g.strokeText(text, x, y);
        g.fillStyle = '#fff'; g.fillText(text, x, y);
      }
    }
    // verplichte bronvermelding
    g.font = `${Math.round(12 * scale)}px sans-serif`;
    g.textAlign = 'right'; g.textBaseline = 'bottom';
    const txt = I18n.t('© OpenStreetMap-bijdragers');
    const tw = g.measureText(txt).width;
    g.fillStyle = 'rgba(255,255,255,.8)'; g.fillRect(W - tw - 16 * scale, H - 22 * scale, tw + 16 * scale, 22 * scale);
    g.fillStyle = '#333'; g.fillText(txt, W - 8 * scale, H - 5 * scale);
    return canvas;
  }

  // Logo laden als data-URL (voor jsPDF) met afmetingen.
  function loadLogo(url) {
    return new Promise((resolve) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = img.naturalWidth; c.height = img.naturalHeight;
        const g = c.getContext('2d');
        const jpeg = /\.jpe?g$/i.test(url);
        if (jpeg) { g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); }
        g.drawImage(img, 0, 0);
        resolve({ data: c.toDataURL(jpeg ? 'image/jpeg' : 'image/png', 0.92), format: jpeg ? 'JPEG' : 'PNG', w: c.width, h: c.height });
      };
      img.onerror = () => resolve(null);
      img.src = url;
    });
  }

  // ---------- QR-codes (qrcode-generator, /vendor/qrcode.js) ----------
  // Het app-icoon (PWA) staat in het midden van elke QR, zodat de codes herkenbaar zijn.
  let qrIconPromise = null;
  function loadQrIcon() {
    qrIconPromise = qrIconPromise || new Promise((resolve) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => resolve(null); // zonder icoon blijft de code gewoon scanbaar
      im.src = '/icons/icon-512.png';
    });
    return qrIconPromise;
  }

  // PNG-data-URL van een QR; px = breedte in pixels (incl. rustige rand van 2 modules).
  // Foutcorrectie H (±30 % herstelbaar): het icoon dekt in het midden ruim minder dan 6 % af.
  function qrDataUrl(text, px = 512, icon = null) {
    const qr = window.qrcode(0, 'H');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount(), quiet = 2, total = n + quiet * 2;
    const cell = Math.max(1, Math.floor(px / total));
    const c = document.createElement('canvas');
    c.width = c.height = cell * total;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = '#000';
    for (let r = 0; r < n; r++) for (let k = 0; k < n; k++) if (qr.isDark(r, k)) g.fillRect((k + quiet) * cell, (r + quiet) * cell, cell, cell);
    if (icon) {
      const plate = Math.round(n * 0.2) * cell, pad = Math.max(2, Math.round(cell * 0.6)), x = Math.round((c.width - plate) / 2);
      g.fillStyle = '#fff';
      g.beginPath();
      if (g.roundRect) g.roundRect(x, x, plate, plate, plate * 0.18); else g.rect(x, x, plate, plate);
      g.fill();
      g.drawImage(icon, x + pad, x + pad, plate - pad * 2, plate - pad * 2);
    }
    return c.toDataURL('image/png');
  }

  // De QR als één geheel: sitetitel in een band bovenaan, de code met het icoon, straat + huisnummer in een band onderaan.
  // Titel en adres zitten dus in de afbeelding zelf (ook als die los wordt gedeeld of afgedrukt). Geeft { data, w, h } terug.
  async function qrBadgeDataUrl({ url, top, bottom, icon, px = 640 }) {
    const band = Math.round(px * 0.17), W = px, H = px + band * 2, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    const qr = new Image(); qr.src = qrDataUrl(url, px, icon);
    await new Promise((r) => { qr.onload = r; qr.onerror = r; });
    g.imageSmoothingEnabled = false; g.drawImage(qr, 0, band, W, W); g.imageSmoothingEnabled = true;
    const text = (t, y, weight) => {
      let size = Math.round(band * 0.5);
      g.font = `${weight} ${size}px system-ui, sans-serif`;
      while (size > 12 && g.measureText(t).width > W - 40) { size -= 2; g.font = `${weight} ${size}px system-ui, sans-serif`; }
      g.fillStyle = '#111'; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(t, W / 2, y);
    };
    text(String(top || ''), band / 2 + 2, '600');
    text(String(bottom || ''), band + W + band / 2 - 2, 'bold');
    g.strokeStyle = '#111'; g.lineWidth = Math.max(4, Math.round(W * 0.012));
    g.strokeRect(g.lineWidth / 2, g.lineWidth / 2, W - g.lineWidth, H - g.lineWidth);
    return { data: c.toDataURL('image/png'), w: W, h: H };
  }

  // Het QR-kaartje als PNG-data-URL, om te tonen, te downloaden en te delen: links de QR met titel en adres
  // erin verwerkt, rechts logo en uitleg.
  async function qrCardDataUrl({ title, url, siteTitle, logo, lang }) {
    const T = I18n.tFor(lang || I18n.lang);
    const W = 900, H = 580, c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, H);
    g.strokeStyle = '#b8c2bc'; g.lineWidth = 3; g.setLineDash([12, 10]); g.strokeRect(10, 10, W - 20, H - 20); g.setLineDash([]);
    const icon = await loadQrIcon();
    const badge = await qrBadgeDataUrl({ url, top: siteTitle, bottom: title, icon });
    const bh = H - 80, bw = Math.round(bh * badge.w / badge.h);
    const im = new Image(); im.src = badge.data; await new Promise((r) => { im.onload = r; im.onerror = r; });
    g.drawImage(im, 40, 40, bw, bh);
    const rx = 40 + bw + 40, rw = W - rx - 40;
    const logoImg = logo ? await loadLogo(logo.url) : null;
    let ty = 60;
    if (logoImg) {
      const k = Math.min(110 / logoImg.h, rw / logoImg.w), w = logoImg.w * k, h = logoImg.h * k;
      const li = new Image(); li.src = logoImg.data; await new Promise((r) => { li.onload = r; li.onerror = r; });
      g.drawImage(li, rx, 50, w, h);
      ty = 50 + h + 30;
    }
    g.textAlign = 'left'; g.textBaseline = 'top'; g.fillStyle = '#444'; g.font = '30px system-ui, sans-serif';
    ['Scan deze code met de', 'camera van je telefoon en', 'wijzig in de app de status', 'van jouw huis.'].map((x) => T.t(x)).forEach((x, i) => g.fillText(x, rx, ty + i * 44, rw));
    g.fillStyle = '#888'; g.font = '22px system-ui, sans-serif'; g.textBaseline = 'alphabetic';
    g.fillText(T.t('Persoonlijke code voor dit huis:'), rx, H - 70, rw);
    g.fillText(T.t('niet delen.'), rx, H - 42, rw);
    return c.toDataURL('image/png');
  }

  // Afdrukbare A4 met per huis een kaartje (2 x 4): links de QR (met titel en adres erin verwerkt), rechts logo en uitleg; gesorteerd per straat.
  async function buildQrPdf({ title, items, logo, lang }) {
    const T = I18n.tFor(lang || I18n.lang);
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
    const logoImg = logo ? await loadLogo(logo.url) : null;
    const icon = await loadQrIcon();
    const cols = 2, rows = 4, mx = 10, my = 12, cw = (210 - mx * 2) / cols, ch = (297 - my * 2) / rows;
    const sorted = [...items].sort((a, b) => compareHouses({ street: a.street, number: a.number }, { street: b.street, number: b.number }));
    let i = 0;
    for (const it of sorted) {
      if (i > 0 && i % (cols * rows) === 0) doc.addPage();
      const k = i % (cols * rows), x = mx + (k % cols) * cw, y = my + Math.floor(k / cols) * ch;
      i++;
      doc.setDrawColor(190); doc.setLineDashPattern([1.5, 1.5], 0); doc.rect(x + 1, y + 1, cw - 2, ch - 2); doc.setLineDashPattern([], 0);
      const badge = await qrBadgeDataUrl({ url: it.url, top: title, bottom: it.title, icon, px: 560 });
      const bh = ch - 8, bw = bh * badge.w / badge.h;
      doc.addImage(badge.data, 'PNG', x + 4, y + 4, bw, bh);
      const rx = x + bw + 10, rw = cw - bw - 16;
      let ty = y + 12;
      if (logoImg) {
        const kk = Math.min(12 / logoImg.h, rw / logoImg.w);
        doc.addImage(logoImg.data, logoImg.format, rx, y + 5, logoImg.w * kk, logoImg.h * kk);
        ty = y + 5 + logoImg.h * kk + 6;
      }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(9); doc.setTextColor(60);
      doc.text(doc.splitTextToSize(T.t('Scan deze code met de camera van je telefoon en wijzig in de app de status van jouw huis.'), rw), rx, ty);
      doc.setFontSize(7); doc.setTextColor(120);
      doc.text(doc.splitTextToSize(T.t('Persoonlijke code voor dit huis: niet delen.'), rw), rx, y + ch - 8);
    }
    return doc;
  }

  // ---------- tekst met emoji in de PDF ----------
  // De standaardlettertypen van jsPDF kennen geen emoji (en geen tekens buiten WinAnsi). Zulke tekens
  // tekenen we als plaatje via een canvas, met het emoji-lettertype van het apparaat zelf.
  const WINANSI_EXTRA = '€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ';
  const isWinAnsi = (ch) => {
    const c = ch.codePointAt(0);
    return (c >= 0x20 && c <= 0x7e) || (c >= 0xa0 && c <= 0xff) || WINANSI_EXTRA.includes(ch);
  };
  const EMOJI_RE = /(\p{Regional_Indicator}{2}|[0-9#*]️?⃣|\p{Extended_Pictographic}(?:️|[\u{1F3FB}-\u{1F3FF}]|‍\p{Extended_Pictographic})*️?)/u;
  const EMOJI_FONT = '"Apple Color Emoji","Segoe UI Emoji","Noto Color Emoji","Twemoji Mozilla",sans-serif';
  const PT_MM = 25.4 / 72;

  function tokenize(para) {
    const out = [];
    const pushText = (str) => {
      let run = '';
      const flush = () => { if (run) { run.split(/(\s+)/).filter(Boolean).forEach((w) => out.push({ t: 'text', s: w })); run = ''; } };
      for (const ch of str) {
        if (isWinAnsi(ch) || /\s/.test(ch)) run += ch;
        else if (/[‍️̀-ͯ]/.test(ch)) continue; // losse combinatietekens overslaan
        else { flush(); out.push({ t: 'glyph', s: ch, emoji: false }); }
      }
      flush();
    };
    para.split(EMOJI_RE).forEach((part, i) => {
      if (!part) return;
      if (i % 2 === 1 && !(part.length <= 2 && isWinAnsi(part[0]) && [...part].length === 1)) out.push({ t: 'glyph', s: part, emoji: true });
      else pushText(part); // ©, ® e.d. blijven gewone tekst
    });
    return out;
  }

  const glyphCache = new Map();
  function glyphImage(str, emoji) {
    if (glyphCache.has(str)) return glyphCache.get(str);
    const SIZE = 192;
    const c = document.createElement('canvas');
    c.width = SIZE; c.height = SIZE;
    const g = c.getContext('2d', { willReadFrequently: true });
    g.font = `128px ${emoji ? EMOJI_FONT : 'sans-serif'}`;
    g.textAlign = 'center'; g.textBaseline = 'middle';
    g.fillStyle = '#000';
    g.fillText(str, SIZE / 2, SIZE / 2 + 6);
    const px = g.getImageData(0, 0, SIZE, SIZE).data;
    let ink = false;
    for (let i = 3; i < px.length; i += 4) if (px[i] > 8) { ink = true; break; }
    const img = ink ? { data: c.toDataURL('image/png'), alias: `g-${[...str].map((ch) => ch.codePointAt(0).toString(16)).join('-')}` } : null;
    glyphCache.set(str, img);
    return img;
  }

  // Breekt tekst (met \n en emoji) af op maxW mm; geeft regels met tokens terug.
  function layoutRich(doc, text, maxW, sizePt) {
    const em = sizePt * PT_MM, gw = em * 1.3;
    const lines = [];
    for (const para of String(text).split('\n')) {
      let line = [], w = 0;
      const push = () => {
        while (line.length && line[line.length - 1].t === 'text' && /^\s+$/.test(line[line.length - 1].s)) w -= line.pop().w;
        lines.push({ tokens: line, w });
        line = []; w = 0;
      };
      for (const tok of tokenize(para)) {
        tok.w = tok.t === 'glyph' ? gw : doc.getTextWidth(tok.s);
        const space = tok.t === 'text' && /^\s+$/.test(tok.s);
        if (space && !line.length) continue;
        if (!space && w + tok.w > maxW && line.length) push();
        if (tok.t === 'text' && tok.w > maxW) { // een woord dat nooit past: teken voor teken afbreken
          let piece = '';
          for (const ch of tok.s) {
            if (doc.getTextWidth(piece + ch) > maxW - w && piece) { line.push({ t: 'text', s: piece, w: doc.getTextWidth(piece) }); w += doc.getTextWidth(piece); push(); piece = ''; }
            piece += ch;
          }
          if (piece) { const pw = doc.getTextWidth(piece); line.push({ t: 'text', s: piece, w: pw }); w += pw; }
          continue;
        }
        line.push(tok); w += tok.w;
      }
      push();
    }
    return lines;
  }

  function drawRichLine(doc, line, x, y, sizePt) {
    const em = sizePt * PT_MM;
    let cx = x;
    for (const tok of line.tokens) {
      if (tok.t === 'glyph') {
        const img = glyphImage(tok.s, tok.emoji);
        if (img) {
          const size = em * 1.5; // het plaatje is 1,5x de letterhoogte (ruimte rond het teken)
          doc.addImage(img.data, 'PNG', cx + tok.w / 2 - size / 2, y - em * 0.35 - size / 2, size, size, img.alias);
        }
      } else {
        doc.text(tok.s, cx, y);
      }
      cx += tok.w;
    }
  }

  // Eén regel tekst (zonder afbreken), bv. koppen en de overzichtsregels.
  function richText(doc, text, x, y, sizePt, maxW = Infinity) {
    const [first] = layoutRich(doc, text, maxW, sizePt);
    if (first) drawRichLine(doc, first, x, y, sizePt);
  }

  async function buildPdf({ title, houses, view, pdfView, intro, logo, showNumbers = true }) {
    const { jsPDF } = window.jspdf;
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const pw = 297, ph = 210, margin = 10;
    const logoImg = logo ? await loadLogo(logo.url) : null;

    const header = (text, size) => {
      let x = margin;
      if (logoImg) {
        const maxH = 14, maxW = 45;
        const k = Math.min(maxH / logoImg.h, maxW / logoImg.w);
        const w = logoImg.w * k, h = logoImg.h * k;
        doc.addImage(logoImg.data, logoImg.format, margin, 16 - h, w, h);
        x += w + 4;
      }
      doc.setFont('helvetica', 'bold'); doc.setFontSize(size); doc.setTextColor(0);
      richText(doc, text, x, 14, size);
    };

    header(title, 18);
    doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
    doc.setTextColor(100);
    const now = new Date();
    const stand = `${now.toLocaleDateString(I18n.locale, { day: 'numeric', month: 'long', year: 'numeric' })} ${now.toLocaleTimeString(I18n.locale, { hour: '2-digit', minute: '2-digit', hour12: false })}`;
    doc.text(I18n.t('Stand van {stand}', { stand }), pw - margin, 14, { align: 'right' });
    doc.setTextColor(0);

    const mapW = pw - 2 * margin, mapH = (mapW * MAP_MM.h) / MAP_MM.w;
    const canvas = await renderMapCanvas(houses, view, PDF_W, pdfH(), showNumbers, pdfView);
    doc.addImage(canvas.toDataURL('image/jpeg', 0.92), 'JPEG', margin, 20, mapW, mapH);
    doc.setDrawColor(150); doc.rect(margin, 20, mapW, mapH);

    // legenda
    const counts = { green: 0, red: 0 };
    houses.forEach((h) => { if (counts[h.status] !== undefined) counts[h.status]++; });
    let x = margin;
    const ly = 20 + mapH + 7;
    for (const k of ['green', 'red']) {
      doc.setFillColor(STATUS[k].color); doc.circle(x + 2, ly - 1.5, 2, 'F');
      doc.setFontSize(10);
      doc.text(`${STATUS[k].name} (${counts[k]})`, x + 6, ly);
      x += 40;
    }

    // tweede pagina: toelichting en overzicht van de huizen
    const named = houses.filter((h) => (h.number || h.label) && h.status !== 'none').sort(compareHouses);
    let y = 0;
    const newPage = (text) => { doc.addPage(); header(text, 14); y = 26; };
    const room = (need) => { if (y + need > ph - margin) { newPage(I18n.t('{title} – vervolg', { title })); } };

    if (intro) {
      newPage(I18n.t('{title} – toelichting', { title }));
      doc.setFont('helvetica', 'normal'); doc.setFontSize(11); doc.setTextColor(0);
      for (const line of layoutRich(doc, intro, pw - 2 * margin, 11)) {
        room(6);
        drawRichLine(doc, line, margin, y, 11);
        y += 5.6;
      }
      y += 6;
    }
    if (named.length) {
      if (!intro) newPage(I18n.t('{title} – overzicht', { title }));
      else { room(20); doc.setFont('helvetica', 'bold'); doc.setFontSize(13); doc.text(I18n.t('Overzicht'), margin, y); y += 8; }
      doc.setFont('helvetica', 'normal'); doc.setFontSize(10);
      const colW = 90, top = y;
      let col = 0;
      for (const h of named) {
        if (y > ph - margin) { col++; y = top; if (col > 2) { newPage(I18n.t('{title} – overzicht', { title })); col = 0; } }
        const cx = margin + col * colW;
        doc.setFillColor(STATUS[h.status].color); doc.circle(cx + 2, y - 1, 1.8, 'F');
        richText(doc, h.note ? `${houseTitle(h)} – ${h.note}` : houseTitle(h), cx + 6, y, 10, colW - 10);
        y += 6;
      }
    }
    return doc;
  }

  // Alleen de kaart mag zoomen met pinch; de pagina/app zelf niet (iOS Safari negeert user-scalable=no).
  ['gesturestart', 'gesturechange', 'gestureend'].forEach((ev) =>
    document.addEventListener(ev, (e) => e.preventDefault(), { passive: false }));

  function toast(msg) {
    const t = document.createElement('div');
    t.className = 'toast'; t.textContent = msg; t.setAttribute('role', 'status');
    document.body.append(t);
    setTimeout(() => t.remove(), 2800);
  }

  // Beta-build: de server zet <meta name="sm-channel" content="beta">; dan staat "BETA" bij de naam en in de tabtitel.
  const BETA = document.querySelector('meta[name="sm-channel"]')?.content === 'beta';
  const docTitle = (t) => (BETA ? `${t} · BETA` : t);
  function setHeading(el, text) {
    el.textContent = text;
    if (BETA) { const b = document.createElement('span'); b.className = 'beta-tag'; b.textContent = 'BETA'; el.append(' ', b); }
  }

  // Overlay met aantal en percentage per status (beheerkaart en voorpagina); show = welke statusregels zichtbaar zijn.
  const pctFmt = new Intl.NumberFormat(I18n.locale, { style: 'percent', maximumFractionDigits: 0 });
  function renderStats(houses, show) {
    const $ = (id) => document.getElementById(id);
    const total = houses.length;
    $('house-stats').hidden = !total;
    if (!total) return;
    const n = { green: 0, red: 0, none: 0 };
    for (const h of houses) n[h.status in n ? h.status : 'none']++;
    $('hs-total').textContent = total;
    for (const k of ['green', 'red', 'none']) {
      $(`hs-${k}`).textContent = n[k];
      $(`hs-${k}-pct`).textContent = pctFmt.format(n[k] / total);
    }
    $('hs-green-row').hidden = !show.green;
    $('hs-red-row').hidden = !show.red;
    $('hs-none-row').hidden = !show.none || !n.none;
    $('hs-bar-green').style.width = show.green ? `${(n.green / total) * 100}%` : '0';
    $('hs-bar-red').style.width = show.red ? `${(n.red / total) * 100}%` : '0';
    $('hs-bar').hidden = !show.green && !show.red;
  }

  window.Wijk = { BETA, renderStats, docTitle, setHeading, loadQrIcon, qrDataUrl, qrCardDataUrl, buildQrPdf, toast, setLabels, applyLabels, STATUS, createMap, houseStyle, buildPdf, prefetchTiles, pdfBounds, PDF_W, DEFAULT_VIEW, houseTitle, compareHouses, natCompare, labelPoint, createNumberLayer };
})();
