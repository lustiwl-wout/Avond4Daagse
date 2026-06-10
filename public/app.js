// Bezoekerspagina: toont de routes van dag 1 t/m 4 en volgt je met GPS.
// Alle routes starten en eindigen op het vaste start/finish-punt.
const ALMERE_CENTER = { lat: 52.3508, lng: 5.2647 };
const DAY_COLORS = { 1: '#dc2626', 2: '#2563eb', 3: '#16a34a', 4: '#9333ea' };

let map;
let infoWindow;
let selectedDay = 'all';
let startFinish = null;
const routes = {}; // day -> { polyline, bounds, distance_m }

// Op een groot scherm de uitleg standaard openklappen; op mobiel dichtgeklapt
// zodat de kaart de ruimte krijgt.
if (window.innerWidth > 720) document.getElementById('info-details').open = true;

async function loadGoogleMaps() {
  const res = await fetch('/api/config');
  const config = await res.json();
  if (!config.googleMapsApiKey) {
    document.getElementById('map').innerHTML =
      '<p style="padding:2rem">⚠️ Geen Google Maps API-key geconfigureerd. Zet de omgevingsvariabele <code>GOOGLE_MAPS_API_KEY</code>.</p>';
    return;
  }
  startFinish = config.startFinish;
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${config.googleMapsApiKey}&callback=initMap`;
  script.async = true;
  document.head.appendChild(script);
}

window.initMap = async function () {
  map = new google.maps.Map(document.getElementById('map'), {
    center: startFinish || ALMERE_CENTER,
    zoom: startFinish ? 15 : 13,
    streetViewControl: true, // het gele poppetje voor Street View
    mapTypeControl: false,
    fullscreenControl: true,
  });
  infoWindow = new google.maps.InfoWindow();

  if (startFinish) {
    const flag = new google.maps.Marker({
      position: startFinish,
      map,
      title: 'Start & finish',
      label: { text: '🏁', fontSize: '14px' },
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 13,
        fillColor: '#0f172a',
        fillOpacity: 1,
        strokeColor: '#fff',
        strokeWeight: 2,
      },
      zIndex: 999,
    });
    flag.addListener('click', () => {
      const div = document.createElement('div');
      div.className = 'point-menu';
      const title = document.createElement('strong');
      title.textContent = '🏁 Start & finish van alle dagen';
      div.appendChild(title);
      const svBtn = document.createElement('button');
      svBtn.textContent = '👀 Bekijk in Street View';
      svBtn.addEventListener('click', () => {
        infoWindow.close();
        const pano = map.getStreetView();
        pano.setPosition(startFinish);
        pano.setPov({ heading: 0, pitch: 0 });
        pano.setVisible(true);
      });
      div.appendChild(svBtn);
      infoWindow.setContent(div);
      infoWindow.open({ anchor: flag, map });
    });
  }

  await loadRoutes();
};

async function loadRoutes() {
  const list = document.getElementById('distance-list');
  let rows = [];
  try {
    const res = await fetch('/api/routes');
    if (!res.ok) throw new Error();
    rows = await res.json();
  } catch {
    list.innerHTML = '<li class="hint">⚠️ Routes laden mislukt.</li>';
    return;
  }

  for (const row of rows) {
    const path = (row.path && row.path.length > 1 ? row.path : row.waypoints) || [];
    if (path.length < 2) continue;
    const polyline = new google.maps.Polyline({
      path,
      map,
      strokeColor: DAY_COLORS[row.day],
      strokeWeight: 5,
      strokeOpacity: 0.85,
    });
    const bounds = new google.maps.LatLngBounds();
    path.forEach((p) => bounds.extend(p));
    routes[row.day] = { polyline, bounds, distance_m: row.distance_m };
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
  const union = new google.maps.LatLngBounds();
  let any = false;
  for (let day = 1; day <= 4; day++) {
    const r = routes[day];
    if (!r) continue;
    const visible = showAll || Number(selectedDay) === day;
    r.polyline.setMap(visible ? map : null);
    if (visible) {
      union.union(r.bounds);
      any = true;
    }
  }
  if (any) map.fitBounds(union, 40);
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
loadGoogleMaps();
