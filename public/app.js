// Bezoekerspagina: toont de routes van dag 1 t/m 4 (OpenStreetMap/Leaflet)
// en volgt je met GPS. Alle routes starten en eindigen op het vaste
// start/finish-punt. Street View loopt via Google (overlay).
const NL_CENTER = { lat: 52.2, lng: 5.3 };

let map;
let selectedDay = 1;
let schedule = null; // per dag {date, time}
let startFinish = null;
let sponsorOpen = false;
let sponsorPlacing = false;
const routes = {}; // day -> { line, bounds, distance_m, path, pauseMarker, sponsorMarkers }

if (window.innerWidth > 720) document.getElementById('info-details').open = true;

async function init() {
  const res = await fetch(api('/config'));
  const config = await res.json();
  const brandSub = document.getElementById('brand-sub');
  if (brandSub && config.orgName) brandSub.textContent = '' + config.orgName;
  setStreetViewKey(config.googleMapsApiKey || '');
  startFinish = config.startFinish;
  sponsorOpen = !!config.sponsorOpen;
  if (sponsorOpen) document.getElementById('sponsor-section').classList.remove('hidden');
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
      // Klikken op de lijn gaan naar de kaart (Street View / sponsorplek).
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
      sponsorMarkers: [],
    };
  }

  // Aangemelde sponsoracties als sterren op de kaart (alleen plek + actie).
  try {
    const sres = await fetch(api('/sponsors'));
    if (sres.ok) {
      for (const s of await sres.json()) {
        if (!routes[s.day]) continue;
        const marker = L.marker([s.lat, s.lng], {
          icon: starIcon(),
          zIndexOffset: 700,
          title: 'Sponsoractie',
        });
        marker.bindPopup(
          `<div class="point-menu"><strong>Sponsoractie (dag ${s.day})</strong><span>${escapeHtml(s.action)}</span></div>`
        );
        routes[s.day].sponsorMarkers.push(marker);
      }
    }
  } catch {
    // sponsoracties zijn optioneel
  }

  renderDistanceList();
  applySelection();
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
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
  const list = document.getElementById('distance-list');
  list.innerHTML = '';
  for (let day = 1; day <= 4; day++) {
    const li = document.createElement('li');
    const km = routes[day] && routes[day].distance_m
      ? (routes[day].distance_m / 1000).toFixed(1).replace('.', ',') + ' km'
      : 'nog geen route';
    const when = formatDayDate(day);
    li.innerHTML = `<span><span class="day-dot" style="background:${DAY_COLORS[day]}"></span>Dag ${day}${
      when ? `<br><span class="route-meta">${when}</span>` : ''
    }</span><strong>${km}</strong>`;
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
      r.sponsorMarkers.forEach((m) => m.addTo(map));
      map.fitBounds(r.bounds.pad(0.07));
    } else {
      r.line.remove();
      r.arrows.remove();
      if (r.pauseMarker) r.pauseMarker.remove();
      r.sponsorMarkers.forEach((m) => m.remove());
    }
  }
}

// --- Klikken op de kaart: sponsoractie plannen of Street View bekijken ---
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
  const point = { lat: e.latlng.lat, lng: e.latlng.lng };
  const hit = nearestVisibleRoute(point);
  if (sponsorPlacing) {
    if (!hit) {
      document.getElementById('sponsor-status').textContent =
        'Klik op (of vlak naast) de route op de plek waar je iets wilt doen.';
      return;
    }
    openSponsorForm(hit);
    return;
  }
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

// --- Sponsoractie aanmelden (alleen vóór de eerste loopdag) ---
const sponsorBtn = document.getElementById('sponsor-btn');
sponsorBtn.addEventListener('click', () => {
  sponsorPlacing = !sponsorPlacing;
  sponsorBtn.textContent = sponsorPlacing ? 'Annuleer' : 'Plan jouw sponsoractie';
  document.getElementById('sponsor-status').textContent = sponsorPlacing
    ? 'Klik op de kaart op de plek langs de route waar je jouw actie wilt doen.'
    : '';
});

