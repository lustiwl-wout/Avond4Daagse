// Adminpagina: routes voor dag 1 t/m 4 tekenen en beheren, plus de
// verkeersregelaarsmodus (oversteekpunten, teams en teamroutes).
// Start en finish liggen vast op één punt (voor alle dagen); de admin tekent
// alleen de tussenpunten. De wandelroute is altijd lopend (TravelMode.WALKING).
const ALMERE_CENTER = { lat: 52.3508, lng: 5.2647 };
const DAY_COLORS = { 1: '#dc2626', 2: '#2563eb', 3: '#16a34a', 4: '#9333ea' };
const MAX_POINTS = 25; // Directions API: maximaal 25 tussenpunten
const DIAMOND = 'M 0 -1 L 1 0 L 0 1 L -1 0 Z';

// Planningsinstellingen (overschreven door opgeslagen waarden uit de database).
let vrSettings = { walkKmh: 4, passMin: 8, bikeKmh: 15, marginMin: 2 };

let map;
let directionsService;
let infoWindow;
let currentDay = 1;
let editMode = 'route'; // 'route' | 'vr'
let loggedIn = false;
let password = sessionStorage.getItem('a4d-admin-password') || '';
let config = { googleMapsApiKey: '', startFinish: null };
let startFinish = null;
let startMarker = null;
let teams = [];
let teamRoutes = {}; // `${teamId}_${day}` -> { path, distance_m, conflicts }

// Kaartlagen van de verkeersregelaarsmodus (alleen voor de huidige dag).
let crossingMarkers = [];
let teamRoutePolylines = [];
let conflictMarkers = [];

// Per dag: { points, markers, renderer, distanceM, path, crossings }
const days = {};

// Conceptbeheer: elke wijziging wordt automatisch (kort na de wijziging)
// als conceptversie bewaard; publiceren wist de tussenversies.
let loadingRoutes = false;
const draftTimers = {};
const draftCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };

function scheduleDraftSave(day) {
  if (loadingRoutes || !loggedIn) return;
  clearTimeout(draftTimers[day]);
  draftTimers[day] = setTimeout(() => saveDraft(day), 800);
}

