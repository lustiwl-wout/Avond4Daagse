// Adminpagina: routes voor dag 1 t/m 4 tekenen en beheren.
// Start en finish liggen vast op één punt (voor alle dagen); de admin tekent
// alleen de tussenpunten. De route is altijd wandelend (TravelMode.WALKING).
const ALMERE_CENTER = { lat: 52.3508, lng: 5.2647 };
const DAY_COLORS = { 1: '#dc2626', 2: '#2563eb', 3: '#16a34a', 4: '#9333ea' };
const MAX_POINTS = 25; // Directions API: maximaal 25 tussenpunten

let map;
let directionsService;
let infoWindow;
let currentDay = 1;
let loggedIn = false;
let password = sessionStorage.getItem('a4d-admin-password') || '';
let config = { googleMapsApiKey: '', startFinish: null };
let startFinish = null;
let startMarker = null;

// Per dag: { points: [{lat,lng}], markers: [], renderer, distanceM, path }
const days = {};

async function loadGoogleMaps() {
  const res = await fetch('/api/config');
  config = await res.json();
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

window.initMap = function () {
  map = new google.maps.Map(document.getElementById('map'), {
    center: startFinish || ALMERE_CENTER,
    zoom: startFinish ? 15 : 13,
    streetViewControl: true, // het gele poppetje voor Street View
    mapTypeControl: false,
    fullscreenControl: false,
  });

  directionsService = new google.maps.DirectionsService();
  infoWindow = new google.maps.InfoWindow();

  for (let day = 1; day <= 4; day++) {
    days[day] = {
      points: [],
      markers: [],
      distanceM: 0,
      path: null,
      renderer: new google.maps.DirectionsRenderer({
        map,
        suppressMarkers: true,
        preserveViewport: true,
        polylineOptions: { strokeColor: DAY_COLORS[day], strokeWeight: 5, strokeOpacity: 0.8 },
      }),
    };
  }

  map.addListener('click', (e) => {
    if (!loggedIn) return;
    infoWindow.close();
    addPoint(currentDay, { lat: e.latLng.lat(), lng: e.latLng.lng() });
  });

  if (password) tryLogin(password);
};

// --- Inloggen ---
async function tryLogin(pwd) {
  const status = document.getElementById('login-status');
  status.textContent = 'Controleren…';
  try {
    const res = await fetch('/api/admin/check', { headers: { 'x-admin-password': pwd } });
    if (res.status === 204) {
      password = pwd;
      sessionStorage.setItem('a4d-admin-password', pwd);
      loggedIn = true;
      document.getElementById('login-section').classList.add('hidden');
      document.getElementById('editor').classList.remove('hidden');
      await ensureStartFinish();
      loadSavedRoutes();
    } else {
      const err = await res.json().catch(() => ({}));
      status.textContent = '⚠️ ' + (err.error || 'Inloggen mislukt.');
      sessionStorage.removeItem('a4d-admin-password');
    }
  } catch {
    status.textContent = '⚠️ Server niet bereikbaar.';
  }
}

document.getElementById('login-btn').addEventListener('click', () => {
  tryLogin(document.getElementById('admin-password').value);
});

document.getElementById('admin-password').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') tryLogin(e.target.value);
});

// --- Start & finish (vast punt voor alle dagen) ---
async function ensureStartFinish() {
  if (!startFinish) {
    setSaveStatus('Start & finish wordt opgezocht…');
    try {
      const adminRes = await fetch('/api/admin/config', {
        headers: { 'x-admin-password': password },
      });
      const adminConfig = await adminRes.json();
      const geocoder = new google.maps.Geocoder();
      const { results } = await geocoder.geocode({
        address: adminConfig.startAddress,
        region: 'NL',
      });
      const loc = results[0].geometry.location;
      startFinish = { lat: loc.lat(), lng: loc.lng() };
      await saveStartFinish();
      setSaveStatus('✅ Start & finish automatisch ingesteld.');
    } catch (err) {
      console.error('Geocoderen mislukt:', err);
      startFinish = { ...ALMERE_CENTER };
      setSaveStatus(
        '⚠️ Adres opzoeken lukte niet (Geocoding API ingeschakeld?). Sleep de 🏁 naar de juiste plek — dat wordt automatisch bewaard.',
        true
      );
    }
  }
  placeStartMarker();
  map.panTo(startFinish);
  map.setZoom(15);
}

