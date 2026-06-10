// Bezoekerspagina: toont de routes van dag 1 t/m 4 en volgt je met GPS.
// Alle routes starten en eindigen op het vaste start/finish-punt.
const ALMERE_CENTER = { lat: 52.3508, lng: 5.2647 };
const DAY_COLORS = { 1: '#dc2626', 2: '#2563eb', 3: '#16a34a', 4: '#9333ea' };

let map;
let infoWindow;
let selectedDay = 'all';
let startFinish = null;
const routes = {}; // day -> { polyline, bounds, distance_m, crossings }

// Verkeersregelaars-weergave
const DIAMOND = 'M 0 -1 L 1 0 L 0 1 L -1 0 Z';
let vrOn = false;
let vrTeam = 'all';
let teams = [];
let teamRoutes = {}; // `${teamId}_${day}` -> { path, conflicts }
let vrMarkers = [];
let vrPolylines = [];

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
  await loadVrData();
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
    routes[row.day] = {
      polyline,
      bounds,
      distance_m: row.distance_m,
      crossings: (row.crossings || []).filter((c) => !c.hidden),
    };
  }

  renderDistanceList();
  applySelection();
}

async function loadVrData() {
  try {
    const [teamsRes, routesRes] = await Promise.all([
      fetch('/api/teams'),
      fetch('/api/team-routes'),
    ]);
    if (teamsRes.ok) teams = await teamsRes.json();
    if (routesRes.ok) {
      for (const row of await routesRes.json()) {
        teamRoutes[`${row.team_id}_${row.day}`] = row;
      }
    }
  } catch {
    // Verkeersregelaarsdata is optioneel; de rest van de pagina werkt gewoon.
  }
  const select = document.getElementById('vr-team');
  select.innerHTML = '<option value="all">Alle teams</option>';
  for (const t of teams) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    select.appendChild(opt);
  }
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
    refreshVrView();
  });
});

// --- Verkeersregelaars-weergave (geen wachtwoord nodig) ---
function selectDayTab(day) {
  document.querySelector('.day-tab.active').classList.remove('active');
  document.querySelector(`.day-tab[data-day="${day}"]`).classList.add('active');
  selectedDay = String(day);
  applySelection();
}

document.getElementById('vr-toggle').addEventListener('click', () => {
  vrOn = !vrOn;
  document.getElementById('vr-panel').classList.toggle('hidden', !vrOn);
  document.getElementById('vr-toggle').textContent = vrOn
    ? '✕ Sluit verkeersregelaars-weergave'
    : '🦺 Open verkeersregelaars-weergave';
  // Oversteekpunten zijn per dag; kies dag 1 als er nog "alle" actief is.
  if (vrOn && selectedDay === 'all') selectDayTab(1);
  refreshVrView();
});

document.getElementById('vr-team').addEventListener('change', (e) => {
  vrTeam = e.target.value;
  refreshVrView();
});

function teamById(id) {
  return teams.find((t) => t.id === id) || null;
}

function refreshVrView() {
  vrMarkers.forEach((m) => m.setMap(null));
  vrMarkers = [];
  vrPolylines.forEach((p) => p.setMap(null));
  vrPolylines = [];
  const warningEl = document.getElementById('vr-warning');
  warningEl.textContent = '';
  if (!vrOn || selectedDay === 'all') return;

  const day = Number(selectedDay);
  const crossings = (routes[day] && routes[day].crossings) || [];
  const teamFilter = vrTeam === 'all' ? null : Number(vrTeam);

  let index = 0;
  for (const c of crossings) {
    index++;
    const team = c.team != null ? teamById(c.team) : null;
    const isMine = teamFilter === null || c.team === teamFilter;
    const marker = new google.maps.Marker({
      position: { lat: c.lat, lng: c.lng },
      map,
      title: c.name,
      icon: {
        path: DIAMOND,
        scale: 9,
        fillColor: team ? team.color : '#f59e0b',
        fillOpacity: isMine ? 1 : 0.35,
        strokeColor: '#fff',
        strokeWeight: 2,
      },
      label: { text: String(index), color: '#fff', fontSize: '10px', fontWeight: 'bold' },
      zIndex: 500,
    });
    marker.addListener('click', () => {
      const div = document.createElement('div');
      div.className = 'point-menu';
      const title = document.createElement('strong');
      title.textContent = `🦺 Punt ${index2Label(marker)}: ${c.name}`;
      div.appendChild(title);
      const teamLine = document.createElement('span');
      teamLine.textContent = team ? `Team: ${team.name}` : 'Nog geen team toegewezen';
      div.appendChild(teamLine);
      const svBtn = document.createElement('button');
      svBtn.textContent = '👀 Bekijk in Street View';
      svBtn.addEventListener('click', () => {
        infoWindow.close();
        const pano = map.getStreetView();
        pano.setPosition({ lat: c.lat, lng: c.lng });
        pano.setPov({ heading: 0, pitch: 0 });
        pano.setVisible(true);
      });
      div.appendChild(svBtn);
      infoWindow.setContent(div);
      infoWindow.open({ anchor: marker, map });
    });
    vrMarkers.push(marker);
  }

  const warnings = [];
  for (const t of teams) {
    if (teamFilter !== null && t.id !== teamFilter) continue;
    const tr = teamRoutes[`${t.id}_${day}`];
    if (!tr || !tr.path) continue;
    const polyline = new google.maps.Polyline({
      path: tr.path,
      map,
      strokeOpacity: 0,
      zIndex: 400,
      icons: [
        {
          icon: { path: 'M 0,-1 0,1', strokeOpacity: 1, strokeColor: t.color, strokeWeight: 3, scale: 3 },
          offset: '0',
          repeat: '14px',
        },
      ],
    });
    vrPolylines.push(polyline);
    if ((tr.conflicts || []).length > 0) {
      warnings.push(`⚠️ Route van ${t.name} doorkruist de wandelroute op ${tr.conflicts.length} plek(ken)!`);
      for (const conflict of tr.conflicts) {
        const cm = new google.maps.Marker({
          position: conflict,
          map,
          title: `Conflict: route van ${t.name} kruist de wandelroute`,
          label: { text: '!', color: '#fff', fontWeight: 'bold' },
          icon: {
            path: google.maps.SymbolPath.CIRCLE,
            scale: 11,
            fillColor: '#dc2626',
            fillOpacity: 1,
            strokeColor: '#fff',
            strokeWeight: 2,
          },
          zIndex: 1001,
        });
        vrMarkers.push(cm);
      }
    }
  }
  warningEl.textContent = warnings.join(' ');
}

function index2Label(marker) {
  return marker.getLabel() ? marker.getLabel().text : '';
}

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
