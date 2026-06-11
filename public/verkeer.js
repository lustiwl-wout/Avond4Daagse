// Verkeersregelaarspagina (/verkeer): kies je team, zie je posten, je
// fietsroute en je tijdschema, en volg jezelf met GPS. Geen wachtwoord nodig.
// Kaart en routes via OpenStreetMap/Leaflet; Street View via Google (overlay).
const ALMERE_CENTER = { lat: 52.3508, lng: 5.2647 };

let map;
let selectedDay = 1;
let selectedTeam = 'all';
let startFinish = null;
let teams = [];
let teamRoutes = {}; // `${teamId}_${day}` -> { path, conflicts, timing }
const walkRoutes = {}; // day -> { line, bounds, crossings }
let vrLayers = [];

if (window.innerWidth > 720) document.getElementById('info-details').open = true;

async function init() {
  const res = await fetch('/api/config');
  const config = await res.json();
  setStreetViewKey(config.googleMapsApiKey || '');
  startFinish = config.startFinish;

  map = createMap('map', startFinish || ALMERE_CENTER, startFinish ? 15 : 13);

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
    const [routesRes, teamsRes, trRes] = await Promise.all([
      fetch('/api/routes'),
      fetch('/api/teams'),
      fetch('/api/team-routes'),
    ]);
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
          bounds: boundsOf(path),
          crossings: (row.crossings || []).filter((c) => !c.hidden),
          pause: row.pause || null,
        };
      }
    }
    if (teamsRes.ok) teams = await teamsRes.json();
    if (trRes.ok) {
      for (const row of await trRes.json()) {
        teamRoutes[`${row.team_id}_${row.day}`] = row;
      }
    }
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
    if (day === selectedDay) walkRoutes[day].line.addTo(map);
    else walkRoutes[day].line.remove();
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

  let index = 0;
  for (const c of route.crossings) {
    index++;
    const team = c.team != null ? teamById(c.team) : null;
    const isMine = teamFilter === null || c.team === teamFilter;
    const marker = L.marker([c.lat, c.lng], {
      icon: diamondIcon(team ? team.color : '#f59e0b', index, !isMine),
      zIndexOffset: 500,
      title: c.name,
    }).addTo(map);
    const nr = index;
    marker.on('click', () => openCrossingInfo(c, team, nr));
    vrLayers.push(marker);
  }

  const warnings = [];
  for (const t of teams) {
    if (teamFilter !== null && t.id !== teamFilter) continue;
    const tr = teamRoutes[`${t.id}_${selectedDay}`];
    if (!tr || !tr.path) continue;
    vrLayers.push(dashedLine(tr.path, t.color).addTo(map));

    const open = (tr.conflicts || []).filter((c) => !c.approved);
    if (open.length > 0) {
      warnings.push(`Route van ${t.name} doorkruist de wandelroute op ${open.length} plek(ken)!`);
    }
    for (const conflict of tr.conflicts || []) {
      vrLayers.push(
        L.marker([conflict.lat, conflict.lng], {
          icon: conflictIcon(!!conflict.approved),
          zIndexOffset: 1100,
          title: conflict.approved
            ? `Let op (${t.name}): hier steek je de wandelroute over — stap af en kijk uit!`
            : `Conflict: route van ${t.name} kruist de wandelroute`,
        }).addTo(map)
      );
    }
    if (tr.timing && tr.timing.feasible === false) {
      warnings.push(`Planning van ${t.name} is te krap — overleg met de organisatie.`);
    }
  }
  warningEl.textContent = warnings.join(' ');
  renderSchedule(teamFilter);
}

function openCrossingInfo(c, team, nr) {
  const div = document.createElement('div');
  div.className = 'point-menu';
  const title = document.createElement('strong');
  title.textContent = `Post ${nr}: ${c.name}`;
  div.appendChild(title);
  const teamLine = document.createElement('span');
  teamLine.textContent = team ? `Team: ${team.name}` : 'Nog geen team toegewezen';
  div.appendChild(teamLine);
  div.appendChild(
    menuButton('Bekijk in Street View', () => {
      map.closePopup();
      openStreetView(c.lat, c.lng);
    })
  );
  openMapMenu(map, [c.lat, c.lng], div);
}

// Tijdschema voor het gekozen team: wanneer komt de groep, wanneer mag je weg.
function renderSchedule(teamFilter) {
  const list = document.getElementById('vr-schedule');
  list.innerHTML = '';
  if (teamFilter === null) {
    list.innerHTML = '<li class="hint">Kies je team voor het tijdschema.</li>';
    return;
  }
  const tr = teamRoutes[`${teamFilter}_${selectedDay}`];
  if (!tr || !tr.timing || !tr.timing.schedule) {
    list.innerHTML = '<li class="hint">Nog geen planning voor deze dag.</li>';
    return;
  }
  tr.timing.schedule.forEach((post, i) => {
    const li = document.createElement('li');
    const arrive = post.arriveMin != null ? ` · jij er: +${post.arriveMin} min` : '';
    li.innerHTML = `<span><strong>Post ${i + 1}:</strong> ${post.name}<br>
      <span class="route-meta">groep: +${post.headMin} min · weg mogen: +${post.leaveMin} min${arrive}</span></span>`;
    list.appendChild(li);
  });
}

setupGps(() => map);
init();