function placeStartMarker() {
  if (startMarker) startMarker.setMap(null);
  startMarker = new google.maps.Marker({
    position: startFinish,
    map,
    draggable: true,
    title: 'Start & finish — versleep om te corrigeren',
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
  startMarker.addListener('click', () => {
    const div = document.createElement('div');
    div.className = 'point-menu';
    const title = document.createElement('strong');
    title.textContent = 'Start & finish';
    div.appendChild(title);
    const svBtn = document.createElement('button');
    svBtn.textContent = '👀 Bekijk in Street View';
    svBtn.addEventListener('click', () => {
      infoWindow.close();
      openStreetView(startFinish);
    });
    div.appendChild(svBtn);
    infoWindow.setContent(div);
    infoWindow.open({ anchor: startMarker, map });
  });
  startMarker.addListener('dragend', async () => {
    startFinish = {
      lat: startMarker.getPosition().lat(),
      lng: startMarker.getPosition().lng(),
    };
    await saveStartFinish();
    for (let day = 1; day <= 4; day++) {
      if (days[day].points.length > 0) updateRoute(day);
    }
    setSaveStatus('✅ Start & finish verplaatst. Sla de dagen opnieuw op om de routes bij te werken.');
  });
}

async function saveStartFinish() {
  await fetch('/api/admin/start-finish', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
    body: JSON.stringify(startFinish),
  });
}

// --- Tussenpunten bewerken ---
async function addPoint(day, point, index = null) {
  const d = days[day];
  if (d.points.length >= MAX_POINTS) {
    alert(`Maximaal ${MAX_POINTS} tussenpunten per route.`);
    return;
  }
  if (index === null) index = d.points.length;
  d.points.splice(index, 0, point);
  addMarker(day, point, index);
  relabelMarkers(day);
  const status = await updateRoute(day);
  if (status === 'ZERO_RESULTS' || status === 'NOT_FOUND') {
    // Geen wandelroute mogelijk via dit punt: direct weer terugdraaien.
    d.points.splice(index, 1);
    d.markers[index].setMap(null);
    d.markers.splice(index, 1);
    relabelMarkers(day);
    await updateRoute(day);
    setSaveStatus(
      '⚠️ Daar kan niet gewandeld worden — het punt is niet toegevoegd. Kies een plek op of vlak naast een straat of wandelpad.'
    );
  }
}

function removePoint(day, index) {
  const d = days[day];
  d.points.splice(index, 1);
  d.markers[index].setMap(null);
  d.markers.splice(index, 1);
  relabelMarkers(day);
  updateRoute(day);
}

function addMarker(day, point, index) {
  const d = days[day];
  const marker = new google.maps.Marker({
    position: point,
    map,
    draggable: true,
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 10,
      fillColor: DAY_COLORS[day],
      fillOpacity: 1,
      strokeColor: '#fff',
      strokeWeight: 2,
    },
  });
  marker.addListener('dragend', async () => {
    const i = d.markers.indexOf(marker);
    const previous = d.points[i];
    d.points[i] = { lat: marker.getPosition().lat(), lng: marker.getPosition().lng() };
    const status = await updateRoute(day);
    if (status === 'ZERO_RESULTS' || status === 'NOT_FOUND') {
      // Geen wandelroute mogelijk: punt terug naar de vorige plek.
      d.points[i] = previous;
      marker.setPosition(previous);
      await updateRoute(day);
      setSaveStatus('⚠️ Daar kan niet gewandeld worden — het punt is teruggezet.');
    }
  });
  marker.addListener('click', () => openPointMenu(day, marker));
  d.markers.splice(index, 0, marker);
}

function relabelMarkers(day) {
  days[day].markers.forEach((m, i) =>
    m.setLabel({ text: String(i + 1), color: '#fff', fontSize: '11px' })
  );
}

// Menu bij klik op een punt: verwijderen of een punt invoegen.
function openPointMenu(day, marker) {
  const d = days[day];
  const index = d.markers.indexOf(marker);
  const div = document.createElement('div');
  div.className = 'point-menu';

  const title = document.createElement('strong');
  title.textContent = `Tussenpunt ${index + 1} van ${d.points.length}`;
  div.appendChild(title);

  const svBtn = document.createElement('button');
  svBtn.textContent = '👀 Bekijk in Street View';
  svBtn.addEventListener('click', () => {
    infoWindow.close();
    openStreetView(d.points[index]);
  });
  div.appendChild(svBtn);

  const delBtn = document.createElement('button');
  delBtn.textContent = '🗑 Verwijder dit punt';
  delBtn.addEventListener('click', () => {
    infoWindow.close();
    removePoint(day, index);
  });
  div.appendChild(delBtn);

  if (index < d.points.length - 1) {
    const insertBtn = document.createElement('button');
    insertBtn.textContent = '➕ Punt invoegen hierna';
    insertBtn.addEventListener('click', () => {
      infoWindow.close();
      const a = d.points[index];
      const b = d.points[index + 1];
      // Nieuw punt halverwege; daarna verslepen naar de juiste plek.
      addPoint(day, { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }, index + 1);
    });
    div.appendChild(insertBtn);
  }

  infoWindow.setContent(div);
  infoWindow.open({ anchor: marker, map });
}

// Ingebouwde Street View van de kaart openen op een punt; sluiten via het
// kruisje linksboven in het panorama.
function openStreetView(point) {
  const pano = map.getStreetView();
  pano.setPosition(point);
  pano.setPov({ heading: 0, pitch: 0 });
  pano.setVisible(true);
}