async function saveDraft(day) {
  const d = days[day];
  try {
    const res = await fetch(`/api/admin/drafts/${day}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({ waypoints: d.points, path: d.path, distance_m: d.distanceM }),
    });
    if (res.ok) {
      draftCounts[day] = (await res.json()).count;
      updateDraftStatus();
    }
  } catch {
    // volgende wijziging probeert het gewoon opnieuw
  }
}

function updateDraftStatus() {
  const n = draftCounts[currentDay];
  const text =
    n > 0
      ? `Concept — ${n} wijziging${n === 1 ? '' : 'en'} automatisch bewaard, nog niet definitief`
      : 'Definitieve versie — geen openstaande wijzigingen';
  document.getElementById('draft-status').textContent = text;
  document.getElementById('draft-status-rec').textContent = text;
}

async function loadGoogleMaps() {
  const res = await fetch('/api/config');
  config = await res.json();
  if (!config.googleMapsApiKey) {
    document.getElementById('map').innerHTML =
      '<p style="padding:2rem">Let op: Geen Google Maps API-key geconfigureerd. Zet de omgevingsvariabele <code>GOOGLE_MAPS_API_KEY</code>.</p>';
    return;
  }
  startFinish = config.startFinish;
  if (config.vrSettings) vrSettings = { ...vrSettings, ...config.vrSettings };
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
      crossings: [],
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
    const point = { lat: e.latLng.lat(), lng: e.latLng.lng() };
    if (editMode === 'route') addPoint(currentDay, point);
    else if (editMode === 'vr') addManualCrossing(point);
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
      await Promise.all([loadSavedRoutes(), loadTeams(), loadTeamRoutes()]);
      renderTeams();
      initSettingsInputs();
    } else {
      const err = await res.json().catch(() => ({}));
      status.textContent = 'Let op: ' + (err.error || 'Inloggen mislukt.');
      sessionStorage.removeItem('a4d-admin-password');
    }
  } catch {
    status.textContent = 'Let op: Server niet bereikbaar.';
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
      setSaveStatus('Start & finish automatisch ingesteld.');
    } catch (err) {
      console.error('Geocoderen mislukt:', err);
      startFinish = { ...ALMERE_CENTER };
      setSaveStatus(
        'Let op: Adres opzoeken lukte niet (Geocoding API ingeschakeld?). Sleep de start/finish-markering naar de juiste plek — dat wordt automatisch bewaard.',
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
    icon: flagIcon(),
    zIndex: 999,
  });
  startMarker.addListener('click', () => {
    const div = document.createElement('div');
    div.className = 'point-menu';
    const title = document.createElement('strong');
    title.textContent = 'Start & finish';
    div.appendChild(title);
    const svBtn = document.createElement('button');
    svBtn.textContent = 'Bekijk in Street View';
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
    setSaveStatus('Start & finish verplaatst. Sla de dagen opnieuw op om de routes bij te werken.');
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
      'Let op: Daar kan niet gewandeld worden — het punt is niet toegevoegd. Kies een plek op of vlak naast een straat of wandelpad.'
    );
  } else {
    scheduleDraftSave(day);
  }
}

function removePoint(day, index) {
  const d = days[day];
  d.points.splice(index, 1);
  d.markers[index].setMap(null);
  d.markers.splice(index, 1);
  relabelMarkers(day);
  updateRoute(day);
  scheduleDraftSave(day);
}

function addMarker(day, point, index) {
  const d = days[day];
  const marker = new google.maps.Marker({
    position: point,
    map: editMode === 'route' ? map : null,
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
      setSaveStatus('Let op: Daar kan niet gewandeld worden — het punt is teruggezet.');
    } else {
      scheduleDraftSave(day);
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

// Menu bij klik op een tussenpunt: Street View, verwijderen of punt invoegen.
function openPointMenu(day, marker) {
  const d = days[day];
  const index = d.markers.indexOf(marker);
  const div = document.createElement('div');
  div.className = 'point-menu';

  const title = document.createElement('strong');
  title.textContent = `Tussenpunt ${index + 1} van ${d.points.length}`;
  div.appendChild(title);

  const svBtn = document.createElement('button');
  svBtn.textContent = 'Bekijk in Street View';
  svBtn.addEventListener('click', () => {
    infoWindow.close();
    openStreetView(d.points[index]);
  });
  div.appendChild(svBtn);

  const delBtn = document.createElement('button');
  delBtn.textContent = 'Verwijder dit punt';
  delBtn.addEventListener('click', () => {
    infoWindow.close();
    removePoint(day, index);
  });
  div.appendChild(delBtn);

  if (index < d.points.length - 1) {
    const insertBtn = document.createElement('button');
    insertBtn.textContent = 'Punt invoegen hierna';
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
        relabelMarkers(day); // nummering altijd kloppend houden, ook na invoegen
        if (status === 'OK') {
          d.renderer.setDirections(result);
          const route = result.routes[0];
          d.distanceM = route.legs.reduce((sum, leg) => sum + leg.distance.value, 0);
          d.path = route.overview_path.map((p) => ({ lat: p.lat(), lng: p.lng() }));
        } else {
          console.error('Directions mislukt:', status);
          if (status === 'ZERO_RESULTS' || status === 'NOT_FOUND') {
            setSaveStatus('Let op: Geen wandelroute mogelijk langs deze punten.');
          } else {
            setSaveStatus(`Let op: Route berekenen mislukt (${status}). Probeer het opnieuw.`);
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
  const count = `${d.points.length} tussenpunten`;
  const km = (d.distanceM / 1000).toFixed(1).replace('.', ',') + ' km';
  document.getElementById('point-count').textContent = count;
  document.getElementById('distance').textContent = km;
  document.getElementById('rec-count').textContent = count;
  document.getElementById('rec-distance').textContent = km;
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
  scheduleDraftSave(day);
}

// Punten van een (concept)versie in de kaart laden zonder nieuwe concepten
// te genereren; aanroeper zet loadingRoutes.
function loadDayPoints(day, waypoints) {
  clearDay(day);
  for (const p of waypoints || []) {
    days[day].points.push(p);
    addMarker(day, p, days[day].points.length - 1);
  }
  relabelMarkers(day);
  updateRoute(day);
}

// --- UI: dagen en modus ---
function updateDayLabels() {
  document.getElementById('save-btn').textContent = `Maak route dag ${currentDay} definitief`;
  document.getElementById('delete-btn').textContent = `Verwijder route dag ${currentDay}`;
  document.getElementById('print-btn').textContent = `Printversie dag ${currentDay}`;
  document.getElementById('rec-save').textContent = `Definitief dag ${currentDay}`;
  updateDraftStatus();
}

document.querySelectorAll('.day-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelector('.day-tab.active').classList.remove('active');
    tab.classList.add('active');
    currentDay = Number(tab.dataset.day);
    updateDayLabels();
    updateInfo();
    refreshVrLayer();
    maybeAutoDetect();
  });
});

function setEditMode(m) {
  editMode = m;
  infoWindow.close();
  document.getElementById('mode-route').classList.toggle('active', m === 'route');
  document.getElementById('mode-rec').classList.toggle('active', m === 'rec');
  document.getElementById('mode-vr').classList.toggle('active', m === 'vr');
  document.getElementById('route-mode').classList.toggle('hidden', m !== 'route');
  document.getElementById('rec-mode').classList.toggle('hidden', m !== 'rec');
  document.getElementById('vr-mode').classList.toggle('hidden', m !== 'vr');
  // In verkeersregelaarsmodus geen tussenpunt-markers (wel de routes zelf);
  // in route- en vastlegmodus zijn alle punten zichtbaar en aanklikbaar.
  for (let day = 1; day <= 4; day++) {
    days[day].markers.forEach((mk) => mk.setMap(m === 'vr' ? null : map));
  }
  refreshVrLayer();
  maybeAutoDetect();
}

document.getElementById('mode-route').addEventListener('click', () => setEditMode('route'));
document.getElementById('mode-rec').addEventListener('click', () => setEditMode('rec'));
document.getElementById('mode-vr').addEventListener('click', () => setEditMode('vr'));

// --- Vastlegmodus: route al lopend vastleggen via GPS ---
const gps = setupGps(() => map);

document.getElementById('rec-add').addEventListener('click', () => {
  const pos = gps.getPosition();
  if (!pos) {
    setSaveStatus('Let op: Start eerst de GPS en wacht op een locatie.');
    return;
  }
  addPoint(currentDay, pos);
});

document.getElementById('rec-undo').addEventListener('click', () => {
  const d = days[currentDay];
  if (d.points.length === 0) return;
  removePoint(currentDay, d.points.length - 1);
});

document.getElementById('rec-save').addEventListener('click', () => saveCurrentDay());

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

function setVrStatus(text) {
  document.getElementById('vr-status').textContent = text;
}

async function saveCurrentDay() {
  const d = days[currentDay];
  if (d.points.length < 1) return setSaveStatus('Zet eerst minimaal 1 tussenpunt op de kaart.');
  clearTimeout(draftTimers[currentDay]);
  const res = await fetch(`/api/routes/${currentDay}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
    body: JSON.stringify({ waypoints: d.points, path: d.path, distance_m: d.distanceM }),
  });
  if (res.ok) {
    draftCounts[currentDay] = 0;
    updateDraftStatus();
    setSaveStatus(`Route dag ${currentDay} is nu definitief — tussenversies zijn opgeruimd.`);
    // Route gewijzigd: oversteekpunten op de achtergrond opnieuw detecteren
    // (verborgen punten en teamtoewijzingen blijven behouden).
    detectCrossings(currentDay, true);
  } else {
    const err = await res.json().catch(() => ({}));
    setSaveStatus('Let op: ' + (err.error || 'Publiceren mislukt.'));
  }
}

