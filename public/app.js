// Bezoekerspagina: toont de routes van dag 1 t/m 4 (OpenStreetMap/Leaflet)
// en volgt je met GPS. Alle routes starten en eindigen op het vaste
// start/finish-punt. Street View loopt via Google (overlay).
const NL_CENTER = { lat: 52.2, lng: 5.3 };

let map;
let selectedDay = 1;
let schedule = null; // per dag {date, time}
let startFinish = null;
const routes = {}; // day -> { line, bounds, distance_m, path, pauseMarker }

if (window.innerWidth > 720) document.getElementById('info-details').open = true;

async function init() {
  const res = await fetch(api('/config'));
  const config = await res.json();
  const brandSub = document.getElementById('brand-sub');
  if (brandSub && config.orgName) brandSub.textContent = '' + config.orgName;
  setStreetViewKey(config.googleMapsApiKey || '');
  startFinish = config.startFinish;
  showAnnouncement(config.announcement);
  schedule = config.schedule || null;
  // Standaard de eerstvolgende loopdag tonen.
  selectDayTab(config.defaultDay || 1);

  map = createMap('map', startFinish || NL_CENTER, startFinish ? 15 : 8);
  map.on('click', onMapClick);

  if (startFinish) {
    const flag = L.marker([startFinish.lat, startFinish.lng], {
      icon: flagIcon(),
      zIndexOffset: 900,
      title: 'Start & finish',
    }).addTo(map);
    flag.on('click', () => {
      const div = document.createElement('div');
      div.className = 'point-menu';
      const title = document.createElement('strong');
      title.textContent = 'Start & finish van alle dagen';
      div.appendChild(title);
      div.appendChild(
        menuButton('Bekijk in Street View', () => {
          map.closePopup();
          openStreetView(startFinish.lat, startFinish.lng);
        })
      );
      openMapMenu(map, [startFinish.lat, startFinish.lng], div);
    });
  }

  await loadRoutes();
  loadRainNotice(config.defaultDay || 1);
}

async function loadRoutes() {
  const list = document.getElementById('distance-list');
  let rows = [];
  try {
    const res = await fetch(api('/routes'));
    if (!res.ok) throw new Error();
    rows = await res.json();
  } catch {
    list.innerHTML = '<li class="hint">Let op: routes laden mislukt.</li>';
    return;
  }

  for (const row of rows) {
    const path = (row.path && row.path.length > 1 ? row.path : row.waypoints) || [];
    if (path.length < 2) continue;
    let total = 0;
    for (let i = 0; i < path.length - 1; i++) total += distM(path[i], path[i + 1]);
    const line = L.polyline(path.map((p) => [p.lat, p.lng]), {
      color: DAY_COLORS[row.day],
      weight: 5,
      opacity: 0.85,
      // Klikken op de lijn gaan naar de kaart (Street View).
      interactive: false,
    }).addTo(map);
    const pauseMarker = row.pause
      ? L.marker([row.pause.lat, row.pause.lng], {
          icon: pauseIcon(),
          zIndexOffset: 800,
          title: `Pauzepunt dag ${row.day}`,
        })
      : null;
    routes[row.day] = {
      line,
      arrows: directionArrows(path, DAY_COLORS[row.day]),
      bounds: boundsOf(path),
      distance_m: row.distance_m,
      path,
      total,
      pauseAlong: row.pause ? nearestOnPath(path, row.pause).along : null,
      pauseMarker,
    };
  }

  renderDistanceList();
  applySelection();
}

// Mededeling van de organisatie als balk onder de header — wegklikbaar;
// komt pas terug als de tekst verandert (nieuwe melding).
function showAnnouncement(text) {
  showBanner('announce', text, `a4d-announce-gezien-${SLUG}`, text || '');
}

// Regenwaarschuwing: geen weerbericht per dag, maar één duidelijke
// mededeling wanneer er grote kans op regen is tijdens het loopvenster
// van de eerstvolgende loopdag (Open-Meteo, zonder key). We kijken naar
// de uurlijkse regenkans vanaf de starttijd tot ~3 uur erna — een natte
// ochtend telt dus niet mee.
const RAIN_WARN_PCT = 60;

