// Adminpagina: routes voor dag 1 t/m 4 tekenen en beheren, plus de
// verkeersmodus (oversteekpunten, teams en volautomatische planning).
// Kaart: OpenStreetMap/Leaflet. Routes: OSRM (wandel- en fietspaden).
// Street View: Google (overlay). Start en finish liggen vast; de admin
// tekent alleen tussenpunten en de wandelroute is altijd lopend.
const ALMERE_CENTER = { lat: 52.3508, lng: 5.2647 };
const MAX_POINTS = 25;

// Planningsinstellingen (overschreven door opgeslagen waarden uit de database).
let vrSettings = { walkKmh: 4, passMin: 8, bikeKmh: 15, marginMin: 2 };

let map;
let currentDay = 1;
let editMode = 'route'; // 'route' | 'rec' | 'vr'
let pausePlacing = false;
let overviewMode = false;
let schedule = null; // per dag {date, time}
let sponsors = [];
let sponsorLayers = [];
let loggedIn = false;
let password = sessionStorage.getItem('a4d-admin-password') || '';
let startFinish = null;
let startMarker = null;
let teams = [];
let teamRoutes = {}; // `${teamId}_${day}` -> { path, distance_m, conflicts, timing }

// Kaartlagen van de verkeersmodus (alleen voor de huidige dag).
let vrLayers = [];

// Per dag: { points, markers, routeLine, distanceM, path, crossings }
const days = {};

// Conceptbeheer: elke wijziging wordt automatisch (kort na de wijziging)
// als conceptversie bewaard; publiceren wist de tussenversies.
let loadingRoutes = false;
const draftTimers = {};
const draftCounts = { 1: 0, 2: 0, 3: 0, 4: 0 };

function adminHeaders(json = false) {
  const h = { 'x-admin-password': password };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

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
      headers: adminHeaders(true),
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

// --- Kaart ---
async function init() {
  const res = await fetch('/api/config');
  const config = await res.json();
  setStreetViewKey(config.googleMapsApiKey || '');
  startFinish = config.startFinish;
  schedule = config.schedule || null;
  if (config.vrSettings) vrSettings = { ...vrSettings, ...config.vrSettings };

  map = createMap('map', startFinish || ALMERE_CENTER, startFinish ? 15 : 13);

  for (let day = 1; day <= 4; day++) {
    days[day] = {
      points: [],
      markers: [],
      distanceM: 0,
      path: null,
      crossings: [],
      pause: null,
      pauseMarker: null,
      routeLine: L.polyline([], { color: DAY_COLORS[day], weight: 5, opacity: 0.8 }),
      arrows: L.layerGroup(),
    };
  }
  updateDayVisibility();

  map.on('click', (e) => {
    if (!loggedIn) return;
    if (overviewMode) {
      setSaveStatus('Zet "Toon alle dagen" uit om te kunnen bewerken.');
      return;
    }
    map.closePopup();
    const point = { lat: e.latlng.lat, lng: e.latlng.lng };
    if (editMode === 'route') {
      if (pausePlacing) placePause(currentDay, point);
      else addPoint(currentDay, point);
    } else if (editMode === 'vr') {
      addManualCrossing(point);
    }
  });

  if (password) tryLogin(password);
}

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
      await Promise.all([loadSavedRoutes(), loadTeams(), loadTeamRoutes(), loadSponsors()]);
      renderTeams();
      initSettingsInputs();
      initEventInput();
      updateDraftStatus();
    } else {
      const err = await res.json().catch(() => ({}));
      status.textContent = 'Let op: ' + (err.error || 'inloggen mislukt.');
      sessionStorage.removeItem('a4d-admin-password');
    }
  } catch {
    status.textContent = 'Let op: server niet bereikbaar.';
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
      const cfgRes = await fetch('/api/admin/config', { headers: adminHeaders() });
      const adminConfig = await cfgRes.json();
      const geoRes = await fetch(
        `/api/admin/geocode?q=${encodeURIComponent(adminConfig.startAddress)}`,
        { headers: adminHeaders() }
      );
      if (!geoRes.ok) throw new Error('geocode mislukt');
      startFinish = await geoRes.json();
      await saveStartFinish();
      setSaveStatus('Start & finish automatisch ingesteld.');
    } catch (err) {
      console.error('Geocoderen mislukt:', err);
      startFinish = { ...ALMERE_CENTER };
      setSaveStatus(
        'Let op: adres opzoeken lukte niet. Sleep de start/finish-markering naar de juiste plek — dat wordt automatisch bewaard.',
        true
      );
    }
  }
  placeStartMarker();
  map.setView([startFinish.lat, startFinish.lng], 15);
}

