// Verkeersregelaarspagina (/verkeer): kies je team, zie je posten en je
// tijdschema, volg jezelf met GPS en navigeer naar een post via Google Maps.
// Geen wachtwoord nodig. Kaart via OpenStreetMap/Leaflet; Street View en
// navigatie via Google.
const NL_CENTER = { lat: 52.2, lng: 5.3 };

let map;
let selectedDay = 1;
let selectedTeam = 'all';
let startFinish = null;
let eventSchedule = null; // per dag {date, time}
let vrSettings = { walkKmh: 4, passMin: 8 };
let teams = [];
const walkRoutes = {}; // day -> { line, arrows, bounds, path, crossings, pause }
let vrLayers = [];
let lastSortedCrossings = [];

if (window.innerWidth > 720) document.getElementById('info-details').open = true;

async function init() {
  const res = await fetch(api('/config'));
  const config = await res.json();
  document.getElementById('back-link').href = `/${SLUG}`;
  const brandSub = document.getElementById('brand-sub');
  if (brandSub && config.orgName) brandSub.textContent = 'Avond4Daagse · ' + config.orgName;
  setStreetViewKey(config.googleMapsApiKey || '');
  startFinish = config.startFinish;
  eventSchedule = config.schedule || null;
  if (config.vrSettings) vrSettings = { ...vrSettings, ...config.vrSettings };
  // Standaard de eerstvolgende loopdag tonen.
  selectedDay = Number(config.defaultDay || 1);
  document.querySelectorAll('.day-tab').forEach((tab) => {
    tab.classList.toggle('active', Number(tab.dataset.day) === selectedDay);
  });

  map = createMap('map', startFinish || NL_CENTER, startFinish ? 15 : 8);

  if (startFinish) {
    L.marker([startFinish.lat, startFinish.lng], {
      icon: flagIcon(),
      zIndexOffset: 900,
      title: 'Start & finish',
    }).addTo(map);
  }

  await loadData();
  refreshView();
}

async function loadData() {
  try {
    const [routesRes, teamsRes] = await Promise.all([fetch(api('/routes')), fetch(api('/teams'))]);
    if (routesRes.ok) {
      for (const row of await routesRes.json()) {
        const path = (row.path && row.path.length > 1 ? row.path : row.waypoints) || [];
        if (path.length < 2) continue;
        walkRoutes[row.day] = {
          line: L.polyline(path.map((p) => [p.lat, p.lng]), {
            color: DAY_COLORS[row.day],
            weight: 5,
            opacity: 0.85,
          }),
          arrows: directionArrows(path, DAY_COLORS[row.day]),
          bounds: boundsOf(path),
          path,
          crossings: (row.crossings || []).filter((c) => !c.hidden),
          pause: row.pause || null,
        };
      }
    }
    if (teamsRes.ok) teams = await teamsRes.json();
  } catch {
    document.getElementById('vr-warning').textContent = 'Let op: gegevens laden mislukt.';
  }

  const select = document.getElementById('vr-team');
  for (const t of teams) {
    const opt = document.createElement('option');
    opt.value = t.id;
    opt.textContent = t.name;
    select.appendChild(opt);
  }
}

function teamById(id) {
  return teams.find((t) => t.id === id) || null;
}

document.querySelectorAll('.day-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelector('.day-tab.active').classList.remove('active');
    tab.classList.add('active');
    selectedDay = Number(tab.dataset.day);
    refreshView();
  });
});

document.getElementById('vr-team').addEventListener('change', (e) => {
  selectedTeam = e.target.value;
  refreshView();
});