function openSponsorForm(hit) {
  const div = document.createElement('div');
  div.className = 'point-menu';
  div.innerHTML = `<strong>Sponsoractie aanmelden (dag ${hit.day})</strong>`;
  const fields = [
    ['firstName', 'Voornaam'],
    ['lastName', 'Achternaam'],
    ['email', 'E-mailadres'],
    ['phone', 'Telefoonnummer'],
  ];
  const inputs = {};
  for (const [key, label] of fields) {
    const input = document.createElement('input');
    input.type = key === 'email' ? 'email' : key === 'phone' ? 'tel' : 'text';
    input.placeholder = label;
    inputs[key] = input;
    div.appendChild(input);
  }
  const action = document.createElement('textarea');
  action.placeholder = 'Wat wil je hier doen? (bijv. ranja, fruit, muziek)';
  div.appendChild(action);
  const status = document.createElement('span');
  status.className = 'hint';
  const submit = menuButton('Aanmelden', async () => {
    status.textContent = 'Versturen…';
    const res = await fetch(api('/sponsors'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        day: hit.day,
        lat: hit.lat,
        lng: hit.lng,
        firstName: inputs.firstName.value,
        lastName: inputs.lastName.value,
        email: inputs.email.value,
        phone: inputs.phone.value,
        action: action.value,
      }),
    });
    if (res.ok) {
      map.closePopup();
      sponsorPlacing = false;
      sponsorBtn.textContent = 'Plan jouw sponsoractie';
      document.getElementById('sponsor-status').textContent =
        'Dank je wel! Je actie staat op de kaart en we nemen contact met je op.';
      const marker = L.marker([hit.lat, hit.lng], { icon: starIcon(), zIndexOffset: 700 }).addTo(map);
      marker.bindPopup(
        `<div class="point-menu"><strong>Sponsoractie (dag ${hit.day})</strong><span>${escapeHtml(action.value)}</span></div>`
      );
      routes[hit.day].sponsorMarkers.push(marker);
    } else {
      const err = await res.json().catch(() => ({}));
      status.textContent = err.error || 'Aanmelden mislukt — probeer het opnieuw.';
    }
  });
  submit.className = 'primary';
  div.appendChild(submit);
  div.appendChild(status);
  openMapMenu(map, [hit.lat, hit.lng], div);
}

// --- Voortgang langs de route (GPS) ---
// De route is een lus (start = finish) en kan stukken bevatten die je twee
// keer loopt. Daarom onthouden we de vorige voortgang en kiezen we van alle
// plekken op de route binnen bereik degene die daar het dichtst bij ligt —
// zo springt de teller niet heen en weer.
const ON_ROUTE_M = 60;
let progressAlong = null;

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

function updateProgress(pos) {
  const box = document.getElementById('route-progress');
  const r = routes[selectedDay];
  if (!pos || !r) {
    box.classList.add('hidden');
    progressAlong = null;
    return;
  }
  const along = routeProgress(r.path, pos);
  if (along === null) {
    // Naast de route (bv. onderweg ernaartoe): geen voortgang tonen.
    box.classList.add('hidden');
    progressAlong = null;
    return;
  }
  progressAlong = along;
  const left = Math.max(0, r.total - along);
  const pct = Math.min(100, Math.round((along / r.total) * 100));
  document.getElementById('progress-fill').style.width = pct + '%';
  let text = `${fmtDist(along)} gelopen · nog ${fmtDist(left)} (${pct}%)`;
  if (r.pauseAlong !== null && r.pauseAlong - along > 25) {
    text += ` · pauze over ${fmtDist(r.pauseAlong - along)}`;
  }
  document.getElementById('progress-text').textContent = text;
  box.classList.remove('hidden');
}

function selectDayTab(day) {
  selectedDay = Number(day);
  document.querySelectorAll('.day-tab').forEach((tab) => {
    tab.classList.toggle('active', Number(tab.dataset.day) === selectedDay);
  });
  applySelection();
  // Voortgang hoort bij de gekozen dag: opnieuw bepalen met de huidige positie.
  progressAlong = null;
  if (typeof gps !== 'undefined') updateProgress(gps.getPosition());
}

document.querySelectorAll('.day-tab').forEach((tab) => {
  tab.addEventListener('click', () => selectDayTab(tab.dataset.day));
});

const gps = setupGps(() => map, updateProgress);
init();