async function loadRainNotice(day) {
  const e = schedule && schedule[day];
  if (!startFinish || !e || !e.date) return;
  const today = new Date().toISOString().slice(0, 10);
  const max = new Date(Date.now() + 15 * 86400000).toISOString().slice(0, 10);
  if (e.date < today || e.date > max) return;
  const startHour = e.time ? parseInt(e.time.split(':')[0], 10) : 17;
  const endHour = Math.min(23, startHour + 3);
  try {
    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${startFinish.lat}&longitude=${startFinish.lng}` +
      `&hourly=precipitation_probability&timezone=Europe%2FAmsterdam` +
      `&start_date=${e.date}&end_date=${e.date}`;
    const res = await fetch(url);
    if (!res.ok) return;
    const data = await res.json();
    const hours = (data.hourly && data.hourly.time) || [];
    let rain = null;
    hours.forEach((t, i) => {
      const hour = Number(t.slice(11, 13));
      if (hour < startHour || hour > endHour) return;
      const p = data.hourly.precipitation_probability[i];
      if (p != null && (rain === null || p > rain)) rain = p;
    });
    if (rain === null || rain < RAIN_WARN_PCT) return;
    const datum = new Intl.DateTimeFormat('nl-NL', {
      weekday: 'long',
      day: 'numeric',
      month: 'long',
    }).format(new Date(e.date + 'T12:00:00'));
    // Wegklikbaar; de datum is het kenmerk — weggeklikt voor deze loopdag
    // blijft weg (ook als het percentage wat schommelt), de volgende
    // loopdag is een nieuwe melding.
    showBanner(
      'rain-notice',
      `Grote kans op regen tijdens de wandeling op ${datum} (${rain}%) — denk aan een paraplu of regenkleding.`,
      `a4d-regen-gezien-${SLUG}`,
      e.date
    );
  } catch {
    // de waarschuwing is een extraatje
  }
}

function formatDayDate(day) {
  const e = schedule && schedule[day];
  if (!e || !e.date) return '';
  const txt = new Intl.DateTimeFormat('nl-NL', {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
  }).format(new Date(e.date + 'T12:00:00'));
  return e.time ? `${txt} · ${e.time} uur` : txt;
}

function renderDistanceList() {
  // De dag-keuzelijst meteen informatiever maken: afstand erbij.
  document.querySelectorAll('#day-select option').forEach((opt) => {
    const r = routes[Number(opt.value)];
    opt.textContent = `Dag ${opt.value}${
      r && r.distance_m ? ` · ${(r.distance_m / 1000).toFixed(1).replace('.', ',')} km` : ''
    }`;
  });
  const list = document.getElementById('distance-list');
  list.innerHTML = '';
  for (let day = 1; day <= 4; day++) {
    const li = document.createElement('li');
    const km = routes[day] && routes[day].distance_m
      ? (routes[day].distance_m / 1000).toFixed(1).replace('.', ',') + ' km'
      : 'nog geen route';
    const when = formatDayDate(day);
    const gpx = routes[day]
      ? ` · <a class="gpx-link" href="${api(`/gpx/${day}`)}" download>GPX</a>`
      : '';
    li.innerHTML = `<span><span class="day-dot" style="background:${DAY_COLORS[day]}"></span>Dag ${day}${
      when ? `<br><span class="route-meta">${when}</span>` : ''
    }</span><span><strong>${km}</strong>${gpx}</span>`;
    list.appendChild(li);
  }
}

function applySelection() {
  for (let day = 1; day <= 4; day++) {
    const r = routes[day];
    if (!r) continue;
    if (day === selectedDay) {
      r.line.addTo(map);
      r.arrows.addTo(map);
      if (r.pauseMarker) r.pauseMarker.addTo(map);
      map.fitBounds(r.bounds.pad(0.07));
    } else {
      r.line.remove();
      r.arrows.remove();
      if (r.pauseMarker) r.pauseMarker.remove();
    }
  }
}

// --- Klikken op de kaart: Street View bekijken ---
function nearestVisibleRoute(point) {
  let best = null;
  for (let day = 1; day <= 4; day++) {
    const r = routes[day];
    if (!r || !map.hasLayer(r.line)) continue;
    const n = nearestOnPath(r.path, point);
    if (!best || n.dist < best.dist) best = { day, ...n };
  }
  return best && best.dist <= 60 ? best : null;
}

function onMapClick(e) {
  // In de GPS-simulatie (/simulate) zet een klik de positie; geen popups.
  if (window.__gpsSimActive) return;
  const point = { lat: e.latlng.lat, lng: e.latlng.lng };
  const hit = nearestVisibleRoute(point);
  if (!hit) return;
  const div = document.createElement('div');
  div.className = 'point-menu';
  const title = document.createElement('strong');
  title.textContent = `Route dag ${hit.day}`;
  div.appendChild(title);
  div.appendChild(
    menuButton('Bekijk in Street View', () => {
      map.closePopup();
      openStreetView(hit.lat, hit.lng);
    })
  );
  openMapMenu(map, [hit.lat, hit.lng], div);
}

// --- Voortgang langs de route (GPS) ---
// De route is een lus (start = finish) en kan stukken bevatten die je twee
// keer loopt. Daarom onthouden we de vorige voortgang en kiezen we van alle
// plekken op de route binnen bereik degene die daar het dichtst bij ligt —
// zo springt de teller niet heen en weer.
const ON_ROUTE_M = 60;
let progressAlong = null;
// Recente (tijd, positie-langs-route)-metingen voor het eigen wandeltempo.
let paceSamples = [];

function routeProgress(path, pos) {
  const candidates = [];
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
      const px = (pos.lng - a.lng) * Math.cos(lat0);
      const py = pos.lat - a.lat;
      t = Math.max(0, Math.min(1, (px * bx + py * by) / (bx * bx + by * by)));
    }
    const proj = { lat: a.lat + (b.lat - a.lat) * t, lng: a.lng + (b.lng - a.lng) * t };
    const d = distM(pos, proj);
    if (d <= ON_ROUTE_M) candidates.push({ dist: d, along: cum + segLen * t });
    cum += segLen;
  }
  if (candidates.length === 0) return null;
  if (progressAlong === null) {
    return candidates.reduce((x, y) => (y.dist < x.dist ? y : x)).along;
  }
  return candidates.reduce((x, y) =>
    Math.abs(y.along - progressAlong) < Math.abs(x.along - progressAlong) ? y : x
  ).along;
}

function fmtDist(m) {
  return m < 950 ? `${Math.max(0, Math.round(m / 50) * 50)} m` : `${(m / 1000).toFixed(1).replace('.', ',')} km`;
}

// Het gelopen deel van het pad, van de start tot `along` meter.
function pathUpTo(path, along) {
  const pts = [[path[0].lat, path[0].lng]];
  let cum = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const seg = distM(path[i], path[i + 1]);
    if (cum + seg >= along) {
      const t = seg > 0 ? (along - cum) / seg : 0;
      pts.push([
        path[i].lat + (path[i + 1].lat - path[i].lat) * t,
        path[i].lng + (path[i + 1].lng - path[i].lng) * t,
      ]);
      return pts;
    }
    cum += seg;
    pts.push([path[i + 1].lat, path[i + 1].lng]);
  }
  return pts;
}

// Witte halfdoorzichtige lijn óver het gelopen deel: dimt de routekleur,
// zodat je op de kaart ziet wat er al achter je ligt.
let walkedLine = null;

function updateWalkedLine(path, along) {
  if (along === null) {
    if (walkedLine) walkedLine.remove();
    walkedLine = null;
    return;
  }
  if (!walkedLine) {
    walkedLine = L.polyline([], { color: '#ffffff', weight: 5, opacity: 0.65, interactive: false }).addTo(map);
  }
  walkedLine.setLatLngs(pathUpTo(path, along));
}

function updateProgress(pos) {
  const box = document.getElementById('route-progress');
  const r = routes[selectedDay];
  if (!pos || !r) {
    box.classList.add('hidden');
    progressAlong = null;
    paceSamples = [];
    updateWalkedLine(null, null);
    return;
  }
  const along = routeProgress(r.path, pos);
  if (along === null) {
    // Naast de route (bv. onderweg ernaartoe): geen voortgang tonen.
    box.classList.add('hidden');
    progressAlong = null;
    paceSamples = [];
    updateWalkedLine(null, null);
    return;
  }
  progressAlong = along;
  updateWalkedLine(r.path, along);
  const left = Math.max(0, r.total - along);
  const pct = Math.min(100, Math.round((along / r.total) * 100));
  document.getElementById('progress-fill').style.width = pct + '%';
  document.getElementById('stat-done').textContent = fmtDist(along);
  document.getElementById('stat-left').textContent = fmtDist(left);
  // Derde blok: verwachte finishtijd zodra het eigen tempo bekend is,
  // tot die tijd het percentage.
  const eta = expectedFinish(along, left);
  document.getElementById('stat-third').textContent = eta ? `±${eta}` : `${pct}%`;
  document.getElementById('stat-third-label').textContent = eta ? 'verwachte finish' : 'voortgang';
  let text = eta ? `${pct}% van de route` : '';
  if (r.pauseAlong !== null && r.pauseAlong - along > 25) {
    text += `${text ? ' · ' : ''}pauzepunt over ${fmtDist(r.pauseAlong - along)}`;
  }
  document.getElementById('progress-text').textContent = text;
  box.classList.remove('hidden');
}

// Verwachte finishtijd uit het eigen, recent gemeten wandeltempo (laatste
// 10 minuten). Pas tonen na 2 minuten en 100 m voortgang, en alleen bij
// een geloofwaardig tempo.
function expectedFinish(along, left) {
  const now = Date.now();
  paceSamples.push({ t: now, along });
  paceSamples = paceSamples.filter((s) => now - s.t <= 10 * 60 * 1000);
  const first = paceSamples[0];
  const dt = (now - first.t) / 1000;
  const dAlong = along - first.along;
  if (dt < 120 || dAlong < 100) return null;
  const speed = dAlong / dt; // m/s
  if (speed < 0.2 || speed > 3) return null;
  const finish = new Date(now + (left / speed) * 1000);
  return `${String(finish.getHours()).padStart(2, '0')}:${String(finish.getMinutes()).padStart(2, '0')}`;
}

function selectDayTab(day) {
  selectedDay = Number(day);
  const select = document.getElementById('day-select');
  select.value = String(selectedDay);
  // Subtiele kleurhint van de gekozen dag.
  select.style.borderColor = DAY_COLORS[selectedDay];
  applySelection();
  // Voortgang hoort bij de gekozen dag: opnieuw bepalen met de huidige positie.
  progressAlong = null;
  paceSamples = [];
  if (typeof gps !== 'undefined') updateProgress(gps.getPosition());
}

document.getElementById('day-select').addEventListener('change', (e) => selectDayTab(e.target.value));

const gps = setupGps(() => map, updateProgress);
init();