// --- Route berekenen: altijd wandelend, altijd van en naar start/finish ---
// Geeft de Directions-status terug zodat de aanroeper een mislukt punt kan
// terugdraaien ('EMPTY' als er nog niets te berekenen valt).
function updateRoute(day) {
  const d = days[day];
  if (d.points.length < 1 || !startFinish) {
    d.renderer.setDirections({ routes: [] });
    d.distanceM = 0;
    d.path = null;
    updateInfo();
    return Promise.resolve('EMPTY');
  }
  return new Promise((resolve) => {
    directionsService.route(
      {
        origin: startFinish,
        destination: startFinish,
        waypoints: d.points.map((p) => ({ location: p, stopover: false })),
        travelMode: google.maps.TravelMode.WALKING,
      },
      (result, status) => {
        if (status === 'OK') {
          d.renderer.setDirections(result);
          const route = result.routes[0];
          d.distanceM = route.legs.reduce((sum, leg) => sum + leg.distance.value, 0);
          d.path = route.overview_path.map((p) => ({ lat: p.lat(), lng: p.lng() }));
        } else {
          console.error('Directions mislukt:', status);
          if (status === 'ZERO_RESULTS' || status === 'NOT_FOUND') {
            setSaveStatus('⚠️ Geen wandelroute mogelijk langs deze punten.');
          } else {
            setSaveStatus(`⚠️ Route berekenen mislukt (${status}). Probeer het opnieuw.`);
          }
        }
        updateInfo();
        resolve(status);
      }
    );
  });
}

function updateInfo() {
  const d = days[currentDay];
  document.getElementById('point-count').textContent = `${d.points.length} tussenpunten`;
  document.getElementById('distance').textContent =
    (d.distanceM / 1000).toFixed(1).replace('.', ',') + ' km';
}

function clearDay(day) {
  const d = days[day];
  d.points = [];
  d.markers.forEach((m) => m.setMap(null));
  d.markers = [];
  d.distanceM = 0;
  d.path = null;
  d.renderer.setDirections({ routes: [] });
  updateInfo();
}

// --- UI ---
document.querySelectorAll('.day-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelector('.day-tab.active').classList.remove('active');
    tab.classList.add('active');
    currentDay = Number(tab.dataset.day);
    document.getElementById('save-btn').textContent = `💾 Opslaan als route dag ${currentDay}`;
    document.getElementById('delete-btn').textContent = `❌ Verwijder route dag ${currentDay}`;
    updateInfo();
  });
});

document.getElementById('undo-btn').addEventListener('click', () => {
  const d = days[currentDay];
  if (d.points.length === 0) return;
  removePoint(currentDay, d.points.length - 1);
});

document.getElementById('clear-btn').addEventListener('click', () => clearDay(currentDay));

let statusTimer = null;
function setSaveStatus(text, sticky = false) {
  const el = document.getElementById('save-status');
  el.textContent = text;
  if (statusTimer) clearTimeout(statusTimer);
  statusTimer = null;
  if (!sticky && text) {
    statusTimer = setTimeout(() => (el.textContent = ''), 8000);
  }
}

document.getElementById('save-btn').addEventListener('click', async () => {
  const d = days[currentDay];
  if (d.points.length < 1) return setSaveStatus('Zet eerst minimaal 1 tussenpunt op de kaart.');
  const res = await fetch(`/api/routes/${currentDay}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
    body: JSON.stringify({ waypoints: d.points, path: d.path, distance_m: d.distanceM }),
  });
  if (res.ok) {
    setSaveStatus(`✅ Route dag ${currentDay} opgeslagen!`);
  } else {
    const err = await res.json().catch(() => ({}));
    setSaveStatus('⚠️ ' + (err.error || 'Opslaan mislukt.'));
  }
});

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm(`Route van dag ${currentDay} verwijderen uit de database?`)) return;
  const res = await fetch(`/api/routes/${currentDay}`, {
    method: 'DELETE',
    headers: { 'x-admin-password': password },
  });
  if (res.ok || res.status === 404) {
    clearDay(currentDay);
    setSaveStatus(`Route dag ${currentDay} verwijderd.`);
  } else {
    const err = await res.json().catch(() => ({}));
    setSaveStatus('⚠️ ' + (err.error || 'Verwijderen mislukt.'));
  }
});

// --- Opgeslagen routes inladen ---
async function loadSavedRoutes() {
  try {
    const res = await fetch('/api/routes');
    if (!res.ok) throw new Error();
    const rows = await res.json();
    for (const row of rows) {
      clearDay(row.day);
      for (const p of row.waypoints) {
        days[row.day].points.push(p);
        addMarker(row.day, p, days[row.day].points.length - 1);
      }
      relabelMarkers(row.day);
      updateRoute(row.day);
    }
  } catch {
    setSaveStatus('⚠️ Opgeslagen routes laden mislukt.');
  }
}

loadGoogleMaps();
