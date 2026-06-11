// Verkeersregelaarspagina (/verkeer): kies je team, zie je posten, je
// fietsroute en je tijdschema, en volg jezelf met GPS. Geen wachtwoord nodig.
// Kaart en routes via OpenStreetMap/Leaflet; Street View via Google (overlay).
const ALMERE_CENTER = { lat: 52.3508, lng: 5.2647 };

let map;
let selectedDay = 1;
let selectedTeam = 'all';
let startFinish = null;
let eventSchedule = null; // per dag {date, time}
let teams = [];
let teamRoutes = {}; // `${teamId}_${day}` -> { path, conflicts, timing }
const walkRoutes = {}; // day -> { line, bounds, crossings }
let vrLayers = [];
let lastSortedCrossings = [];

// Navigatie: fietsroute van je GPS-positie naar je post, om de stoet heen.
let navTarget = null;
let navLayers = [];
let lastNavAt = 0;
let lastNavPos = null;

if (window.innerWidth > 720) document.getElementById('info-details').open = true;

async function init() {
  const res = await fetch('/api/config');
  const config = await res.json();
  setStreetViewKey(config.googleMapsApiKey || '');
  startFinish = config.startFinish;
  eventSchedule = config.schedule || null;
  // Standaard de eerstvolgende loopdag tonen.
  selectedDay = Number(config.defaultDay || 1);
  document.querySelectorAll('.day-tab').forEach((tab) => {
    tab.classList.toggle('active', Number(tab.dataset.day) === selectedDay);
  });

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
          arrows: directionArrows(path, DAY_COLORS[row.day]),
          bounds: boundsOf(path),
          path,
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
  stopNav();
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
  const sortedCrossings = [...route.crossings].sort((a, b) => order.get(a) - order.get(b));
  lastSortedCrossings = sortedCrossings;

  let index = 0;
  for (const c of sortedCrossings) {
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
      const text = conflict.approved
        ? `Let op (${t.name}): hier steek je de wandelroute over — stap af en kijk uit!`
        : `Conflict: route van ${t.name} kruist de wandelroute`;
      vrLayers.push(
        L.marker([conflict.lat, conflict.lng], {
          icon: conflictIcon(!!conflict.approved),
          zIndexOffset: 1100,
          title: text,
        })
          .bindPopup(`<div class="point-menu"><strong>${text}</strong></div>`)
          .addTo(map)
      );
    }
    if (tr.timing && tr.timing.feasible === false) {
      warnings.push(`Planning van ${t.name} is te krap — overleg met de organisatie.`);
    }
  }
  warningEl.textContent = warnings.join(' ');
  renderSchedule(teamFilter);
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
  const posts = teamPosts(teamFilter);
  tr.timing.schedule.forEach((post, i) => {
    const li = document.createElement('li');
    const arrive =
      post.arriveMin != null ? ` · jullie aankomst: ${fmtMoment(post.arriveMin)}` : '';
    li.innerHTML = `<span><strong>Post ${i + 1}:</strong> ${post.name}<br>
      <span class="route-meta">stoet komt aan: ${fmtMoment(post.headMin)} · hele stoet voorbij (vertrek kan): ${fmtMoment(post.leaveMin)}${arrive}</span></span>`;
    const crossing = posts[i];
    if (crossing) {
      const navBtn = document.createElement('button');
      navBtn.textContent = navTarget === crossing ? 'Stop route' : 'Fiets hierheen';
      navBtn.addEventListener('click', () => {
        if (navTarget === crossing) {
          stopNav();
        } else {
          navTarget = crossing;
          const pos = gps.getPosition();
          if (pos) computeNav(pos);
          else setNavStatus('Start eerst de GPS, dan verschijnt de fietsroute naar deze post.');
        }
        renderSchedule(teamFilter);
      });
      li.appendChild(navBtn);
    }
    list.appendChild(li);
  });
}

// Posten van een team, in routevolgorde (zelfde volgorde als het tijdschema).
function teamPosts(teamId) {
  return lastSortedCrossings.filter((c) => crossingTeams(c).includes(teamId));
}

function setNavStatus(text) {
  document.getElementById('nav-status').textContent = text;
}

function clearNavLayers() {
  navLayers.forEach((l) => l.remove());
  navLayers = [];
}

function stopNav() {
  navTarget = null;
  clearNavLayers();
  setNavStatus('');
}

// Fietsroute berekenen: de server kiest een route om de stoet heen (ook als
// die langer is); lukt dat niet, dan met waarschuwing waar je de stoet kruist.
async function computeNav(pos) {
  if (!navTarget) return;
  lastNavAt = Date.now();
  lastNavPos = pos;
  setNavStatus('Fietsroute berekenen…');
  try {
    const res = await fetch('/api/navigate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        day: selectedDay,
        from: pos,
        to: { lat: navTarget.lat, lng: navTarget.lng },
      }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      setNavStatus('Let op: ' + (err.error || 'fietsroute berekenen mislukt.'));
      return;
    }
    const r = await res.json();
    clearNavLayers();
    navLayers.push(
      L.polyline(r.path.map((p) => [p.lat, p.lng]), {
        color: '#111827',
        weight: 4,
        dashArray: '8 8',
        opacity: 0.9,
      }).addTo(map)
    );
    for (const cf of r.conflicts || []) {
      navLayers.push(
        L.marker([cf.lat, cf.lng], {
          icon: conflictIcon(false),
          zIndexOffset: 1150,
          title: 'Hier kruis je de stoet — stap af en kijk uit',
        })
          .bindPopup('<div class="point-menu"><strong>Hier kruis je de stoet — stap af en kijk uit!</strong></div>')
          .addTo(map)
      );
    }
    const min = Math.max(1, Math.round(r.duration_s / 60));
    const km = (r.distance_m / 1000).toFixed(1).replace('.', ',');
    setNavStatus(
      r.clean
        ? `Fietsroute naar je post: ${min} min (${km} km), om de stoet heen.`
        : `Let op: er is geen route die de stoet vermijdt — kruis op de gemarkeerde plek met beleid (stap af) of wacht tot de stoet voorbij is. ${min} min (${km} km).`
    );
  } catch {
    setNavStatus('Let op: fietsroute berekenen mislukt — probeer het opnieuw.');
  }
}

// Tijdens het fietsen de route bijwerken (hooguit elke 20 s en pas na 40 m).
function onGpsFix(pos) {
  if (!navTarget && selectedTeam !== 'all') {
    const posts = teamPosts(Number(selectedTeam));
    if (posts.length > 0) {
      navTarget = pickNextPost(posts);
      renderSchedule(Number(selectedTeam));
      computeNav(pos);
      return;
    }
  }
  if (!navTarget) return;
  if (Date.now() - lastNavAt < 20000) return;
  if (lastNavPos && distM(lastNavPos, pos) < 40) return;
  computeNav(pos);
}

// Eerstvolgende post op basis van de klok (als de starttijd bekend is),
// anders gewoon de eerste post.
function pickNextPost(posts) {
  const e = eventSchedule && eventSchedule[selectedDay];
  const tr = teamRoutes[`${selectedTeam}_${selectedDay}`];
  const sched = tr && tr.timing && tr.timing.schedule;
  if (e && e.time && sched) {
    const [h, m] = e.time.split(':').map(Number);
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    for (let i = 0; i < posts.length && i < sched.length; i++) {
      if (h * 60 + m + sched[i].headMin > nowMin) return posts[i];
    }
    return posts[posts.length - 1];
  }
  return posts[0];
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
  return `+${min} min`;
}

const gps = setupGps(() => map, onGpsFix);
init();