document.getElementById('save-btn').addEventListener('click', () => saveCurrentDay());

document.getElementById('print-btn').addEventListener('click', () => {
  window.open(`/print?day=${currentDay}`, '_blank');
});

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (!confirm(`Route van dag ${currentDay} verwijderen uit de database?`)) return;
  const res = await fetch(`/api/routes/${currentDay}`, {
    method: 'DELETE',
    headers: { 'x-admin-password': password },
  });
  if (res.ok || res.status === 404) {
    loadingRoutes = true;
    clearDay(currentDay);
    loadingRoutes = false;
    clearTimeout(draftTimers[currentDay]);
    draftCounts[currentDay] = 0;
    days[currentDay].crossings = [];
    refreshVrLayer();
    updateDraftStatus();
    setSaveStatus(`Route dag ${currentDay} verwijderd.`);
  } else {
    const err = await res.json().catch(() => ({}));
    setSaveStatus('Let op: ' + (err.error || 'Verwijderen mislukt.'));
  }
});

// --- Opgeslagen routes inladen (concept gaat vóór de definitieve versie) ---
async function loadSavedRoutes() {
  loadingRoutes = true;
  try {
    const res = await fetch('/api/routes');
    if (!res.ok) throw new Error();
    const rows = await res.json();
    for (const row of rows) {
      days[row.day].crossings = row.crossings || [];
      loadDayPoints(row.day, row.waypoints);
    }
    const draftsRes = await fetch('/api/admin/drafts', {
      headers: { 'x-admin-password': password },
    });
    if (draftsRes.ok) {
      for (const draft of await draftsRes.json()) {
        draftCounts[draft.day] = draft.count;
        loadDayPoints(draft.day, draft.waypoints);
      }
    }
  } catch {
    setSaveStatus('Let op: Opgeslagen routes laden mislukt.');
  } finally {
    loadingRoutes = false;
    updateDraftStatus();
  }
}

