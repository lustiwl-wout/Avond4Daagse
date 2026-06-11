// Bezoekerspagina: toont de routes van dag 1 t/m 4 (OpenStreetMap/Leaflet)
// en volgt je met GPS. Alle routes starten en eindigen op het vaste
// start/finish-punt. Street View loopt via Google (overlay).
const ALMERE_CENTER = { lat: 52.3508, lng: 5.2647 };

let map;
let selectedDay = 'all';
let startFinish = null;
const routes = {}; // day -> { line, bounds, distance_m }

if (window.innerWidth > 720) document.getElementById('info-details').open = true;

async function init() {
  const res = await fetch('/api/config');
  const config = await res.json();
  setStreetViewKey(config.googleMapsApiKey || '');
  startFinish = config.startFinish;

  map = createMap('map', startFinish || ALMERE_CENTER, startFinish ? 15 : 13);

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
    routes[row.day] = { line, bounds: boundsOf(path), distance_m: row.distance_m };
  }

  renderDistanceList();
  applySelection();
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
      union = union ? union.extend(r.bounds) : L.latLngBounds(r.bounds.getSouthWest(), r.bounds.getNorthEast());
    } else {
      r.line.remove();
    }
  }
  if (union) map.fitBounds(union.pad(0.07));
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
