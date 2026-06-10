// Bezoekerspagina: toont de routes van dag 1 t/m 4 en volgt je met GPS.
// Alle routes starten en eindigen op het vaste start/finish-punt.
const ALMERE_CENTER = { lat: 52.3508, lng: 5.2647 };
const DAY_COLORS = { 1: '#dc2626', 2: '#2563eb', 3: '#16a34a', 4: '#9333ea' };

let map;
let infoWindow;
let selectedDay = 'all';
let startFinish = null;
const routes = {}; // day -> { polyline, bounds, distance_m }

// GPS-status
let watchId = null;
let posMarker = null;
let accuracyCircle = null;
let firstFix = true;

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

// --- GPS ---
const gpsStartBtn = document.getElementById('gps-start');
const gpsStopBtn = document.getElementById('gps-stop');
const followLabel = document.getElementById('follow-label');
const gpsStatus = document.getElementById('gps-status');

gpsStartBtn.addEventListener('click', () => {
  if (!navigator.geolocation) {
    gpsStatus.textContent = '⚠️ GPS wordt niet ondersteund door deze browser.';
    return;
  }
  firstFix = true;
  gpsStatus.textContent = 'GPS zoeken…';
  watchId = navigator.geolocation.watchPosition(onPosition, onGpsError, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 15000,
  });
  gpsStartBtn.classList.add('hidden');
  gpsStopBtn.classList.remove('hidden');
  followLabel.classList.remove('hidden');
});

gpsStopBtn.addEventListener('click', stopGps);

function stopGps() {
  if (watchId !== null) navigator.geolocation.clearWatch(watchId);
  watchId = null;
  if (posMarker) posMarker.setMap(null);
  if (accuracyCircle) accuracyCircle.setMap(null);
  posMarker = null;
  accuracyCircle = null;
  gpsStatus.textContent = '';
  gpsStartBtn.classList.remove('hidden');
  gpsStopBtn.classList.add('hidden');
  followLabel.classList.add('hidden');
}

function onPosition(position) {
  const pos = { lat: position.coords.latitude, lng: position.coords.longitude };
  if (!posMarker) {
    posMarker = new google.maps.Marker({
      position: pos,
      map,
      title: 'Jouw locatie',
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 9,
        fillColor: '#4285F4',
        fillOpacity: 1,
        strokeColor: '#fff',
        strokeWeight: 3,
      },
      zIndex: 1000,
    });
    accuracyCircle = new google.maps.Circle({
      map,
      fillColor: '#4285F4',
      fillOpacity: 0.12,
      strokeColor: '#4285F4',
      strokeOpacity: 0.3,
      strokeWeight: 1,
    });
  }
  posMarker.setPosition(pos);
  accuracyCircle.setCenter(pos);
  accuracyCircle.setRadius(position.coords.accuracy);
  gpsStatus.textContent = `Nauwkeurigheid: ±${Math.round(position.coords.accuracy)} m`;

  if (document.getElementById('follow-me').checked) {
    map.panTo(pos);
    if (firstFix) map.setZoom(16);
  }
  firstFix = false;
}

function onGpsError(err) {
  const messages = {
    1: '⚠️ Geen toestemming voor locatie. Sta locatietoegang toe in je browser.',
    2: '⚠️ Locatie niet beschikbaar.',
    3: '⚠️ GPS duurt te lang, opnieuw aan het proberen…',
  };
  gpsStatus.textContent = messages[err.code] || '⚠️ GPS-fout.';
  if (err.code === 1) stopGps();
}

loadGoogleMaps();