// Laatste wijziging terugdraaien (één conceptversie terug).
document.getElementById('revert-btn').addEventListener('click', async () => {
  if (draftCounts[currentDay] === 0) {
    setSaveStatus('Er zijn geen conceptwijzigingen om terug te draaien.');
    return;
  }
  clearTimeout(draftTimers[currentDay]);
  const res = await fetch(`/api/admin/drafts/${currentDay}/latest`, {
    method: 'DELETE',
    headers: { 'x-admin-password': password },
  });
  if (!res.ok) {
    setSaveStatus('Let op: Terugdraaien mislukt.');
    return;
  }
  const data = await res.json();
  draftCounts[currentDay] = data.count;
  loadingRoutes = true;
  if (data.draft) {
    loadDayPoints(currentDay, data.draft.waypoints);
  } else {
    // Geen concepten meer: terug naar de definitieve versie.
    const pubRes = await fetch('/api/routes');
    const rows = pubRes.ok ? await pubRes.json() : [];
    const row = rows.find((r) => r.day === currentDay);
    loadDayPoints(currentDay, row ? row.waypoints : []);
  }
  loadingRoutes = false;
  updateDraftStatus();
  setSaveStatus('Vorige versie hersteld.');
});

// =====================================================================
// Verkeersregelaarsmodus
// =====================================================================

async function loadTeams() {
  const res = await fetch('/api/teams');
  if (res.ok) teams = await res.json();
}

async function loadTeamRoutes() {
  const res = await fetch('/api/team-routes');
  if (!res.ok) return;
  const rows = await res.json();
  teamRoutes = {};
  for (const row of rows) {
    teamRoutes[`${row.team_id}_${row.day}`] = row;
  }
}

function teamById(id) {
  return teams.find((t) => t.id === id) || null;
}

// --- Planningsinstellingen ---
const SETTING_INPUTS = {
  walkKmh: 'set-walk',
  passMin: 'set-pass',
  bikeKmh: 'set-bike',
  marginMin: 'set-margin',
};

function initSettingsInputs() {
  for (const [key, id] of Object.entries(SETTING_INPUTS)) {
    const input = document.getElementById(id);
    input.value = vrSettings[key];
    input.addEventListener('change', async () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0) return;
      vrSettings[key] = value;
      await fetch('/api/admin/vr-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify(vrSettings),
      });
      // Nieuwe aannames: tijden direct opnieuw toetsen.
      await replanDay(currentDay, false);
    });
  }
}

// --- Tijd- en afstandsrekenwerk ---
function distM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const lat0 = rad((a.lat + b.lat) / 2);
  const x = (rad(b.lng) - rad(a.lng)) * Math.cos(lat0) * R;
  const y = (rad(b.lat) - rad(a.lat)) * R;
  return Math.hypot(x, y);
}

// Dichtstbijzijnde plek op het wandelpad bij `point`: afstand ertoe (m),
// het gesnapte punt zelf, en de afstand langs het pad (bepaalt wanneer de
// stoet een oversteekpunt bereikt).
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

function alongPath(path, point) {
  return nearestOnPath(path, point).along;
}

// Minuten na vertrek waarop de kop van de groep een punt bereikt.
function headMin(alongM) {
  return (alongM / 1000 / vrSettings.walkKmh) * 60;
}

// Minuten waarop het team weer weg mag: pas als álle 500 wandelaars voorbij zijn.
function leaveMin(alongM) {
  return headMin(alongM) + vrSettings.passMin;
}

// Geschatte fietstijd in minuten (hemelsbreed × omrijfactor) voor de planner.
function bikeMin(a, b) {
  return ((distM(a, b) * 1.35) / 1000 / vrSettings.bikeKmh) * 60;
}

const round1 = (n) => Math.round(n * 10) / 10;

// --- Kruisingen detecteren ---
// Draait automatisch na het opslaan van een route en bij het openen van de
// verkeersmodus; de knop is er om handmatig opnieuw te detecteren.
const detectingDays = new Set();

