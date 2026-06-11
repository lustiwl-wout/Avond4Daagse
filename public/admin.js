// Adminpagina: routes voor dag 1 t/m 4 tekenen en beheren, plus de
// verkeersmodus (oversteekpunten en teamtoewijzing).
// Kaart: OpenStreetMap/Leaflet. Wandelroute: OSRM (voetprofiel).
// Street View: Google (overlay). Start en finish liggen vast; de admin
// tekent alleen tussenpunten en de wandelroute is altijd lopend.
const NL_CENTER = { lat: 52.2, lng: 5.3 };
const MAX_POINTS = 25;

// Planningsinstellingen (overschreven door opgeslagen waarden uit de database).
let vrSettings = { walkKmh: 4, passMin: 8 };

let map;
let currentDay = 1;
let editMode = 'route'; // 'route' | 'rec' | 'vr'
let pausePlacing = false;
let overviewMode = false;
let schedule = null; // per dag {date, time}
let sponsors = [];
let sponsorLayers = [];
let loggedIn = false;
const PWD_KEY = `a4d-admin-password-${SLUG}`;
let password = sessionStorage.getItem(PWD_KEY) || '';
let startFinish = null;
let startMarker = null;
let teams = [];

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

const pendingDraft = { 1: false, 2: false, 3: false, 4: false };

function scheduleDraftSave(day) {
  if (loadingRoutes || !loggedIn) return;
  pendingDraft[day] = true;
  clearTimeout(draftTimers[day]);
  draftTimers[day] = setTimeout(() => saveDraft(day), 800);
}

// Wachtende conceptopslag direct uitvoeren (zodat Ctrl+Z/herstellen de
// allerlaatste wijziging terugdraait en niet eentje te ver springt).
async function flushDraftSave(day) {
  if (!pendingDraft[day]) return;
  clearTimeout(draftTimers[day]);
  await saveDraft(day);
}