function refreshView() {
  vrLayers.forEach((l) => l.remove());
  vrLayers = [];
  for (let day = 1; day <= 4; day++) {
    if (!walkRoutes[day]) continue;
    if (day === selectedDay) {
      walkRoutes[day].line.addTo(map);
      walkRoutes[day].arrows.addTo(map);
    } else {
      walkRoutes[day].line.remove();
      walkRoutes[day].arrows.remove();
    }
  }
  const warningEl = document.getElementById('vr-warning');
  warningEl.textContent = '';

  const route = walkRoutes[selectedDay];
  if (!route) {
    warningEl.textContent = 'Er is nog geen route voor deze dag.';
    renderSchedule(null);
    return;
  }
  map.fitBounds(route.bounds.pad(0.07));
  if (route.crossings.length === 0) {
    warningEl.textContent = 'Er zijn nog geen oversteekpunten gepubliceerd voor deze dag.';
  }
  if (route.pause) {
    vrLayers.push(
      L.marker([route.pause.lat, route.pause.lng], {
        icon: pauseIcon(),
        zIndexOffset: 800,
        title: `Pauzepunt dag ${selectedDay}`,
      }).addTo(map)
    );
  }

  const teamFilter = selectedTeam === 'all' ? null : Number(selectedTeam);

  // Nummering volgt de looprichting: sorteren op afstand langs de route.
  const order = new Map();
  route.crossings.forEach((c) => order.set(c, nearestOnPath(route.path, c).along));
  lastSortedCrossings = [...route.crossings].sort((a, b) => order.get(a) - order.get(b));

  let index = 0;
  for (const c of lastSortedCrossings) {
    index++;
    const assigned = crossingTeams(c).map(teamById).filter(Boolean);
    const isMine = teamFilter === null || crossingTeams(c).includes(teamFilter);
    const marker = L.marker([c.lat, c.lng], {
      icon: diamondIcon(crossingColor(assigned), index, !isMine),
      zIndexOffset: 500,
      title: c.name,
    }).addTo(map);
    const nr = index;
    marker.on('click', () => openCrossingInfo(c, assigned, nr));
    vrLayers.push(marker);
  }

  renderSchedule(teamFilter);
}

// Navigatielink: opent Google Maps met fietsroute naar de post.
function googleMapsLink(c) {
  return `https://www.google.com/maps/dir/?api=1&destination=${c.lat},${c.lng}&travelmode=bicycling`;
}

function openCrossingInfo(c, assigned, nr) {
  const div = document.createElement('div');
  div.className = 'point-menu';
  const title = document.createElement('strong');
  title.textContent = `Post ${nr}: ${c.name}`;
  div.appendChild(title);
  const teamLine = document.createElement('span');
  teamLine.textContent =
    assigned.length > 0
      ? `Team${assigned.length > 1 ? 's' : ''}: ${assigned.map((t) => t.name).join(' + ')}`
      : 'Nog geen team toegewezen';
  div.appendChild(teamLine);
  div.appendChild(
    menuButton('Bekijk in Street View', () => {
      map.closePopup();
      openStreetView(c.lat, c.lng);
    })
  );
  const nav = document.createElement('a');
  nav.href = googleMapsLink(c);
  nav.target = '_blank';
  nav.rel = 'noopener';
  nav.className = 'nav-link';
  nav.textContent = 'Navigeer hierheen (Google Maps)';
  div.appendChild(nav);
  openMapMenu(map, [c.lat, c.lng], div);
}

// Posten van een team, in routevolgorde.
function teamPosts(teamId) {
  return lastSortedCrossings.filter((c) => crossingTeams(c).includes(teamId));
}

// Tijdschema voor het gekozen team: wanneer komt de stoet, wanneer mag je
// weg — berekend uit de positie van de post langs de route.
function renderSchedule(teamFilter) {
  const list = document.getElementById('vr-schedule');
  list.innerHTML = '';
  if (teamFilter === null) {
    list.innerHTML = '<li class="hint">Kies je team voor het tijdschema.</li>';
    return;
  }
  const route = walkRoutes[selectedDay];
  const posts = route ? teamPosts(teamFilter) : [];
  if (posts.length === 0) {
    list.innerHTML = '<li class="hint">Nog geen posten voor jouw team op deze dag.</li>';
    return;
  }
  posts.forEach((c, i) => {
    const along = nearestOnPath(route.path, c).along;
    const head = (along / 1000 / vrSettings.walkKmh) * 60;
    const leave = head + vrSettings.passMin;
    const li = document.createElement('li');
    li.innerHTML = `<span><strong>Post ${i + 1}:</strong> ${c.name}<br>
      <span class="route-meta">stoet komt aan: ${fmtMoment(head)} · hele stoet voorbij (vertrek kan): ${fmtMoment(leave)}</span></span>`;
    const nav = document.createElement('a');
    nav.href = googleMapsLink(c);
    nav.target = '_blank';
    nav.rel = 'noopener';
    nav.className = 'nav-link';
    nav.textContent = 'Navigeer (Google Maps)';
    li.appendChild(nav);
    list.appendChild(li);
  });
}

// Tijdstip als kloktijd (als de starttijd van de dag bekend is), anders in
// minuten na de start.
function fmtMoment(min) {
  const e = eventSchedule && eventSchedule[selectedDay];
  if (e && e.time) {
    const [h, m] = e.time.split(':').map(Number);
    const total = h * 60 + m + Math.round(min);
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  return `+${Math.round(min)} min`;
}

setupGps(() => map);
init();