async function detectCrossings(day, silent = false) {
  const d = days[day];
  if (!d.path || detectingDays.has(day)) return;
  detectingDays.add(day);
  if (!silent) setVrStatus('Kruisingen zoeken… (dit kan even duren)');
  try {
    const res = await fetch(`/api/admin/crossings/${day}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({ path: d.path }),
    });
    if (res.ok) {
      d.crossings = await res.json();
      refreshVrLayer();
      if (!silent && d.crossings.length === 0) {
        setVrStatus(
          'Let op: Geen kruisingen gevonden — controleer of de route is opgeslagen en probeer opnieuw.'
        );
      }
      // Route of punten gewijzigd: direct automatisch herplannen en toetsen.
      if (d.crossings.length > 0 && teams.length > 0) {
        if (!silent) setVrStatus(`${d.crossings.length} oversteekpunten gevonden — teams plannen…`);
        await replanDay(day, true);
      } else if (!silent && d.crossings.length > 0) {
        setVrStatus(
          `${d.crossings.length} oversteekpunten gevonden. Maak teams aan, dan worden ze automatisch ingepland.`
        );
      }
    } else if (!silent) {
      const err = await res.json().catch(() => ({}));
      setVrStatus('Let op: ' + (err.error || 'Detecteren mislukt.'));
    }
  } catch {
    if (!silent) setVrStatus('Let op: Detecteren mislukt — server niet bereikbaar.');
  } finally {
    detectingDays.delete(day);
  }
}

// Automatisch detecteren zodra de verkeersmodus opengaat zonder kruisingen,
// of wanneer de punten nog van een oudere detectiemethode komen.
function maybeAutoDetect() {
  const d = days[currentDay];
  if (editMode !== 'vr' || !d.path) return;
  const crossings = d.crossings || [];
  if (crossings.length === 0 || !crossings.some((c) => c.src === 'osm')) {
    detectCrossings(currentDay);
  }
}

// Handmatig een oversteekpunt toevoegen (klik op de kaart in verkeersmodus);
// alleen mogelijk óp de wandelroute: een klik vlak naast de route wordt op de
// route gesnapt, verder weg wordt geweigerd. Blijft staan bij herdetectie.
const MANUAL_SNAP_M = 50;

async function addManualCrossing(clicked) {
  const d = days[currentDay];
  if (!d.path) {
    setVrStatus('Let op: Teken en bewaar eerst de wandelroute van deze dag.');
    return;
  }
  const nearest = nearestOnPath(d.path, clicked);
  if (nearest.dist > MANUAL_SNAP_M) {
    setVrStatus(
      `Let op: Punt niet toegevoegd: oversteekpunten moeten op de wandelroute liggen. Klik op (of vlak naast) de route van dag ${currentDay}.`
    );
    return;
  }
  const point = { lat: nearest.lat, lng: nearest.lng };
  let name = 'eigen punt';
  try {
    const geocoder = new google.maps.Geocoder();
    const { results } = await geocoder.geocode({ location: point });
    if (results[0]) {
      const route = results[0].address_components.find((c) => c.types.includes('route'));
      name = route ? route.long_name : results[0].formatted_address.split(',')[0];
    }
  } catch {
    // naam is niet kritisch
  }
  d.crossings.push({
    id: `m${Date.now()}`,
    lat: point.lat,
    lng: point.lng,
    name,
    hidden: false,
    team: null,
    manual: true,
  });
  await saveCrossings(currentDay);
  refreshVrLayer();
  setVrStatus(`Eigen punt "${name}" toegevoegd.`);
}

async function saveCrossings(day) {
  const res = await fetch(`/api/admin/crossings/${day}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
    body: JSON.stringify({ crossings: days[day].crossings }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    setVrStatus('Let op: ' + (err.error || 'Kruisingen opslaan mislukt.'));
  }
}

// --- Kruisingen op de kaart ---
function crossingIcon(c) {
  const team = c.team != null ? teamById(c.team) : null;
  return {
    path: DIAMOND,
    scale: 9,
    fillColor: c.hidden ? '#9ca3af' : team ? team.color : '#f59e0b',
    fillOpacity: c.hidden ? 0.45 : 1,
    strokeColor: '#fff',
    strokeWeight: 2,
  };
}

function refreshVrLayer() {
  crossingMarkers.forEach((m) => m.setMap(null));
  crossingMarkers = [];
  teamRoutePolylines.forEach((p) => p.setMap(null));
  teamRoutePolylines = [];
  conflictMarkers.forEach((m) => m.setMap(null));
  conflictMarkers = [];
  if (editMode !== 'vr') return;

  const d = days[currentDay];
  let visibleIndex = 0;
  for (const c of d.crossings) {
    if (!c.hidden) visibleIndex++;
    const marker = new google.maps.Marker({
      position: { lat: c.lat, lng: c.lng },
      map,
      title: c.name,
      icon: crossingIcon(c),
      label: c.hidden
        ? null
        : { text: String(visibleIndex), color: '#fff', fontSize: '10px', fontWeight: 'bold' },
      zIndex: 500,
    });
    marker.addListener('click', () => openCrossingMenu(c, marker));
    crossingMarkers.push(marker);
  }

  drawTeamRoutes();
  updateVrWarnings();
}

function openCrossingMenu(c, marker) {
  const div = document.createElement('div');
  div.className = 'point-menu';

  const title = document.createElement('strong');
  title.textContent = `Oversteek: ${c.name}`;
  div.appendChild(title);

  const teamSelect = document.createElement('select');
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = '— geen team —';
  teamSelect.appendChild(noneOpt);
  for (const t of teams) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    teamSelect.appendChild(opt);
  }
  teamSelect.value = c.team != null ? String(c.team) : '';
  teamSelect.addEventListener('change', async () => {
    c.team = teamSelect.value ? Number(teamSelect.value) : null;
    await saveCrossings(currentDay);
    infoWindow.close();
    refreshVrLayer();
    // Handmatige toewijzing: routes direct opnieuw berekenen en toetsen.
    await replanDay(currentDay, false);
  });
  div.appendChild(teamSelect);

  const svBtn = document.createElement('button');
  svBtn.textContent = 'Bekijk in Street View';
  svBtn.addEventListener('click', () => {
    infoWindow.close();
    openStreetView({ lat: c.lat, lng: c.lng });
  });
  div.appendChild(svBtn);

  const hideBtn = document.createElement('button');
  hideBtn.textContent = c.hidden ? 'Weer tonen in planning' : 'Verberg voor planning';
  hideBtn.addEventListener('click', async () => {
    c.hidden = !c.hidden;
    if (c.hidden) c.team = null;
    await saveCrossings(currentDay);
    infoWindow.close();
    refreshVrLayer();
    await replanDay(currentDay, false);
  });
  div.appendChild(hideBtn);

  if (c.manual) {
    const delBtn = document.createElement('button');
    delBtn.textContent = 'Verwijder dit eigen punt';
    delBtn.addEventListener('click', async () => {
      const d = days[currentDay];
      d.crossings = d.crossings.filter((x) => x !== c);
      await saveCrossings(currentDay);
      infoWindow.close();
      refreshVrLayer();
      await replanDay(currentDay, false);
    });
    div.appendChild(delBtn);
  }

  infoWindow.setContent(div);
  infoWindow.open({ anchor: marker, map });
}

// --- Teams beheren ---
function renderTeams() {
  const list = document.getElementById('team-list');
  list.innerHTML = '';
  if (teams.length === 0) {
    list.innerHTML = '<li class="hint">Nog geen teams.</li>';
    return;
  }
  for (const t of teams) {
    const li = document.createElement('li');
    const label = document.createElement('span');
    label.innerHTML = `<span class="day-dot" style="background:${t.color}"></span>${t.name}`;
    li.appendChild(label);

    const controls = document.createElement('span');
    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.title = 'Team verwijderen';
    delBtn.addEventListener('click', async () => {
      if (!confirm(`Team "${t.name}" verwijderen?`)) return;
      await fetch(`/api/admin/teams/${t.id}`, {
        method: 'DELETE',
        headers: { 'x-admin-password': password },
      });
      teams = teams.filter((x) => x.id !== t.id);
      for (let day = 1; day <= 4; day++) {
        days[day].crossings.forEach((c) => {
          if (c.team === t.id) c.team = null;
        });
        delete teamRoutes[`${t.id}_${day}`];
      }
      renderTeams();
      refreshVrLayer();
      // Minder teams: automatisch herverdelen en opnieuw toetsen.
      await replanDay(currentDay, true);
    });
    controls.appendChild(delBtn);
    li.appendChild(controls);
    list.appendChild(li);
  }
}

document.getElementById('add-team-btn').addEventListener('click', async () => {
  const input = document.getElementById('team-name');
  const name = input.value.trim();
  if (!name) return setVrStatus('Geef het team eerst een naam.');
  const res = await fetch('/api/admin/teams', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
    body: JSON.stringify({ name }),
  });
  if (res.ok) {
    teams.push(await res.json());
    input.value = '';
    renderTeams();
    // Extra team: automatisch herverdelen en opnieuw toetsen.
    await replanDay(currentDay, true);
  } else {
    const err = await res.json().catch(() => ({}));
    setVrStatus('Let op: ' + (err.error || 'Team aanmaken mislukt.'));
  }
});

