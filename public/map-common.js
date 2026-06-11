// Gedeelde kaartlaag: OpenStreetMap via Leaflet voor alle kaarten en routes.
// Google wordt alleen nog gebruikt voor Street View (overlay + printfoto's).
const DAY_COLORS = { 1: '#dc2626', 2: '#2563eb', 3: '#16a34a', 4: '#9333ea' };

function createMap(elementId, center, zoom) {
  const map = L.map(elementId).setView([center.lat, center.lng], zoom);
  const tiles = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
    maxZoom: 19,
    attribution:
      'Kaartgegevens &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bijdragers',
  }).addTo(map);
  // Reserve: laden de OSM-tegels een paar keer niet (sommige netwerken of
  // browsers blokkeren ze), wissel dan naar de CARTO-tegelserver.
  let tileErrors = 0;
  tiles.on('tileerror', () => {
    tileErrors++;
    if (tileErrors >= 3 && !map._fallbackTiles) {
      map._fallbackTiles = true;
      tiles.remove();
      L.tileLayer('https://basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}@2x.png', {
        maxZoom: 19,
        attribution:
          'Kaartgegevens &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-bijdragers &copy; CARTO',
      }).addTo(map);
    }
  });
  // Leaflet meet zijn formaat alleen bij het laden; meet opnieuw zodra de
  // kaartruimte verandert (bv. zijbalk die groeit na inloggen op mobiel).
  if (window.ResizeObserver) {
    new ResizeObserver(() => map.invalidateSize()).observe(document.getElementById(elementId));
  }
  setTimeout(() => map.invalidateSize(), 300);
  return map;
}

function htmlIcon(html, size, anchor) {
  return L.divIcon({ className: '', html, iconSize: size, iconAnchor: anchor });
}

// Start/finish: witte vlag in een donkere cirkel.
function flagIcon() {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">' +
    '<circle cx="17" cy="17" r="15" fill="#0f172a" stroke="#ffffff" stroke-width="2.5"/>' +
    '<path d="M12.5 8.5v17" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>' +
    '<path d="M12.5 9h10.5l-3 4 3 4H12.5z" fill="#ffffff"/>' +
    '</svg>';
  return htmlIcon(svg, [34, 34], [17, 17]);
}

// Genummerd rond punt (tussenpunten, conflictpunten).
function dotIcon(color, label = '') {
  return htmlIcon(`<div class="m-dot" style="background:${color}">${label}</div>`, [24, 24], [12, 12]);
}

// Genummerd ruitje (oversteekpunten).
function diamondIcon(color, label = '', dimmed = false) {
  return htmlIcon(
    `<div class="m-diamond${dimmed ? ' m-dimmed' : ''}" style="background:${color}"><span>${label}</span></div>`,
    [22, 22],
    [11, 11]
  );
}

function conflictIcon(approved) {
  return htmlIcon(
    `<div class="m-dot" style="background:${approved ? '#ca8a04' : '#dc2626'}">${approved ? '✓' : '!'}</div>`,
    [24, 24],
    [12, 12]
  );
}

// Blauwe GPS-stip.
function posIcon() {
  return htmlIcon('<div class="m-pos"></div>', [18, 18], [9, 9]);
}

function dashedLine(path, color) {
  return L.polyline(path.map((p) => [p.lat, p.lng]), {
    color,
    weight: 3,
    dashArray: '2 10',
    opacity: 0.95,
  });
}

function boundsOf(path) {
  return L.latLngBounds(path.map((p) => [p.lat, p.lng]));
}

// Afstand in meters tussen twee {lat,lng}-punten (vlakke benadering).
function distM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const lat0 = rad((a.lat + b.lat) / 2);
  const x = (rad(b.lng) - rad(a.lng)) * Math.cos(lat0) * R;
  const y = (rad(b.lat) - rad(a.lat)) * R;
  return Math.hypot(x, y);
}

// Dichtstbijzijnde plek op een pad bij `point`: afstand ertoe (m), het
// gesnapte punt zelf, en de afstand langs het pad.
function nearestOnPath(path, point) {
  let best = Infinity;
  let bestAlong = 0;
  let bestPoint = path[0];
  let cum = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const segLen = distM(a, b);
    let t = 0;
    if (segLen > 0) {
      const lat0 = ((a.lat + b.lat) / 2) * (Math.PI / 180);
      const bx = (b.lng - a.lng) * Math.cos(lat0);
      const by = b.lat - a.lat;
      const px = (point.lng - a.lng) * Math.cos(lat0);
      const py = point.lat - a.lat;
      t = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by)));
    }
    const proj = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    const d = distM(point, proj);
    if (d < best) {
      best = d;
      bestAlong = cum + segLen * t;
      bestPoint = proj;
    }
    cum += segLen;
  }
  return { dist: best, along: bestAlong, lat: bestPoint.lat, lng: bestPoint.lng };
}

// Kompasrichting (graden, 0 = noord, met de klok mee) van a naar b.
function bearingDeg(a, b) {
  const lat0 = ((a.lat + b.lat) / 2) * (Math.PI / 180);
  const dx = (b.lng - a.lng) * Math.cos(lat0);
  const dy = b.lat - a.lat;
  return (Math.atan2(dx, dy) * 180) / Math.PI;
}