function placeStartMarker() {
  if (startMarker) startMarker.remove();
  startMarker = L.marker([startFinish.lat, startFinish.lng], {
    icon: flagIcon(),
    draggable: true,
    zIndexOffset: 900,
    title: 'Start & finish — versleep om te corrigeren',
  }).addTo(map);
  startMarker.on('click', () => {
    const div = document.createElement('div');
    div.className = 'point-menu';
    const title = document.createElement('strong');
    title.textContent = 'Start & finish';
    div.appendChild(title);
    div.appendChild(
      menuButton('Bekijk in Street View', () => {
        map.closePopup();
        openStreetView(startFinish.lat, startFinish.lng);
      })
    );
    openMapMenu(map, startMarker.getLatLng(), div);
  });
  startMarker.on('dragend', async () => {
    const ll = startMarker.getLatLng();
    startFinish = { lat: ll.lat, lng: ll.lng };
    await saveStartFinish();
    for (let day = 1; day <= 4; day++) {
      if (days[day].points.length > 0) updateRoute(day);
    }
    setSaveStatus('Start & finish verplaatst. Maak de dagen opnieuw definitief om de routes bij te werken.');
  });
}

async function saveStartFinish() {
  await fetch('/api/admin/start-finish', {
    method: 'PUT',
    headers: adminHeaders(true),
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
  if (status === 'FAIL') {
    // Geen wandelroute mogelijk via dit punt: direct weer terugdraaien.
    d.points.splice(index, 1);
    d.markers[index].remove();
    d.markers.splice(index, 1);
    relabelMarkers(day);
    await updateRoute(day);
    setSaveStatus(
      'Let op: daar kan geen wandelroute langs — het punt is niet toegevoegd. Kies een plek op of vlak naast een straat of pad.'
    );
  } else {
    scheduleDraftSave(day);
  }
}

function removePoint(day, index) {
  const d = days[day];
  d.points.splice(index, 1);
  d.markers[index].remove();
  d.markers.splice(index, 1);
  relabelMarkers(day);
  updateRoute(day);
  scheduleDraftSave(day);
}

function addMarker(day, point, index) {
  const d = days[day];
  const marker = L.marker([point.lat, point.lng], {
    icon: dotIcon(DAY_COLORS[day]),
    draggable: true,
    zIndexOffset: 600,
  });
  if (day === currentDay && editMode !== 'vr' && !overviewMode) marker.addTo(map);
  marker.on('dragend', async () => {
    const i = d.markers.indexOf(marker);
    const previous = d.points[i];
    const ll = marker.getLatLng();
    d.points[i] = { lat: ll.lat, lng: ll.lng };
    const status = await updateRoute(day);
    if (status === 'FAIL') {
      // Geen wandelroute mogelijk: punt terug naar de vorige plek.
      d.points[i] = previous;
      marker.setLatLng([previous.lat, previous.lng]);
      await updateRoute(day);
      setSaveStatus('Let op: daar kan geen wandelroute langs — het punt is teruggezet.');
    } else {
      scheduleDraftSave(day);
    }
  });
  marker.on('click', () => openPointMenu(day, marker));
  d.markers.splice(index, 0, marker);
}

function relabelMarkers(day) {
  days[day].markers.forEach((m, i) => m.setIcon(dotIcon(DAY_COLORS[day], String(i + 1))));
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

  div.appendChild(
    menuButton('Bekijk in Street View', () => {
      map.closePopup();
      openStreetView(d.points[index].lat, d.points[index].lng);
    })
  );
  div.appendChild(
    menuButton('Verwijder dit punt', () => {
      map.closePopup();
      removePoint(day, index);
    })
  );
  if (index < d.points.length - 1) {
    div.appendChild(
      menuButton('Punt invoegen hierna', () => {
        map.closePopup();
        const a = d.points[index];
        const b = d.points[index + 1];
        // Nieuw punt halverwege; daarna verslepen naar de juiste plek.
        addPoint(day, { lat: (a.lat + b.lat) / 2, lng: (a.lng + b.lng) / 2 }, index + 1);
      })
    );
  }

  openMapMenu(map, marker.getLatLng(), div);
}

// --- Route berekenen via OSRM: altijd lopend, van en naar start/finish ---
async function osrmRoute(profile, points) {
  const res = await fetch('/api/admin/route', {
    method: 'POST',
    headers: adminHeaders(true),
    body: JSON.stringify({ profile, points }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.error || 'Routeservice niet bereikbaar.');
  }
  return res.json();
}

async function updateRoute(day) {
  const d = days[day];
  relabelMarkers(day); // nummering altijd kloppend houden, ook na invoegen
  if (d.points.length < 1 || !startFinish) {
    d.routeLine.setLatLngs([]);
    d.arrows.remove();
    d.arrows = L.layerGroup();
    d.distanceM = 0;
    d.path = null;
    updateInfo();
    return 'EMPTY';
  }
  try {
    const r = await osrmRoute('foot', [startFinish, ...d.points, startFinish]);
    d.path = r.path;
    d.distanceM = r.distance_m;
    d.routeLine.setLatLngs(r.path.map((p) => [p.lat, p.lng]));
    // Looprichting-pijlen vernieuwen bij elke herberekening.
    d.arrows.remove();
    d.arrows = directionArrows(r.path, DAY_COLORS[day]);
    updateDayVisibility();
    updateInfo();
    return 'OK';
  } catch (err) {
    console.error('Route berekenen mislukt:', err);
    setSaveStatus('Let op: ' + err.message);
    updateInfo();
    return 'FAIL';
  }
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
  d.markers.forEach((m) => m.remove());
  d.markers = [];
  d.distanceM = 0;
  d.path = null;
  d.routeLine.setLatLngs([]);
  d.arrows.remove();
  d.arrows = L.layerGroup();
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

// --- Pauzepunt: ligt altijd op de route, versleepbaar ---
const PAUSE_SNAP_M = 50;

function updatePauseBtn() {
  const d = days[currentDay]; // bestaat nog niet vóór init()
  document.getElementById('pause-btn').textContent = pausePlacing
    ? 'Klik op de route… (of klik hier om te annuleren)'
    : `Pauzepunt ${d && d.pause ? 'verplaatsen' : 'plaatsen'} (dag ${currentDay})`;
}

document.getElementById('pause-btn').addEventListener('click', () => {
  if (!days[currentDay].path) {
    setSaveStatus('Let op: teken eerst de route van deze dag.');
    return;
  }
  pausePlacing = !pausePlacing;
  updatePauseBtn();
});

async function placePause(day, clicked) {
  pausePlacing = false;
  const d = days[day];
  const nearest = nearestOnPath(d.path, clicked);
  if (nearest.dist > PAUSE_SNAP_M) {
    setSaveStatus('Let op: het pauzepunt moet op de route liggen — klik op (of vlak naast) de route.');
    updatePauseBtn();
    return;
  }
  d.pause = { lat: nearest.lat, lng: nearest.lng };
  await savePause(day);
  drawPauseMarker(day);
  updatePauseBtn();
  setSaveStatus(`Pauzepunt dag ${day} geplaatst.`);
}

async function savePause(day) {
  const res = await fetch(`/api/admin/pause/${day}`, {
    method: 'PUT',
    headers: adminHeaders(true),
    body: JSON.stringify({ pause: days[day].pause }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    setSaveStatus('Let op: ' + (err.error || 'pauzepunt opslaan mislukt.'));
  }
}

function drawPauseMarker(day) {
  const d = days[day];
  if (d.pauseMarker) {
    d.pauseMarker.remove();
    d.pauseMarker = null;
  }
  if (!d.pause) return;
  d.pauseMarker = L.marker([d.pause.lat, d.pause.lng], {
    icon: pauseIcon(),
    draggable: true,
    zIndexOffset: 800,
    title: `Pauzepunt dag ${day}`,
  });
  if (day === currentDay && !overviewMode) d.pauseMarker.addTo(map);
  d.pauseMarker.on('dragend', async () => {
    // Pauzepunt blijft altijd op de route: snap naar het dichtstbijzijnde punt.
    const ll = d.pauseMarker.getLatLng();
    const nearest = nearestOnPath(d.path || [d.pause], { lat: ll.lat, lng: ll.lng });
    d.pause = { lat: nearest.lat, lng: nearest.lng };
    d.pauseMarker.setLatLng([d.pause.lat, d.pause.lng]);
    await savePause(day);
  });
  d.pauseMarker.on('click', () => {
    const div = document.createElement('div');
    div.className = 'point-menu';
    const title = document.createElement('strong');
    title.textContent = `Pauzepunt dag ${day}`;
    div.appendChild(title);
    div.appendChild(
      menuButton('Bekijk in Street View', () => {
        map.closePopup();
        openStreetView(d.pause.lat, d.pause.lng);
      })
    );
    div.appendChild(
      menuButton('Verwijder pauzepunt', async () => {
        map.closePopup();
        d.pause = null;
        await savePause(day);
        drawPauseMarker(day);
        updatePauseBtn();
      })
    );
    openMapMenu(map, d.pauseMarker.getLatLng(), div);
  });
}

// --- Loopdagen: datum en starttijd per dag ---
function initEventInput() {
  for (let day = 1; day <= 4; day++) {
    const dateInput = document.getElementById(`set-date-${day}`);
    const timeInput = document.getElementById(`set-time-${day}`);
    const entry = schedule && schedule[day] ? schedule[day] : null;
    if (entry) {
      dateInput.value = entry.date || '';
      timeInput.value = entry.time || '';
    }
    const save = async () => {
      schedule = schedule || {};
      if (dateInput.value) {
        schedule[day] = { date: dateInput.value, time: timeInput.value || null };
      } else {
        delete schedule[day];
      }
      const res = await fetch('/api/admin/event-schedule', {
        method: 'PUT',
        headers: adminHeaders(true),
        body: JSON.stringify({ days: schedule }),
      });
      setSaveStatus(
        res.ok
          ? 'Loopdagen opgeslagen — bezoekers zien standaard de eerstvolgende dag.'
          : 'Let op: loopdagen opslaan mislukt.'
      );
    };
    dateInput.addEventListener('change', save);
    timeInput.addEventListener('change', save);
  }
}

async function loadSponsors() {
  try {
    const res = await fetch('/api/admin/sponsors', { headers: adminHeaders() });
    if (res.ok) sponsors = await res.json();
  } catch {
    sponsors = [];
  }
  renderSponsors();
}

function renderSponsors() {
  sponsorLayers.forEach((l) => l.remove());
  sponsorLayers = [];
  const list = document.getElementById('sponsor-list');
  list.innerHTML = '';
  if (sponsors.length === 0) {
    list.innerHTML = '<li class="hint">Nog geen aanmeldingen.</li>';
    return;
  }
  for (const s of sponsors) {
    const marker = L.marker([s.lat, s.lng], {
      icon: starIcon(),
      zIndexOffset: 700,
      title: `Sponsoractie dag ${s.day}: ${s.action}`,
    }).addTo(map);
    marker.bindPopup(
      `<div class="point-menu"><strong>Sponsoractie (dag ${s.day})</strong>` +
        `<span>${escapeHtml(s.action)}</span>` +
        `<span>${escapeHtml(s.first_name)} ${escapeHtml(s.last_name)}<br>${escapeHtml(s.email)} · ${escapeHtml(s.phone)}</span></div>`
    );
    sponsorLayers.push(marker);

    const li = document.createElement('li');
    const label = document.createElement('span');
    label.innerHTML = `<strong>Dag ${s.day}:</strong> ${escapeHtml(s.action)}<br>
      <span class="route-meta">${escapeHtml(s.first_name)} ${escapeHtml(s.last_name)} · ${escapeHtml(s.email)} · ${escapeHtml(s.phone)}</span>`;
    li.appendChild(label);
    const controls = document.createElement('span');
    const showBtn = document.createElement('button');
    showBtn.textContent = 'Toon';
    showBtn.addEventListener('click', () => {
      map.setView([s.lat, s.lng], 17);
      marker.openPopup();
    });
    controls.appendChild(showBtn);
    const delBtn = document.createElement('button');
    delBtn.textContent = '✕';
    delBtn.title = 'Aanmelding verwijderen';
    delBtn.addEventListener('click', async () => {
      if (!confirm('Deze sponsoraanmelding verwijderen?')) return;
      await fetch(`/api/admin/sponsors/${s.id}`, { method: 'DELETE', headers: adminHeaders() });
      sponsors = sponsors.filter((x) => x.id !== s.id);
      renderSponsors();
    });
    controls.appendChild(delBtn);
    li.appendChild(controls);
    list.appendChild(li);
  }
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = String(s);
  return div.innerHTML;
}

// --- UI: dagen en modus ---
function updateDayLabels() {
  document.getElementById('save-btn').textContent = `Maak route dag ${currentDay} definitief`;
  document.getElementById('delete-btn').textContent = `Verwijder route dag ${currentDay}`;
  document.getElementById('print-btn').textContent = `Printversie dag ${currentDay}`;
  document.getElementById('rec-save').textContent = `Definitief dag ${currentDay}`;
  pausePlacing = false;
  updatePauseBtn();
  updateDraftStatus();
}

document.querySelectorAll('.day-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelector('.day-tab.active').classList.remove('active');
    tab.classList.add('active');
    currentDay = Number(tab.dataset.day);
    updateDayLabels();
    updateInfo();
    updateDayVisibility();
    refreshVrLayer();
    // Focus op de gekozen dag.
    const d = days[currentDay];
    if (d && d.path && !overviewMode) map.fitBounds(boundsOf(d.path).pad(0.07));
  });
});

// Focus op één dag: alleen de route, punten en het pauzepunt van de gekozen
// dag zijn zichtbaar. Het overzicht toont alle routelijnen tegelijk (om
// overlap te zien), zonder bewerkpunten.
function updateDayVisibility() {
  if (!map) return;
  let overviewBounds = null;
  for (let day = 1; day <= 4; day++) {
    const d = days[day];
    if (!d) continue;
    const lineVisible = overviewMode || day === currentDay;
    if (lineVisible) {
      d.routeLine.addTo(map);
      d.arrows.addTo(map);
    } else {
      d.routeLine.remove();
      d.arrows.remove();
    }
    if (overviewMode && d.path) {
      const b = boundsOf(d.path);
      overviewBounds = overviewBounds ? overviewBounds.extend(b) : b;
    }
    const markersVisible = !overviewMode && day === currentDay && editMode !== 'vr';
    d.markers.forEach((mk) => (markersVisible ? mk.addTo(map) : mk.remove()));
    if (d.pauseMarker) {
      if (!overviewMode && day === currentDay) d.pauseMarker.addTo(map);
      else d.pauseMarker.remove();
    }
  }
  if (overviewMode && overviewBounds) map.fitBounds(overviewBounds.pad(0.07));
}

document.getElementById('overview-toggle').addEventListener('change', (e) => {
  overviewMode = e.target.checked;
  pausePlacing = false;
  updatePauseBtn();
  map.closePopup();
  updateDayVisibility();
  refreshVrLayer();
});

function setEditMode(m) {
  editMode = m;
  if (map) map.closePopup();
  document.getElementById('mode-route').classList.toggle('active', m === 'route');
  document.getElementById('mode-rec').classList.toggle('active', m === 'rec');
  document.getElementById('mode-vr').classList.toggle('active', m === 'vr');
  document.getElementById('route-mode').classList.toggle('hidden', m !== 'route');
  document.getElementById('rec-mode').classList.toggle('hidden', m !== 'rec');
  document.getElementById('vr-mode').classList.toggle('hidden', m !== 'vr');
  // In verkeersmodus geen tussenpunt-markers (wel de route van de dag zelf).
  updateDayVisibility();
  refreshVrLayer();
}

document.getElementById('mode-route').addEventListener('click', () => setEditMode('route'));
document.getElementById('mode-rec').addEventListener('click', () => setEditMode('rec'));
document.getElementById('mode-vr').addEventListener('click', () => setEditMode('vr'));

// --- Vastlegmodus: route al lopend vastleggen via GPS ---
const gps = setupGps(() => map);

document.getElementById('rec-add').addEventListener('click', () => {
  const pos = gps.getPosition();
  if (!pos) {
    setSaveStatus('Let op: start eerst de GPS en wacht op een locatie.');
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

// --- Publiceren en verwijderen ---
async function saveCurrentDay() {
  const d = days[currentDay];
  if (d.points.length < 1) return setSaveStatus('Zet eerst minimaal 1 tussenpunt op de kaart.');
  clearTimeout(draftTimers[currentDay]);
  const res = await fetch(`/api/routes/${currentDay}`, {
    method: 'PUT',
    headers: adminHeaders(true),
    body: JSON.stringify({ waypoints: d.points, path: d.path, distance_m: d.distanceM }),
  });
  if (res.ok) {
    draftCounts[currentDay] = 0;
    updateDraftStatus();
    setSaveStatus(`Route dag ${currentDay} is nu definitief — tussenversies zijn opgeruimd.`);
    // Route gewijzigd: tijden en teamroutes kloppend houden met het nieuwe pad.
    replanDay(currentDay, false);
  } else {
    const err = await res.json().catch(() => ({}));
    setSaveStatus('Let op: ' + (err.error || 'publiceren mislukt.'));
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
    headers: adminHeaders(),
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
    setSaveStatus('Let op: ' + (err.error || 'verwijderen mislukt.'));
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
      days[row.day].pause = row.pause || null;
      drawPauseMarker(row.day);
      loadDayPoints(row.day, row.waypoints);
    }
    const draftsRes = await fetch('/api/admin/drafts', { headers: adminHeaders() });
    if (draftsRes.ok) {
      for (const draft of await draftsRes.json()) {
        draftCounts[draft.day] = draft.count;
        loadDayPoints(draft.day, draft.waypoints);
      }
    }
  } catch {
    setSaveStatus('Let op: opgeslagen routes laden mislukt.');
  } finally {
    loadingRoutes = false;
    updateDraftStatus();
    updateDayVisibility();
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
    headers: adminHeaders(),
  });
  if (!res.ok) {
    setSaveStatus('Let op: terugdraaien mislukt.');
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
// Verkeersmodus
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
        headers: adminHeaders(true),
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
// het gesnapte punt zelf, en de afstand langs het pad.
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

// Minuten na vertrek waarop de kop van de stoet een punt bereikt.
function headMin(alongM) {
  return (alongM / 1000 / vrSettings.walkKmh) * 60;
}

// Minuten waarop het team weer weg mag: pas als álle wandelaars voorbij zijn.
function leaveMin(alongM) {
  return headMin(alongM) + vrSettings.passMin;
}

// Geschatte fietstijd in minuten (hemelsbreed × omrijfactor) voor de planner.
function bikeMin(a, b) {
  return ((distM(a, b) * 1.35) / 1000 / vrSettings.bikeKmh) * 60;
}

const round1 = (n) => Math.round(n * 10) / 10;

// Oversteekpunt toevoegen (klik op de kaart in verkeersmodus); alleen
// mogelijk óp de wandelroute: een klik vlak naast de route wordt op de
// route gesnapt, verder weg wordt geweigerd.
const MANUAL_SNAP_M = 50;

async function addManualCrossing(clicked) {
  const d = days[currentDay];
  if (!d.path) {
    setVrStatus('Let op: teken en publiceer eerst de wandelroute van deze dag.');
    return;
  }
  const nearest = nearestOnPath(d.path, clicked);
  if (nearest.dist > MANUAL_SNAP_M) {
    setVrStatus(
      `Let op: punt niet toegevoegd — oversteekpunten moeten op de wandelroute liggen. Klik op (of vlak naast) de route van dag ${currentDay}.`
    );
    return;
  }
  const point = { lat: nearest.lat, lng: nearest.lng };
  let name = 'oversteekpunt';
  try {
    const res = await fetch(`/api/address?lat=${point.lat}&lng=${point.lng}`);
    if (res.ok) {
      const data = await res.json();
      if (data.road) name = data.road;
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
  });
  await saveCrossings(currentDay);
  refreshVrLayer();
  setVrStatus(`Punt "${name}" toegevoegd. Wijs er via het ruitje een team aan toe.`);
}

async function saveCrossings(day) {
  const res = await fetch(`/api/admin/crossings/${day}`, {
    method: 'PUT',
    headers: adminHeaders(true),
    body: JSON.stringify({ crossings: days[day].crossings }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    setVrStatus('Let op: ' + (err.error || 'kruisingen opslaan mislukt.'));
  }
}

// --- Verkeerslaag op de kaart ---
function refreshVrLayer() {
  vrLayers.forEach((l) => l.remove());
  vrLayers = [];
  if (editMode !== 'vr' || overviewMode) return;

  const d = days[currentDay];
  let visibleIndex = 0;
  for (const c of d.crossings) {
    if (!c.hidden) visibleIndex++;
    const team = c.team != null ? teamById(c.team) : null;
    const marker = L.marker([c.lat, c.lng], {
      icon: diamondIcon(
        c.hidden ? '#9ca3af' : team ? team.color : '#f59e0b',
        c.hidden ? '' : String(visibleIndex),
        c.hidden
      ),
      zIndexOffset: 500,
      title: c.name,
    }).addTo(map);
    marker.on('click', () => openCrossingMenu(c, marker));
    vrLayers.push(marker);
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
    map.closePopup();
    refreshVrLayer();
    // Handmatige toewijzing: routes direct opnieuw berekenen en toetsen.
    await replanDay(currentDay, false);
  });
  div.appendChild(teamSelect);

  div.appendChild(
    menuButton('Bekijk in Street View', () => {
      map.closePopup();
      openStreetView(c.lat, c.lng);
    })
  );

  div.appendChild(
    menuButton('Verwijder dit punt', async () => {
      const d = days[currentDay];
      d.crossings = d.crossings.filter((x) => x !== c);
      await saveCrossings(currentDay);
      map.closePopup();
      refreshVrLayer();
      await replanDay(currentDay, false);
    })
  );

  openMapMenu(map, marker.getLatLng(), div);
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
      await fetch(`/api/admin/teams/${t.id}`, { method: 'DELETE', headers: adminHeaders() });
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
    headers: adminHeaders(true),
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
    setVrStatus('Let op: ' + (err.error || 'team aanmaken mislukt.'));
  }
});

// --- Automatisch plannen ---
// Eén team bemant één punt tegelijk. Het team mag pas vertrekken als de héle
// stoet zijn punt voorbij is, en moet zijn volgende punt bereiken vóórdat de
// kop van de stoet daar aankomt. Dicht opeenvolgende punten krijgen daardoor
// automatisch verschillende teams.
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
      `Let op: ${unassigned} van de ${ordered.length} punten kunnen met ${teams.length} team(s) niet op tijd bemand worden (een team bemant één punt tegelijk) — voeg teams toe of verwijder punten.`
    );
  } else {
    setVrStatus(`Alle ${ordered.length} punten verdeeld over ${teams.length} team(s).`);
  }
}

// --- Teamroutes berekenen (OSRM, fietsprofiel), tijden en conflicten toetsen ---
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
        headers: adminHeaders(true),
        body: JSON.stringify({ path: null }),
      });
      continue;
    }
    let route;
    try {
      route = await osrmRoute('bike', [startFinish, ...points.map((p) => p.c), startFinish]);
    } catch (err) {
      problems.push(`route van ${team.name} kon niet berekend worden (${err.message})`);
      continue;
    }
    const teamPath = route.path;
    const distance = route.distance_m;

    // Tijdstoets: een team bemant één punt tegelijk. Vertrekken kan pas als
    // de héle stoet voorbij is; het volgende punt moet bereikt zijn vóórdat
    // de kop van de stoet daar aankomt.
    // legs[i] is de fietsleg van punt i-1 naar punt i (leg 0 = vanaf start).
    const schedule = points.map(({ c, along }) => ({
      name: c.name,
      headMin: round1(headMin(along)),
      leaveMin: round1(leaveMin(along)),
    }));
    let feasible = true;
    const late = [];
    for (let i = 1; i < points.length; i++) {
      const bikeMinutes = route.legs[i].duration_s / 60;
      const arrive = leaveMin(points[i - 1].along) + bikeMinutes + vrSettings.marginMin;
      const deadline = headMin(points[i].along);
      schedule[i].arriveMin = round1(arrive);
      if (arrive > deadline) {
        feasible = false;
        late.push({ point: schedule[i].name, lateMin: round1(arrive - deadline) });
      }
    }
    const timing = { feasible, schedule, late };

    // Doorkruist de teamroute de wandelstoet? Goedgekeurde uitzonderingen
    // van een eerdere berekening blijven goedgekeurd (op basis van plek).
    let conflicts = [];
    const confRes = await fetch(`/api/admin/conflicts/${day}`, {
      method: 'POST',
      headers: adminHeaders(true),
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
      headers: adminHeaders(true),
      body: JSON.stringify({ path: teamPath, distance_m: distance, conflicts, timing }),
    });
    teamRoutes[key] = { team_id: team.id, day, path: teamPath, distance_m: distance, conflicts, timing };

    if (!feasible) {
      problems.push(
        `${team.name} haalt het niet: ${late.map((l) => `${l.point} (${l.lateMin} min te laat)`).join(', ')}`
      );
    }
    const openConflicts = conflicts.filter((cf) => !cf.approved).length;
    if (openConflicts > 0) {
      problems.push(
        `route van ${team.name} DOORKRUIST de wandelroute op ${openConflicts} plek(ken) — los op of keur goed via het rode uitroepteken`
      );
    }
  }
  refreshVrLayer();
  if (problems.length > 0) {
    setVrStatus('Let op: ' + problems.join(' — '));
  } else {
    setVrStatus('Planning compleet: alle punten zijn op tijd bemand en geen teamroute kruist de stoet.');
  }
}