async function saveDraft(day) {
  pendingDraft[day] = false;
  const d = days[day];
  try {
    const res = await fetch(api(`/admin/drafts/${day}`), {
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
  updateLockUI();
}

// --- Definitief = vergrendeld ---
// Een dag met een gepubliceerde route en zonder concepten is definitief:
// route, pauzepunt en tussenpunten zijn dan niet te bewerken totdat de dag
// is teruggezet naar concept. De verkeersmodus (oversteekpunten en teams)
// blijft gewoon werken — die hoort juist bij de definitieve route.
function dayLocked(day = currentDay) {
  const d = days[day];
  return !!(d && d.published && draftCounts[day] === 0);
}

function lockedMessage() {
  setSaveStatus(
    `Dag ${currentDay} is definitief — zet hem eerst terug naar concept (knop bovenaan de zijbalk).`
  );
}

function updateLockUI() {
  const locked = dayLocked();
  for (const id of ['draw-section', 'pause-section', 'publish-section', 'move-section']) {
    const el = document.getElementById(id);
    if (el) el.classList.toggle('hidden', locked);
  }
  const box = document.getElementById('locked-section');
  if (box) box.classList.toggle('hidden', !locked);
  const btn = document.getElementById('unlock-btn');
  if (btn) btn.textContent = `Zet dag ${currentDay} terug naar concept`;
  updateDayVisibility();
}

document.getElementById('unlock-btn').addEventListener('click', async () => {
  if (!dayLocked()) return;
  // Eerste concept = kopie van de definitieve versie; daarmee is de dag
  // weer bewerkbaar. Bezoekers blijven de definitieve route zien.
  await saveDraft(currentDay);
  setSaveStatus(
    `Dag ${currentDay} staat weer in concept. Maak de dag opnieuw definitief als je klaar bent met bewerken.`
  );
});

// --- Kaart ---
async function init() {
  const res = await fetch(api('/config'));
  const config = await res.json();
  const brandSub = document.getElementById('brand-sub');
  if (brandSub && config.orgName) brandSub.textContent = 'Avond4Daagse · ' + config.orgName;
  setStreetViewKey(config.googleMapsApiKey || '');
  startFinish = config.startFinish;
  schedule = config.schedule || null;
  announcementText = config.announcement || '';
  if (config.vrSettings) vrSettings = { ...vrSettings, ...config.vrSettings };

  document.getElementById('back-link').href = eventUrl('');
  map = createMap('map', startFinish || NL_CENTER, startFinish ? 15 : 8);

  for (let day = 1; day <= 4; day++) {
    days[day] = {
      points: [],
      markers: [],
      distanceM: 0,
      path: null,
      crossings: [],
      pause: null,
      pauseMarker: null,
      published: false,
      // interactive: false — klikken op de lijn moeten de kaart bereiken
      // (punt toevoegen, pauzepunt en oversteekpunten op de route zetten).
      routeLine: L.polyline([], { color: DAY_COLORS[day], weight: 5, opacity: 0.8, interactive: false }),
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
      if (dayLocked()) return lockedMessage();
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
    const res = await fetch(api('/admin/check'), { headers: { 'x-admin-password': pwd } });
    if (res.status === 204) {
      password = pwd;
      sessionStorage.setItem(PWD_KEY, pwd);
      loggedIn = true;
      document.getElementById('login-section').classList.add('hidden');
      document.getElementById('editor').classList.remove('hidden');
      await ensureStartFinish();
      await Promise.all([loadSavedRoutes(), loadTeams(), loadSponsors()]);
      renderTeams();
      initSettingsInputs();
      initEventInput();
      initAnnouncement();
      renderQrCodes();
      updateDraftStatus();
    } else {
      const err = await res.json().catch(() => ({}));
      status.textContent = 'Let op: ' + (err.error || 'inloggen mislukt.');
      sessionStorage.removeItem(PWD_KEY);
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
    startFinish = { ...NL_CENTER };
    setSaveStatus(
      'Zet eerst start & finish: zoek hieronder het adres op of sleep de markering naar de juiste plek.',
      true
    );
    placeStartMarker();
    map.setView([startFinish.lat, startFinish.lng], 8);
    return;
  }
  placeStartMarker();
  map.setView([startFinish.lat, startFinish.lng], 15);
}

// Adres zoeken voor start & finish.
document.getElementById('start-search').addEventListener('click', async () => {
  const q = document.getElementById('start-address').value.trim();
  if (!q) return setSaveStatus('Vul eerst een adres in.');
  setSaveStatus('Adres opzoeken…');
  const res = await fetch(api(`/admin/geocode?q=${encodeURIComponent(q)}`), {
    headers: adminHeaders(),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    setSaveStatus('Let op: ' + (err.error || 'adres niet gevonden.'));
    return;
  }
  startFinish = await res.json();
  await saveStartFinish();
  placeStartMarker();
  map.setView([startFinish.lat, startFinish.lng], 16);
  setSaveStatus('Start & finish gezet — fijnafstellen kan door de markering te slepen.');
});

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
  await fetch(api('/admin/start-finish'), {
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
  if (status === 'NOROUTE' || status === 'FAIL') {
    // Mislukt: punt terugdraaien. De lijn is niet aangepast (de berekening
    // faalde vóór het tekenen), dus opnieuw berekenen is niet nodig.
    d.points.splice(index, 1);
    d.markers[index].remove();
    d.markers.splice(index, 1);
    relabelMarkers(day);
    updateInfo();
    if (status === 'NOROUTE') {
      setSaveStatus(
        'Let op: daar kan geen wandelroute langs — het punt is niet toegevoegd. Kies een plek op of vlak naast een straat of pad.',
        true
      );
    }
    // Bij FAIL staat de storingsmelding van updateRoute er al.
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
    icon: vertexIcon(DAY_COLORS[day]),
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
    if (status === 'NOROUTE' || status === 'FAIL') {
      // Mislukt: punt terug naar de vorige plek (de lijn is niet aangepast).
      d.points[i] = previous;
      marker.setLatLng([previous.lat, previous.lng]);
      if (status === 'NOROUTE') {
        setSaveStatus('Let op: daar kan geen wandelroute langs — het punt is teruggezet.', true);
      }
    } else {
      scheduleDraftSave(day);
    }
  });
  marker.on('click', () => openPointMenu(day, marker));
  d.markers.splice(index, 0, marker);
}

// Tussenpunten zijn tekenhandvatten zonder nummer; alleen het icoon wordt
// ververst (de volgorde blijft intern bekend voor het invoegmenu).
function relabelMarkers(day) {
  days[day].markers.forEach((m) => m.setIcon(vertexIcon(DAY_COLORS[day])));
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
  let res;
  try {
    res = await fetch(api('/admin/route'), {
      method: 'POST',
      headers: adminHeaders(true),
      body: JSON.stringify({ profile, points }),
      signal: AbortSignal.timeout(40000),
    });
  } catch {
    throw new Error('Routeservice niet bereikbaar — controleer je verbinding en probeer het opnieuw.');
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    const e = new Error(err.error || 'Routeservice niet bereikbaar.');
    // 422 = er bestaat echt geen wandelroute; al het andere is een storing.
    e.noRoute = res.status === 422;
    throw e;
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
  setSaveStatus('Wandelroute berekenen…', true);
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
    setSaveStatus('');
    return 'OK';
  } catch (err) {
    console.error('Route berekenen mislukt:', err);
    setSaveStatus('Let op: ' + err.message, !err.noRoute);
    updateInfo();
    return err.noRoute ? 'NOROUTE' : 'FAIL';
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
// te genereren; aanroeper zet loadingRoutes. Zit er een opgeslagen pad bij
// (`saved`), dan tekenen we dat direct — zo blijft de route ook zichtbaar
// als de routeservice even niet bereikbaar is. Herberekenen gebeurt alleen
// bij echte wijzigingen.
function loadDayPoints(day, waypoints, saved = null) {
  clearDay(day);
  const d = days[day];
  for (const p of waypoints || []) {
    d.points.push(p);
    addMarker(day, p, d.points.length - 1);
  }
  relabelMarkers(day);
  if (saved && Array.isArray(saved.path) && saved.path.length > 1) {
    d.path = saved.path;
    d.distanceM = Number(saved.distance_m) || 0;
    d.routeLine.setLatLngs(d.path.map((p) => [p.lat, p.lng]));
    d.arrows.remove();
    d.arrows = directionArrows(d.path, DAY_COLORS[day]);
    updateDayVisibility();
    updateInfo();
  } else {
    updateRoute(day);
  }
}

// --- Pauzepunt: ligt altijd op de route, versleepbaar ---
const PAUSE_SNAP_M = 50;

function updatePauseBtn() {
  const d = days[currentDay]; // bestaat nog niet vóór init()
  document.getElementById('pause-btn').textContent = pausePlacing
    ? 'Klik op de route… (of klik hier om te annuleren)'
    : `Pauzepunt ${d && d.pause ? 'verplaatsen' : 'plaatsen'} (dag ${currentDay})`;
  updateMapCursor();
}

// Richtkruis-cursor zodra een klik op de kaart een punt plaatst (oversteek-
// punt in verkeersmodus, of het pauzepunt), zodat zichtbaar is dat je kunt
// klikken.
function updateMapCursor() {
  const el = document.getElementById('map');
  if (el) el.classList.toggle('placing', !overviewMode && (editMode === 'vr' || pausePlacing));
}

document.getElementById('pause-btn').addEventListener('click', () => {
  if (dayLocked()) return lockedMessage();
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
  const res = await fetch(api(`/admin/pause/${day}`), {
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
    if (dayLocked(day)) {
      d.pauseMarker.setLatLng([d.pause.lat, d.pause.lng]);
      lockedMessage();
      return;
    }
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
        if (dayLocked(day)) return lockedMessage();
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
      const res = await fetch(api('/admin/event-schedule'), {
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
    const res = await fetch(api('/admin/sponsors'), { headers: adminHeaders() });
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
      await fetch(api(`/admin/sponsors/${s.id}`), { method: 'DELETE', headers: adminHeaders() });
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
  updateMoveTargets();
  updateStoetBtn();
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
    const markersVisible =
      !overviewMode && day === currentDay && editMode !== 'vr' && !dayLocked(day);
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
  updateMapCursor();
}

document.getElementById('mode-route').addEventListener('click', () => setEditMode('route'));
document.getElementById('mode-rec').addEventListener('click', () => setEditMode('rec'));
document.getElementById('mode-vr').addEventListener('click', () => setEditMode('vr'));

// --- Vastlegmodus: route al lopend vastleggen via GPS ---
const gps = setupGps(() => map);

document.getElementById('rec-add').addEventListener('click', () => {
  if (dayLocked()) return lockedMessage();
  const pos = gps.getPosition();
  if (!pos) {
    setSaveStatus('Let op: start eerst de GPS en wacht op een locatie.');
    return;
  }
  addPoint(currentDay, pos);
});

document.getElementById('rec-undo').addEventListener('click', () => {
  if (dayLocked()) return lockedMessage();
  const d = days[currentDay];
  if (d.points.length === 0) return;
  removePoint(currentDay, d.points.length - 1);
});

document.getElementById('rec-save').addEventListener('click', () => saveCurrentDay());

document.getElementById('undo-btn').addEventListener('click', () => {
  if (dayLocked()) return lockedMessage();
  const d = days[currentDay];
  if (d.points.length === 0) return;
  removePoint(currentDay, d.points.length - 1);
});

document.getElementById('clear-btn').addEventListener('click', () => {
  if (dayLocked()) return lockedMessage();
  clearDay(currentDay);
});

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
  if (dayLocked()) return lockedMessage();
  if (d.points.length < 1) return setSaveStatus('Zet eerst minimaal 1 tussenpunt op de kaart.');
  clearTimeout(draftTimers[currentDay]);
  const res = await fetch(api(`/routes/${currentDay}`), {
    method: 'PUT',
    headers: adminHeaders(true),
    body: JSON.stringify({ waypoints: d.points, path: d.path, distance_m: d.distanceM }),
  });
  if (res.ok) {
    draftCounts[currentDay] = 0;
    d.published = true;
    updateDraftStatus();
    setSaveStatus(
      `Route dag ${currentDay} is nu definitief en vergrendeld — bewerken kan weer na "terug naar concept".`
    );
  } else {
    const err = await res.json().catch(() => ({}));
    setSaveStatus('Let op: ' + (err.error || 'publiceren mislukt.'));
  }
}

document.getElementById('save-btn').addEventListener('click', () => saveCurrentDay());

// --- Route naar een andere dag verplaatsen (of dagen omwisselen) ---
function updateMoveTargets() {
  const select = document.getElementById('move-target');
  select.innerHTML = '';
  for (let day = 1; day <= 4; day++) {
    if (day === currentDay) continue;
    const opt = document.createElement('option');
    opt.value = day;
    opt.textContent = `Dag ${day}${days[day] && days[day].points.length > 0 ? ' (heeft al een route — wordt omgewisseld)' : ''}`;
    select.appendChild(opt);
  }
  document.getElementById('move-btn').textContent = `Verplaats dag ${currentDay} naar de gekozen dag`;
}

document.getElementById('move-btn').addEventListener('click', async () => {
  if (dayLocked()) return lockedMessage();
  const target = Number(document.getElementById('move-target').value);
  const d = days[currentDay];
  if (!target || target === currentDay) return;
  if (d.points.length === 0 && !d.pause && d.crossings.length === 0) {
    setSaveStatus('Er valt op deze dag niets te verplaatsen.');
    return;
  }
  const swap = days[target] && days[target].points.length > 0;
  const vraag = swap
    ? `Dag ${currentDay} en dag ${target} omwisselen (beide dagen hebben een route)?`
    : `Alles van dag ${currentDay} verplaatsen naar dag ${target}?`;
  if (!confirm(vraag)) return;
  const res = await fetch(api('/admin/move-route'), {
    method: 'POST',
    headers: adminHeaders(true),
    body: JSON.stringify({ from: currentDay, to: target }),
  });
  if (res.ok) {
    // Alles is server-side verhuisd; vers laden is de betrouwbaarste weg.
    location.reload();
  } else {
    const err = await res.json().catch(() => ({}));
    setSaveStatus('Let op: ' + (err.error || 'verplaatsen mislukt.'));
  }
});

document.getElementById('print-btn').addEventListener('click', () => {
  window.open(eventUrl(`/print?day=${currentDay}`), '_blank');
});

document.getElementById('delete-btn').addEventListener('click', async () => {
  if (dayLocked()) return lockedMessage();
  if (!confirm(`Route van dag ${currentDay} verwijderen uit de database?`)) return;
  const res = await fetch(api(`/routes/${currentDay}`), {
    method: 'DELETE',
    headers: adminHeaders(),
  });
  if (res.ok || res.status === 404) {
    loadingRoutes = true;
    clearDay(currentDay);
    loadingRoutes = false;
    clearTimeout(draftTimers[currentDay]);
    draftCounts[currentDay] = 0;
    days[currentDay].published = false;
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
    const res = await fetch(api('/routes'));
    if (!res.ok) throw new Error();
    const rows = await res.json();
    for (const row of rows) {
      days[row.day].crossings = row.crossings || [];
      days[row.day].pause = row.pause || null;
      days[row.day].published = (row.waypoints || []).length > 0;
      drawPauseMarker(row.day);
      loadDayPoints(row.day, row.waypoints, row);
    }
    const draftsRes = await fetch(api('/admin/drafts'), { headers: adminHeaders() });
    if (draftsRes.ok) {
      for (const draft of await draftsRes.json()) {
        draftCounts[draft.day] = draft.count;
        loadDayPoints(draft.day, draft.waypoints, draft);
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

// Laatste wijziging terugdraaien (één conceptversie terug) — via de knop
// of met Ctrl+Z (Cmd+Z op een Mac).
async function revertLastChange() {
  await flushDraftSave(currentDay);
  if (draftCounts[currentDay] === 0) {
    setSaveStatus('Er zijn geen conceptwijzigingen om terug te draaien.');
    return;
  }
  const res = await fetch(api(`/admin/drafts/${currentDay}/latest`), {
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
    loadDayPoints(currentDay, data.draft.waypoints, data.draft);
  } else {
    // Geen concepten meer: terug naar de definitieve versie.
    const pubRes = await fetch(api('/routes'));
    const rows = pubRes.ok ? await pubRes.json() : [];
    const row = rows.find((r) => r.day === currentDay);
    loadDayPoints(currentDay, row ? row.waypoints : [], row);
  }
  loadingRoutes = false;
  updateDraftStatus();
  setSaveStatus('Vorige versie hersteld.');
}

document.getElementById('revert-btn').addEventListener('click', () => revertLastChange());

document.addEventListener('keydown', (e) => {
  if (!(e.ctrlKey || e.metaKey) || e.shiftKey || e.key.toLowerCase() !== 'z') return;
  // In invoervelden doet Ctrl+Z gewoon tekst-ongedaanmaken.
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
  if (!loggedIn || editMode === 'vr') return;
  e.preventDefault();
  revertLastChange();
});

// =====================================================================
// Verkeersmodus
// =====================================================================

async function loadTeams() {
  const res = await fetch(api('/teams'));
  if (res.ok) teams = await res.json();
}

function teamById(id) {
  return teams.find((t) => t.id === id) || null;
}

// --- Planningsinstellingen ---
const SETTING_INPUTS = {
  walkKmh: 'set-walk',
  passMin: 'set-pass',
};

function initSettingsInputs() {
  for (const [key, id] of Object.entries(SETTING_INPUTS)) {
    const input = document.getElementById(id);
    input.value = vrSettings[key];
    input.addEventListener('change', async () => {
      const value = Number(input.value);
      if (!Number.isFinite(value) || value < 0) return;
      vrSettings[key] = value;
      await fetch(api('/admin/vr-settings'), {
        method: 'PUT',
        headers: adminHeaders(true),
        body: JSON.stringify(vrSettings),
      });
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
  // Eerst opslaan en tonen — de straatnaam komt er daarna op de
  // achtergrond bij (adresdienst kan traag zijn en mag niets blokkeren).
  setVrStatus('Oversteekpunt toevoegen…');
  const day = currentDay;
  const data = await crossingRequest(day, 'POST', '', point);
  if (!data || !data.crossing) return;
  setVrStatus('Punt toegevoegd. Wijs er via het ruitje een team aan toe.');
  // Naam (kruising/brug/huisnummer) op de achtergrond bijschrijven. De
  // adres-wachtrij op de server doet ~1 s per punt, dus bij meerdere snel
  // geplaatste punten kan dit even duren — ruime timeout en één herkansing.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await fetch(`/api/address?lat=${point.lat}&lng=${point.lng}`, {
        signal: AbortSignal.timeout(25000),
      });
      if (!res.ok) throw new Error();
      const { road } = await res.json();
      // Alleen bijschrijven zolang het punt nog zijn standaardnaam heeft —
      // een ondertussen handmatig gekozen naam blijft staan.
      const current = days[day].crossings.find((x) => x.id === data.crossing.id);
      if (road && current && current.name === 'oversteekpunt' && !current.customName) {
        await crossingRequest(day, 'PUT', `/${encodeURIComponent(data.crossing.id)}`, {
          name: road,
        });
      }
      return;
    } catch {
      // even wachten en nog één keer proberen; naam is niet kritisch
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}

// Eén oversteekpunt toevoegen/bijwerken/verwijderen. De server werkt de
// lijst atomair bij en stuurt de actuele lijst terug; die nemen we over —
// zo blijven twee open schermen elkaars wijzigingen niet overschrijven.
// Geeft het antwoord van de server terug, of null bij een fout.
async function crossingRequest(day, method, suffix, body = null) {
  let res;
  try {
    res = await fetch(api(`/admin/crossings/${day}${suffix}`), {
      method,
      headers: adminHeaders(!!body),
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    setVrStatus('Let op: server niet bereikbaar — probeer het opnieuw.');
    return null;
  }
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    setVrStatus('Let op: ' + (err.error || 'oversteekpunt opslaan mislukt.'));
    return null;
  }
  const data = await res.json().catch(() => null);
  if (data && Array.isArray(data.crossings)) days[day].crossings = data.crossings;
  refreshVrLayer();
  return data || {};
}

// --- Verkeerslaag op de kaart ---
// Op één plek kunnen meerdere items over elkaar staan. Alle klikbare
// items melden zich aan in dit register; bij
// een klik op een plek met meerdere items binnen 20 m verschijnt eerst een
// keuzemenu.
let vrClickItems = [];

function openStackedMenu(item) {
  const nearby = vrClickItems.filter((x) => distM(x, item) < 20);
  if (nearby.length <= 1) {
    item.open();
    return;
  }
  const div = document.createElement('div');
  div.className = 'point-menu';
  const title = document.createElement('strong');
  title.textContent = 'Hier staan meerdere items — kies er één:';
  div.appendChild(title);
  for (const x of nearby) {
    div.appendChild(
      menuButton(x.label, () => {
        map.closePopup();
        x.open();
      })
    );
  }
  openMapMenu(map, [item.lat, item.lng], div);
}

function refreshVrLayer() {
  vrLayers.forEach((l) => l.remove());
  vrLayers = [];
  vrClickItems = [];
  if (editMode !== 'vr' || overviewMode) return;

  const d = days[currentDay];
  // Nummering volgt de looprichting: sorteren op afstand langs de route.
  const order = new Map();
  if (d.path) d.crossings.forEach((c) => order.set(c, alongPath(d.path, c)));
  const sorted = [...d.crossings].sort((a, b) => (order.get(a) || 0) - (order.get(b) || 0));
  let visibleIndex = 0;
  for (const c of sorted) {
    if (!c.hidden) visibleIndex++;
    const assigned = crossingTeams(c).map(teamById).filter(Boolean);
    const marker = L.marker([c.lat, c.lng], {
      icon: diamondIcon(
        c.hidden ? '#9ca3af' : crossingColor(assigned),
        c.hidden ? '' : String(visibleIndex),
        c.hidden
      ),
      // Boven de start/finish-vlag (900): ligt er een oversteekpunt op de
      // start/finish-plek, dan moet het ruitje bovenop liggen en klikbaar zijn.
      zIndexOffset: 1000,
      title: c.name,
    }).addTo(map);
    const teamNames = assigned.map((t) => t.name).join(' + ');
    const item = {
      lat: c.lat,
      lng: c.lng,
      label: `Oversteekpunt ${c.hidden ? '(verborgen)' : visibleIndex}: ${c.name}${teamNames ? ` — ${teamNames}` : ''}`,
      open: () => openCrossingMenu(c, marker),
    };
    vrClickItems.push(item);
    marker.on('click', () => openStackedMenu(item));
    vrLayers.push(marker);
  }

}

function openCrossingMenu(c, marker) {
  const div = document.createElement('div');
  div.className = 'point-menu';

  const title = document.createElement('strong');
  title.textContent = `Oversteek: ${c.name}`;
  div.appendChild(title);

  // Naam aanpassen — een handmatige naam wordt daarna nooit meer
  // overschreven door de automatische opzoeking of de printversie.
  const nameInput = document.createElement('input');
  nameInput.type = 'text';
  nameInput.value = c.name;
  nameInput.maxLength = 120;
  nameInput.placeholder = 'Naam van deze plek';
  div.appendChild(nameInput);
  const saveName = async () => {
    const name = nameInput.value.trim();
    if (!name || name === c.name) return;
    map.closePopup();
    const ok = await crossingRequest(currentDay, 'PUT', `/${encodeURIComponent(c.id)}`, {
      name,
      custom: true,
    });
    if (ok) setVrStatus(`Punt hernoemd naar "${name}".`);
  };
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') saveName();
  });
  div.appendChild(menuButton('Naam opslaan', saveName));

  // Maximaal twee teams per punt (voor grote kruisingen).
  const assigned = crossingTeams(c);
  const makeTeamSelect = (placeholder, value) => {
    const select = document.createElement('select');
    const noneOpt = document.createElement('option');
    noneOpt.value = '';
    noneOpt.textContent = placeholder;
    select.appendChild(noneOpt);
    for (const t of teams) {
      const opt = document.createElement('option');
      opt.value = t.id;
      opt.textContent = t.name;
      select.appendChild(opt);
    }
    select.value = value != null ? String(value) : '';
    return select;
  };
  const sel1 = makeTeamSelect('— geen team —', assigned[0]);
  const sel2 = makeTeamSelect('— geen tweede team —', assigned[1]);
  const onTeamsChanged = async () => {
    const ids = [...new Set([sel1.value, sel2.value].filter(Boolean).map(Number))];
    map.closePopup();
    await crossingRequest(currentDay, 'PUT', `/${encodeURIComponent(c.id)}`, { teams: ids });
  };
  sel1.addEventListener('change', onTeamsChanged);
  sel2.addEventListener('change', onTeamsChanged);
  div.appendChild(sel1);
  div.appendChild(sel2);

  div.appendChild(
    menuButton('Bekijk in Street View', () => {
      map.closePopup();
      openStreetView(c.lat, c.lng);
    })
  );

  div.appendChild(
    menuButton('Verwijder dit punt', async () => {
      map.closePopup();
      await crossingRequest(currentDay, 'DELETE', `/${encodeURIComponent(c.id)}`);
    })
  );

  openMapMenu(map, marker.getLatLng(), div);
}

// --- Live stoetvolger: eigen GPS-positie delen als kop van de stoet ---
let stoetWatchId = null;
let stoetDay = null;
let stoetLastSent = 0;
let stoetWakeLock = null;

// Browsers pauzeren GPS zodra het scherm vergrendelt; houd het scherm
// daarom wakker zolang het delen aanstaat (waar de browser dat kan).
async function stoetKeepAwake(on) {
  try {
    if (on && 'wakeLock' in navigator && !stoetWakeLock) {
      stoetWakeLock = await navigator.wakeLock.request('screen');
      stoetWakeLock.addEventListener('release', () => {
        stoetWakeLock = null;
      });
    } else if (!on && stoetWakeLock) {
      await stoetWakeLock.release();
      stoetWakeLock = null;
    }
  } catch {
    // zonder wake lock werkt het delen ook — alleen niet met scherm uit
  }
}

// Komt de pagina terug in beeld (telefoon ontgrendeld), pak de wake lock
// dan opnieuw — die wordt door de browser losgelaten bij vergrendelen.
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && stoetWatchId !== null) stoetKeepAwake(true);
});

function setStoetStatus(text) {
  document.getElementById('stoet-status').textContent = text;
}

function updateStoetBtn() {
  document.getElementById('stoet-btn').textContent =
    stoetWatchId === null
      ? `Start stoet delen (dag ${currentDay})`
      : `Stop stoet delen (dag ${stoetDay})`;
}

async function stopStoet() {
  if (stoetWatchId !== null) navigator.geolocation.clearWatch(stoetWatchId);
  stoetWatchId = null;
  stoetKeepAwake(false);
  setStoetStatus('');
  if (stoetDay !== null) {
    await fetch(api(`/admin/stoet/${stoetDay}`), { method: 'DELETE', headers: adminHeaders() }).catch(
      () => {}
    );
    stoetDay = null;
  }
  updateStoetBtn();
}

document.getElementById('stoet-btn').addEventListener('click', () => {
  if (stoetWatchId !== null) {
    stopStoet();
    return;
  }
  if (!navigator.geolocation) {
    setStoetStatus('Let op: GPS wordt niet ondersteund door deze browser.');
    return;
  }
  stoetDay = currentDay;
  setStoetStatus('GPS zoeken…');
  stoetKeepAwake(true);
  stoetWatchId = navigator.geolocation.watchPosition(
    async (position) => {
      // Hooguit elke 10 seconden versturen — vaker heeft geen zin.
      if (Date.now() - stoetLastSent < 10000) return;
      stoetLastSent = Date.now();
      const res = await fetch(api(`/admin/stoet/${stoetDay}`), {
        method: 'PUT',
        headers: adminHeaders(true),
        body: JSON.stringify({ lat: position.coords.latitude, lng: position.coords.longitude }),
      }).catch(() => null);
      setStoetStatus(
        res && res.ok
          ? `Stoetpositie wordt gedeeld (dag ${stoetDay}). Houd het scherm aan en de pagina open — bij een vergrendeld scherm stopt de GPS.`
          : 'Let op: positie versturen mislukt, opnieuw aan het proberen…'
      );
    },
    (err) => {
      setStoetStatus(
        err.code === 1
          ? 'Let op: geen toestemming voor locatie. Sta locatietoegang toe in je browser.'
          : 'Let op: GPS-fout, opnieuw aan het proberen…'
      );
      if (err.code === 1) stopStoet();
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 }
  );
  updateStoetBtn();
});

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
      await fetch(api(`/admin/teams/${t.id}`), { method: 'DELETE', headers: adminHeaders() });
      teams = teams.filter((x) => x.id !== t.id);
      for (let day = 1; day <= 4; day++) {
        days[day].crossings.forEach((c) => {
          c.teams = crossingTeams(c).filter((id) => id !== t.id);
          c.team = c.teams[0] ?? null;
        });
      }
      renderTeams();
      refreshVrLayer();
    });
    controls.appendChild(delBtn);
    li.appendChild(controls);
    list.appendChild(li);
  }
}

// --- Mededeling voor bezoekers en verkeersregelaars ---
let announcementText = '';

function initAnnouncement() {
  document.getElementById('announce-text').value = announcementText || '';
}

document.getElementById('announce-save').addEventListener('click', async () => {
  const text = document.getElementById('announce-text').value.trim();
  const res = await fetch(api('/admin/announcement'), {
    method: 'PUT',
    headers: adminHeaders(true),
    body: JSON.stringify({ text }),
  });
  if (res.ok) {
    announcementText = text;
    setSaveStatus(text ? 'Mededeling staat op de site.' : 'Mededeling weggehaald.');
  } else {
    const err = await res.json().catch(() => ({}));
    setSaveStatus('Let op: ' + (err.error || 'mededeling opslaan mislukt.'));
  }
});

// --- QR-codes (bezoekers- en verkeerspagina) ---
function renderQrCodes() {
  if (typeof qrcode !== 'function') return; // bibliotheek niet geladen
  const targets = [
    ['qr-home', location.origin + eventUrl(''), `a4d-${SLUG}-bezoekers.png`],
    ['qr-verkeer', location.origin + eventUrl('/verkeer'), `a4d-${SLUG}-verkeersregelaars.png`],
  ];
  for (const [id, url, filename] of targets) {
    const el = document.getElementById(id);
    if (!el || el.childNodes.length > 0) continue;
    const qr = qrcode(0, 'M');
    qr.addData(url);
    qr.make();
    el.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 2, scalable: true });
    const link = document.createElement('span');
    link.className = 'route-meta';
    link.textContent = url.replace(/^https?:\/\//, '');
    el.appendChild(link);
    const btn = menuButton('Download PNG', () => downloadQrPng(el.querySelector('svg'), filename));
    btn.className = 'qr-download';
    el.appendChild(btn);
  }
}

// SVG-QR omzetten naar een drukklare PNG (1024×1024, witte achtergrond).
function downloadQrPng(svgEl, filename) {
  if (!svgEl) return;
  const SIZE = 1024;
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('width', SIZE);
  clone.setAttribute('height', SIZE);
  const blobUrl = URL.createObjectURL(
    new Blob([new XMLSerializer().serializeToString(clone)], { type: 'image/svg+xml' })
  );
  const img = new Image();
  img.onload = () => {
    const canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, SIZE, SIZE);
    ctx.drawImage(img, 0, 0, SIZE, SIZE);
    URL.revokeObjectURL(blobUrl);
    const a = document.createElement('a');
    a.href = canvas.toDataURL('image/png');
    a.download = filename;
    a.click();
  };
  img.onerror = () => {
    URL.revokeObjectURL(blobUrl);
    setSaveStatus('Let op: PNG maken mislukt in deze browser.');
  };
  img.src = blobUrl;
}

// --- Beheerwachtwoord wijzigen ---
document.getElementById('change-password-btn').addEventListener('click', async () => {
  const input = document.getElementById('new-admin-password');
  const newPwd = input.value;
  if (newPwd.length < 6) {
    setSaveStatus('Let op: kies een wachtwoord van minstens 6 tekens.');
    return;
  }
  const res = await fetch(api('/admin/password'), {
    method: 'PUT',
    headers: adminHeaders(true),
    body: JSON.stringify({ password: newPwd }),
  });
  if (res.ok) {
    // Voortaan met het nieuwe wachtwoord werken; sessie blijft geldig.
    password = newPwd;
    sessionStorage.setItem(PWD_KEY, newPwd);
    input.value = '';
    setSaveStatus('Beheerwachtwoord gewijzigd.');
  } else {
    const err = await res.json().catch(() => ({}));
    setSaveStatus('Let op: ' + (err.error || 'wachtwoord wijzigen mislukt.'));
  }
});

document.getElementById('add-team-btn').addEventListener('click', async () => {
  const input = document.getElementById('team-name');
  const name = input.value.trim();
  if (!name) return setVrStatus('Geef het team eerst een naam.');
  const res = await fetch(api('/admin/teams'), {
    method: 'POST',
    headers: adminHeaders(true),
    body: JSON.stringify({ name }),
  });
  if (res.ok) {
    teams.push(await res.json());
    input.value = '';
    renderTeams();
    setVrStatus('Team toegevoegd — wijs het via de ruitjes aan oversteekpunten toe.');
  } else {
    const err = await res.json().catch(() => ({}));
    setVrStatus('Let op: ' + (err.error || 'team aanmaken mislukt.'));
  }
});


updateDayLabels();
init();