// --- Teamroutes berekenen, tijden toetsen, conflicten controleren ---
// Verkeersregelaars fietsen altijd.
function teamDirections(points) {
  return new Promise((resolve) => {
    directionsService.route(
      {
        origin: startFinish,
        destination: startFinish,
        waypoints: points.map((p) => ({ location: { lat: p.lat, lng: p.lng }, stopover: true })),
        travelMode: google.maps.TravelMode.BICYCLING,
      },
      (result, status) => resolve({ result, status })
    );
  });
}

// --- Automatisch plannen ---
// Eén team bemant één punt tegelijk. Het team mag pas vertrekken als de héle
// stoet (500 wandelaars) zijn punt voorbij is, en moet zijn volgende punt
// bereiken vóórdat de kop van de stoet daar aankomt. Dicht opeenvolgende
// punten krijgen daardoor automatisch verschillende teams.
async function autoplanDay(day) {
  const d = days[day];
  if (!d.path || teams.length === 0) return;
  const ordered = d.crossings
    .filter((c) => !c.hidden)
    .map((c) => ({ c, along: alongPath(d.path, c) }))
    .sort((a, b) => a.along - b.along);
  if (ordered.length === 0) return;

  // Elk team: wanneer het weer vrij is en waar het staat. Teams zonder punt
  // kunnen vooraf klaarstaan en halen hun eerste punt dus altijd.
  const state = teams.map((team) => ({ team, freeMin: null, pos: null }));
  let unassigned = 0;
  for (const { c, along } of ordered) {
    const deadline = headMin(along);
    let best = null;
    for (const s of state) {
      const reachable =
        s.pos === null || s.freeMin + bikeMin(s.pos, c) + vrSettings.marginMin <= deadline;
      if (!reachable) continue;
      // Kies het team dat het langst vrij is (natuurlijke rotatie/haasje-over).
      if (!best || (s.freeMin ?? -1) < (best.freeMin ?? -1)) best = s;
    }
    if (best) {
      c.team = best.team.id;
      best.pos = c;
      best.freeMin = leaveMin(along);
    } else {
      c.team = null;
      unassigned++;
    }
  }
  await saveCrossings(day);
  refreshVrLayer();
  if (unassigned > 0) {
    setVrStatus(
      `Let op: ${unassigned} van de ${ordered.length} punten kunnen met ${teams.length} team(s) niet op tijd bemand worden (een team bemant één punt tegelijk) — voeg teams toe of verberg punten.`
    );
  } else {
    setVrStatus(`Alle ${ordered.length} punten verdeeld over ${teams.length} team(s).`);
  }
}