// De hele planningsketen: punten verdelen en teamroutes berekenen/toetsen.
// Draait automatisch na teamwijzigingen, toewijzingen en routepublicatie.
async function replanDay(day, reassign) {
  if (reassign) await autoplanDay(day);
  await computeTeamRoutesForDay(day);
}

function drawTeamRoutes() {
  for (const team of teams) {
    const tr = teamRoutes[`${team.id}_${currentDay}`];
    if (!tr || !tr.path) continue;
    vrLayers.push(dashedLine(tr.path, team.color).addTo(map));
    for (const conflict of tr.conflicts || []) {
      const marker = L.marker([conflict.lat, conflict.lng], {
        icon: conflictIcon(!!conflict.approved),
        zIndexOffset: 1100,
        title: conflict.approved
          ? `Goedgekeurde uitzondering: route van ${team.name} kruist hier de wandelroute`
          : `Conflict: route van ${team.name} kruist de wandelroute hier`,
      }).addTo(map);
      marker.on('click', () => openConflictMenu(team, tr, conflict, marker));
      vrLayers.push(marker);
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

  div.appendChild(
    menuButton(conflict.approved ? 'Goedkeuring intrekken' : 'Keur uitzondering goed', async () => {
      conflict.approved = !conflict.approved;
      map.closePopup();
      await fetch(`/api/admin/team-route/${team.id}/${currentDay}`, {
        method: 'PUT',
        headers: adminHeaders(true),
        body: JSON.stringify({
          path: tr.path,
          distance_m: tr.distance_m,
          conflicts: tr.conflicts,
          timing: tr.timing,
        }),
      });
      refreshVrLayer();
    })
  );

  div.appendChild(
    menuButton('Bekijk in Street View', () => {
      map.closePopup();
      openStreetView(conflict.lat, conflict.lng);
    })
  );

  openMapMenu(map, marker.getLatLng(), div);
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
    setVrStatus('Let op: ' + warnings.join('; ') + '. Pas de planning aan.');
  }
}

updateDayLabels();
init();