// Looprichting: witte pijlpunten met een rand in de routekleur (zo steken ze
// af op de gekleurde lijn), om de `spacingM` meter langs de route en
// meedraaiend met de richting. Geeft een layerGroup terug.
function directionArrows(path, color, spacingM) {
  const group = L.layerGroup();
  if (!path || path.length < 2) return group;
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) total += distM(path[i], path[i + 1]);
  const spacing = spacingM || Math.max(150, Math.min(500, total / 12));
  let next = spacing / 2;
  let cum = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const a = path[i];
    const b = path[i + 1];
    const seg = distM(a, b);
    if (seg === 0) continue;
    while (cum + seg >= next) {
      const t = (next - cum) / seg;
      const lat = a.lat + (b.lat - a.lat) * t;
      const lng = a.lng + (b.lng - a.lng) * t;
      const rotation = Math.round(bearingDeg(a, b));
      group.addLayer(
        L.marker([lat, lng], {
          icon: htmlIcon(
            `<div class="m-arrow" style="transform: rotate(${rotation}deg)">` +
              `<svg viewBox="0 0 20 20" width="18" height="18">` +
              `<path d="M10 2.5 L16.5 14.5 L10 11 L3.5 14.5 Z" fill="#ffffff" stroke="${color}" stroke-width="1.8" stroke-linejoin="round"/>` +
              `</svg></div>`,
            [18, 18],
            [9, 9]
          ),
          interactive: false,
          zIndexOffset: 300,
        })
      );
      next += spacing;
    }
    cum += seg;
  }
  return group;
}

// Pauzepunt: koffiekopje-achtig 'P'-symbool.
function pauseIcon() {
  return htmlIcon('<div class="m-dot m-pause">P</div>', [26, 26], [13, 13]);
}

// Sponsoractie: ster.
function starIcon() {
  return htmlIcon('<div class="m-star">★</div>', [26, 26], [13, 13]);
}

function openMapMenu(map, latlng, contentDiv) {
  L.popup({ maxWidth: 280 }).setLatLng(latlng).setContent(contentDiv).openOn(map);
}

// --- Street View: het enige onderdeel dat nog via Google loopt ---
let svKey = '';
let svLoader = null;
let svPano = null;
let svOverlay = null;

function setStreetViewKey(key) {
  svKey = key;
}

function loadGoogleSv() {
  if (svLoader) return svLoader;
  svLoader = new Promise((resolve, reject) => {
    if (!svKey) return reject(new Error('Geen Google-key geconfigureerd.'));
    window.__svReady = () => resolve();
    const script = document.createElement('script');
    script.src = `https://maps.googleapis.com/maps/api/js?key=${svKey}&callback=__svReady`;
    script.async = true;
    script.onerror = () => reject(new Error('Street View laden mislukt.'));
    document.head.appendChild(script);
  });
  return svLoader;
}

async function openStreetView(lat, lng) {
  try {
    await loadGoogleSv();
  } catch (err) {
    alert(err.message || 'Street View kon niet geladen worden.');
    return;
  }
  if (!svOverlay) {
    svOverlay = document.createElement('div');
    svOverlay.className = 'sv-overlay';
    svOverlay.innerHTML =
      '<button class="sv-close" type="button">Sluit Street View</button><div class="sv-pano"></div>';
    document.body.appendChild(svOverlay);
    svOverlay.querySelector('.sv-close').addEventListener('click', () => {
      svOverlay.classList.add('hidden');
    });
  }
  // Zoek het dichtstbijzijnde bruikbare panorama: eerst echte Street View-
  // buitenbeelden, daarna alle bronnen inclusief 360°-gebruikersfoto's
  // (photospheres). Alleen beeld binnen MAX_SV_DIST meter van het punt is
  // nuttig — verder weg heb je er niets aan. De afstand wordt zelf
  // nagemeten en elk antwoord gevalideerd, want de service geeft soms een
  // leeg resultaat of negeert de opgegeven straal.
  const MAX_SV_DIST = 20;
  const svc = new google.maps.StreetViewService();
  const attempts = [
    { sources: [google.maps.StreetViewSource.OUTDOOR] },
    { sources: [google.maps.StreetViewSource.DEFAULT] },
  ];
  let pano = null;
  for (const attempt of attempts) {
    try {
      const { data } = await svc.getPanorama({
        location: { lat, lng },
        radius: MAX_SV_DIST,
        preference: google.maps.StreetViewPreference.NEAREST,
        sources: attempt.sources,
      });
      if (data && data.location && data.location.pano) {
        const loc = data.location.latLng;
        if (distM({ lat: loc.lat(), lng: loc.lng() }, { lat, lng }) <= MAX_SV_DIST) {
          pano = data;
          break;
        }
      }
    } catch {
      // volgende poging
    }
  }
  if (!pano) {
    alert('Op dit punt is geen Street View-beeld beschikbaar.');
    return;
  }

  // Altijd een vers panorama in een zichtbare overlay, met de camera
  // gericht op het aangeklikte punt.
  svOverlay.classList.remove('hidden');
  const panoDiv = svOverlay.querySelector('.sv-pano');
  panoDiv.innerHTML = '';
  const panoLoc = pano.location.latLng;
  const heading = bearingDeg({ lat: panoLoc.lat(), lng: panoLoc.lng() }, { lat, lng });
  svPano = new google.maps.StreetViewPanorama(panoDiv, {
    pano: pano.location.pano,
    pov: { heading, pitch: 0 },
  });
}

// Hulpfunctie voor menuknoppen.
function menuButton(text, onClick) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = text;
  btn.addEventListener('click', onClick);
  return btn;
}