async function computeTeamRoutesForDay(day) {
  const d = days[day];
  if (!d.path) return;
  setVrStatus('Teamroutes berekenen en toetsen…');
  const problems = [];
  for (const team of teams) {
    const points = d.crossings
      .filter((c) => !c.hidden && c.team === team.id)
      .map((c) => ({ c, along: alongPath(d.path, c) }))
      .sort((a, b) => a.along - b.along);
    const key = `${team.id}_${day}`;
    if (points.length === 0) {
      delete teamRoutes[key];
      await fetch(`/api/admin/team-route/${team.id}/${day}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
        body: JSON.stringify({ path: null }),
      });
      continue;
    }
    const { result, status } = await teamDirections(points.map((p) => p.c));
    if (status !== 'OK') {
      problems.push(`route van ${team.name} kon niet berekend worden (${status})`);
      continue;
    }
    const route = result.routes[0];
    const teamPath = route.overview_path.map((p) => ({ lat: p.lat(), lng: p.lng() }));
    const distance = route.legs.reduce((sum, leg) => sum + leg.distance.value, 0);

    // Tijdstoets: een team bemant één punt tegelijk. Vertrekken kan pas als
    // de héle stoet voorbij is; het volgende punt moet bereikt zijn vóórdat
    // de kop van de stoet daar aankomt.
    // legs[i] is de fietsleg van punt i-1 naar punt i (leg 0 = vanaf).
    const schedule = points.map(({ c, along }) => ({
      name: c.name,
      headMin: round1(headMin(along)),
      leaveMin: round1(leaveMin(along)),
    }));
    let feasible = true;
    const late = [];
    for (let i = 1; i < points.length; i++) {
      const bikeMinutes = route.legs[i].duration.value / 60;
      const arrive = leaveMin(points[i - 1].along) + bikeMinutes + vrSettings.marginMin;
      const deadline = headMin(points[i].along);
      schedule[i].arriveMin = round1(arrive);
      if (arrive > deadline) {
        feasible = false;
        late.push({ point: schedule[i].name, lateMin: round1(arrive - deadline) });
      }
    }
    const timing = { feasible, schedule, late };

    // Doorkruist de teamroute de wandelgroep? Goedgekeurde uitzonderingen
    // van een eerdere berekening blijven goedgekeurd (op basis van plek).
    let conflicts = [];
    const confRes = await fetch(`/api/admin/conflicts/${day}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({
        path: teamPath,
        exclude: [startFinish, ...points.map((p) => ({ lat: p.c.lat, lng: p.c.lng }))],
      }),
    });
    if (confRes.ok) {
      const previous = (teamRoutes[key] && teamRoutes[key].conflicts) || [];
      conflicts = (await confRes.json()).conflicts.map((cf) => ({
        ...cf,
        approved: previous.some((old) => old.approved && distM(old, cf) < 30),
      }));
    }

    await fetch(`/api/admin/team-route/${team.id}/${day}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({ path: teamPath, distance_m: distance, conflicts, timing }),
    });
    teamRoutes[key] = {
      team_id: team.id,
      day,
      path: teamPath,
      distance_m: distance,
      conflicts,
      timing,
    };

    if (!feasible) {
      problems.push(
        `${team.name} haalt het niet: ${late
          .map((l) => `${l.point} (${l.lateMin} min te laat)`)
          .join(', ')}`
      );
    }
    const openConflicts = conflicts.filter((cf) => !cf.approved).length;
    if (openConflicts > 0) {
      problems.push(
        `Let op: route van ${team.name} DOORKRUIST de wandelroute op ${openConflicts} plek(ken) — los op of keur goed via het rode uitroepteken`
      );
    }
  }
  refreshVrLayer();
  if (problems.length > 0) {
    setVrStatus('Let op: ' + problems.join(' — '));
  } else {
    setVrStatus(
      'Planning compleet: alle punten zijn op tijd bemand en geen teamroute kruist de wandelgroep.'
    );
  }
}

// De hele planningsketen: punten verdelen en teamroutes berekenen/toetsen.
// Draait automatisch na detectie, teamwijzigingen en toewijzingen.
async function replanDay(day, reassign) {
  if (reassign) await autoplanDay(day);
  await computeTeamRoutesForDay(day);
}

function drawTeamRoutes() {
  for (const team of teams) {
    const tr = teamRoutes[`${team.id}_${currentDay}`];
    if (!tr || !tr.path) continue;
    const polyline = new google.maps.Polyline({
      path: tr.path,
      map,
      strokeOpacity: 0,
      zIndex: 400,
      icons: [
        {
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: team.color, strokeWeight: 3, scale: 3 },
          offset: '0',
          repeat: '14px',
        },
      ],
    });
    teamRoutePolylines.push(polyline);
    for (const conflict of tr.conflicts || []) {
      const marker = new google.maps.Marker({
        position: conflict,
        map,
        title: conflict.approved
          ? `Goedgekeurde uitzondering: route van ${team.name} kruist hier de wandelroute`
          : `Conflict: route van ${team.name} kruist de wandelroute hier`,
        label: { text: conflict.approved ? '✓' : '!', color: '#fff', fontWeight: 'bold' },
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 11,
          fillColor: conflict.approved ? '#ca8a04' : '#dc2626',
          fillOpacity: 1,
          strokeColor: '#fff',
          strokeWeight: 2,
        },
        zIndex: 1001,
      });
      marker.addListener('click', () => openConflictMenu(team, tr, conflict, marker));
      conflictMarkers.push(marker);
    }
  }
}

// Menu op een conflictpunt: uitzondering goedkeuren of intrekken.
function openConflictMenu(team, tr, conflict, marker) {
  const div = document.createElement('div');
  div.className = 'point-menu';

  const title = document.createElement('strong');
  title.textContent = `Route van ${team.name} kruist hier de wandelroute`;
  div.appendChild(title);

  const hint = document.createElement('span');
  hint.textContent = conflict.approved
    ? 'Goedgekeurde uitzondering: het team weet dat het hier moet afstappen en uitkijken.'
    : 'Alleen goedkeuren als er echt geen andere route mogelijk is.';
  div.appendChild(hint);

  const approveBtn = document.createElement('button');
  approveBtn.textContent = conflict.approved
    ? '↩ Goedkeuring intrekken'
    : 'Keur uitzondering goed';
  approveBtn.addEventListener('click', async () => {
    conflict.approved = !conflict.approved;
    infoWindow.close();
    await fetch(`/api/admin/team-route/${team.id}/${currentDay}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'x-admin-password': password },
      body: JSON.stringify({
        path: tr.path,
        distance_m: tr.distance_m,
        conflicts: tr.conflicts,
        timing: tr.timing,
      }),
    });
    refreshVrLayer();
  });
  div.appendChild(approveBtn);

  const svBtn = document.createElement('button');
  svBtn.textContent = 'Bekijk in Street View';
  svBtn.addEventListener('click', () => {
    infoWindow.close();
    openStreetView({ lat: conflict.lat, lng: conflict.lng });
  });
  div.appendChild(svBtn);

  infoWindow.setContent(div);
  infoWindow.open({ anchor: marker, map });
}

function updateVrWarnings() {
  if (editMode !== 'vr') return;
  const warnings = [];
  for (const t of teams) {
    const tr = teamRoutes[`${t.id}_${currentDay}`];
    if (!tr) continue;
    const open = (tr.conflicts || []).filter((c) => !c.approved).length;
    if (open > 0) warnings.push(`route van ${t.name} doorkruist de wandelroute (rode uitroeptekens)`);
    if (tr.timing && tr.timing.feasible === false) {
      warnings.push(`${t.name} haalt zijn punten niet op tijd`);
    }
  }
  if (warnings.length > 0) {
    setVrStatus('Let op: ' + warnings.join('; ') + '. Pas de planning aan en bereken opnieuw.');
  }
}

updateDayLabels();
loadGoogleMaps();
