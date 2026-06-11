// Bezoekerspagina: toont de routes van dag 1 t/m 4 (OpenStreetMap/Leaflet)
// en volgt je met GPS. Alle routes starten en eindigen op het vaste
// start/finish-punt. Street View loopt via Google (overlay).
const ALMERE_CENTER = { lat: 52.3508, lng: 5.2647 };

let map;
let selectedDay = 'all';
let startFinish = null;
let sponsorOpen = false;
let sponsorPlacing = false;
const routes = {}; // day -> { line, bounds, distance_m, path, pauseMarker, sponsorMarkers }

if (window.innerWidth > 720) document.getElementById('info-details').open = true;

async function init() {
  const res = await fetch('/api/config');
  const config = await res.json();
  setStreetViewKey(config.googleMapsApiKey || '');
  startFinish = config.startFinish;
  sponsorOpen = !!config.sponsorOpen;
  if (sponsorOpen) document.getElementById('sponsor-section').classList.remove('hidden');

  map = createMap('map', startFinish || ALMERE_CENTER, startFinish ? 15 : 13);
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
    const res = await fetch('/api/routes');
    if (!res.ok) throw new Error();
    rows = await res.json();
  } catch {
    list.innerHTML = '<li class="hint">Let op: routes laden mislukt.</li>';
    return;
  }

  for (const row of rows) {
    const path = (row.path && row.path.length > 1 ? row.path : row.waypoints) || [];
    if (path.length < 2) continue;
    const line = L.polyline(path.map((p) => [p.lat, p.lng]), {
      color: DAY_COLORS[row.day],
      weight: 5,
      opacity: 0.85,
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
      bounds: boundsOf(path),
      distance_m: row.distance_m,
      path,
      pauseMarker,
      sponsorMarkers: [],
    };
  }

  // Aangemelde sponsoracties als sterren op de kaart (alleen plek + actie).
  try {
    const sres = await fetch('/api/sponsors');
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

function renderDistanceList() {
  const list = document.getElementById('distance-list');
  list.innerHTML = '';
  for (let day = 1; day <= 4; day++) {
    const li = document.createElement('li');
    const km = routes[day] && routes[day].distance_m
      ? (routes[day].distance_m / 1000).toFixed(1).replace('.', ',') + ' km'
      : 'nog geen route';
    li.innerHTML = `<span><span class="day-dot" style="background:${DAY_COLORS[day]}"></span>Dag ${day}</span><strong>${km}</strong>`;
    list.appendChild(li);
  }
}

function applySelection() {
  const showAll = selectedDay === 'all';
  let union = null;
  for (let day = 1; day <= 4; day++) {
    const r = routes[day];
    if (!r) continue;
    const visible = showAll || Number(selectedDay) === day;
    if (visible) {
      r.line.addTo(map);
      if (r.pauseMarker) r.pauseMarker.addTo(map);
      r.sponsorMarkers.forEach((m) => m.addTo(map));
      union = union ? union.extend(r.bounds) : L.latLngBounds(r.bounds.getSouthWest(), r.bounds.getNorthEast());
    } else {
      r.line.remove();
      if (r.pauseMarker) r.pauseMarker.remove();
      r.sponsorMarkers.forEach((m) => m.remove());
    }
  }
  if (union) map.fitBounds(union.pad(0.07));
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
    const res = await fetch('/api/sponsors', {
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

document.querySelectorAll('.day-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelector('.day-tab.active').classList.remove('active');
    tab.classList.add('active');
    selectedDay = tab.dataset.day;
    applySelection();
  });
});

setupGps(() => map);
init();
