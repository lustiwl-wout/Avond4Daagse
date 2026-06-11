// Printversie van het verkeersregelaarsplan voor één dag (OpenStreetMap-
// kaartjes via Leaflet; alleen de Street View-foto's komen van Google):
// pagina 1 = totaalplan, daarna per team een deel met hun posten en per
// post het adres, een kaartje en Street View-foto's vanuit vier windrichtingen.
const params = new URLSearchParams(location.search);
const day = Math.min(4, Math.max(1, Number(params.get('day')) || 1));

let svStaticKey = '';
let orgName = '';
let eventSchedule = null; // per dag {date, time}
let vrSettings = { walkKmh: 4, passMin: 8 };
let startFinish = null;
let teams = [];
let row = null;
let posts = [];

const content = document.getElementById('content');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = (n) => Math.round(n * 10) / 10;

const headMin = (alongM) => (alongM / 1000 / vrSettings.walkKmh) * 60;
const leaveMin = (alongM) => headMin(alongM) + vrSettings.passMin;

// Tijdstip als kloktijd (als de starttijd van de dag bekend is), anders in
// minuten na de start.
function fmtMoment(min) {
  const e = eventSchedule && eventSchedule[day];
  if (e && e.time) {
    const [h, m] = e.time.split(':').map(Number);
    const total = h * 60 + m + Math.round(min);
    return `${String(Math.floor(total / 60) % 24).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`;
  }
  return `+${min} min`;
}

async function init() {
  const [cfgRes, routesRes, teamsRes] = await Promise.all([
    fetch('/api/config'),
    fetch('/api/routes'),
    fetch('/api/teams'),
  ]);
  const config = await cfgRes.json();
  svStaticKey = config.googleMapsApiKey || '';
  orgName = config.orgName || '';
  startFinish = config.startFinish;
  eventSchedule = config.schedule || null;
  if (config.vrSettings) vrSettings = { ...vrSettings, ...config.vrSettings };
  if (teamsRes.ok) teams = await teamsRes.json();
  const rows = routesRes.ok ? await routesRes.json() : [];
  row = rows.find((r) => r.day === day);
  if (!row || !row.path) {
    content.innerHTML = `<div class="page"><h1>Dag ${day}</h1><p>Er is nog geen route voor deze dag.</p></div>`;
    return;
  }
  posts = (row.crossings || [])
    .filter((c) => !c.hidden)
    .map((c) => ({ ...c, along: nearestOnPath(row.path, c).along }))
    .sort((a, b) => a.along - b.along)
    .map((p, i) => ({ ...p, nr: i + 1, headMin: r1(headMin(p.along)), leaveMin: r1(leaveMin(p.along)) }));

  render();
  initMaps();
  fillAddresses();
}

function streetViewUrl(p, heading) {
  return `https://maps.googleapis.com/maps/api/streetview?size=300x200&location=${p.lat},${p.lng}&heading=${heading}&fov=90&key=${svStaticKey}`;
}

function render() {
  let html = `<div class="page">
    <h1>Verkeersregelaarsplan — Dag ${day}</h1>
    <p class="sub">Avond4Daagse ${esc(orgName)} · wandeltempo ${vrSettings.walkKmh} km/u ·
      passeertijd stoet ${vrSettings.passMin} min</p>
    <div class="pmap pmap-lg" id="map-overview"></div>
    <table>
      <tr><th>Post</th><th>Plek</th><th>Stoet komt aan</th><th>Stoet voorbij (vertrek kan)</th><th>Team</th></tr>
      ${posts
        .map((p) => {
          const assigned = crossingTeams(p)
            .map((id) => teams.find((x) => x.id === id))
            .filter(Boolean);
          const team =
            assigned.length > 0
              ? assigned
                  .map((t) => `<span class="dot" style="background:${t.color}"></span>${esc(t.name)}`)
                  .join(' + ')
              : '<span class="warn">NOG NIET TOEGEWEZEN</span>';
          return `<tr><td>${p.nr}</td><td>${esc(p.name)}</td><td>${fmtMoment(p.headMin)}</td><td>${fmtMoment(p.leaveMin)}</td><td>${team}</td></tr>`;
        })
        .join('')}
    </table>
    <p class="sub">Kaartgegevens © OpenStreetMap-bijdragers · foto's © Google Street View</p>
  </div>`;

  for (const team of teams) {
    const teamPosts = posts.filter((p) => crossingTeams(p).includes(team.id));
    if (teamPosts.length === 0) continue;

    html += `<div class="page">
      <h2><span class="dot" style="background:${team.color}"></span>${esc(team.name)} — Dag ${day} (per fiets)</h2>
      <p class="sub">Grijze lijn = wandelroute. Vertrek bij een post pas als de héle stoet voorbij is;
        navigeren naar een post doe je via Google Maps op de verkeerspagina.</p>
      <div class="pmap pmap-team" id="map-team-${team.id}"></div>
      ${teamPosts
        .map((p) => {
          return `<div class="post">
            <h3>Post ${p.nr} — ${esc(p.name)}</h3>
            <p class="addr" data-post="${p.nr}">Adres wordt opgezocht…</p>
            <p class="times">Stoet komt aan: ${fmtMoment(p.headMin)} · hele stoet voorbij (vertrek kan): ${fmtMoment(p.leaveMin)}</p>
            <div class="post-media">
              <figure>
                <div class="pmap pmap-sm" id="map-post-${team.id}-${p.nr}"></div>
                <figcaption>Kaart</figcaption>
              </figure>
              ${[[0, 'noorden'], [90, 'oosten'], [180, 'zuiden'], [270, 'westen']]
                .map(
                  ([h, label]) => `<figure>
                    <img width="300" height="200" alt="Street View ${label}" src="${streetViewUrl(p, h)}" />
                    <figcaption>Street View — kijkend naar het ${label}</figcaption>
                  </figure>`
                )
                .join('')}
            </div>
          </div>`;
        })
        .join('')}
    </div>`;
  }

  const unassigned = posts.filter((p) => crossingTeams(p).length === 0);
  if (unassigned.length > 0) {
    html += `<div class="page">
      <h2 class="warn">Nog niet toegewezen posten</h2>
      <table><tr><th>Post</th><th>Plek</th><th>Stoet komt aan</th></tr>
      ${unassigned.map((p) => `<tr><td>${p.nr}</td><td>${esc(p.name)}</td><td>${fmtMoment(p.headMin)}</td></tr>`).join('')}
      </table>
    </div>`;
  }

  content.innerHTML = html;
}

function miniMap(id) {
  const map = L.map(id, {
    zoomControl: false,
    dragging: false,
    scrollWheelZoom: false,
    doubleClickZoom: false,
    boxZoom: false,
    keyboard: false,
    touchZoom: false,
    attributionControl: false,
  });
  L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19 }).addTo(map);
  return map;
}

function addFlag(map) {
  if (startFinish) {
    L.marker([startFinish.lat, startFinish.lng], { icon: flagIcon(), interactive: false }).addTo(map);
  }
}

function initMaps() {
  const walkLatLngs = row.path.map((p) => [p.lat, p.lng]);

  // Overzichtskaart met alle posten.
  const ov = miniMap('map-overview');
  L.polyline(walkLatLngs, { color: '#1d4ed8', weight: 4 }).addTo(ov);
  directionArrows(row.path, '#1d4ed8').addTo(ov);
  addFlag(ov);
  if (row.pause) {
    L.marker([row.pause.lat, row.pause.lng], { icon: pauseIcon(), interactive: false }).addTo(ov);
  }
  for (const p of posts) {
    const assigned = crossingTeams(p)
      .map((id) => teams.find((x) => x.id === id))
      .filter(Boolean);
    L.marker([p.lat, p.lng], {
      icon: dotIcon(crossingColor(assigned), p.nr <= 99 ? String(p.nr) : ''),
      interactive: false,
    }).addTo(ov);
  }
  ov.fitBounds(boundsOf(row.path).pad(0.05));

  // Per team: wandelroute + eigen posten.
  for (const team of teams) {
    const teamPosts = posts.filter((p) => crossingTeams(p).includes(team.id));
    if (teamPosts.length === 0) continue;
    const tm = miniMap(`map-team-${team.id}`);
    L.polyline(walkLatLngs, { color: '#9ca3af', weight: 3 }).addTo(tm);
    directionArrows(row.path, '#9ca3af').addTo(tm);
    addFlag(tm);
    for (const p of teamPosts) {
      L.marker([p.lat, p.lng], { icon: dotIcon(team.color, String(p.nr)), interactive: false }).addTo(tm);
    }
    tm.fitBounds(boundsOf(row.path).pad(0.05));

    // Detailkaartje per post.
    for (const p of teamPosts) {
      const pm = miniMap(`map-post-${team.id}-${p.nr}`);
      L.polyline(walkLatLngs, { color: '#1d4ed8', weight: 4 }).addTo(pm);
      directionArrows(row.path, '#1d4ed8', 100).addTo(pm);
      L.marker([p.lat, p.lng], { icon: dotIcon(team.color, String(p.nr)), interactive: false }).addTo(pm);
      pm.setView([p.lat, p.lng], 17);
    }
  }
}

// Adres per post via de server (Nominatim, met cache en nette throttling).
async function fillAddresses() {
  for (const p of posts) {
    const targets = document.querySelectorAll(`[data-post="${p.nr}"]`);
    if (targets.length === 0) continue;
    try {
      const res = await fetch(`/api/address?lat=${p.lat}&lng=${p.lng}`);
      if (!res.ok) throw new Error();
      const data = await res.json();
      targets.forEach((el) => (el.textContent = data.address));
    } catch {
      targets.forEach((el) => (el.textContent = 'Adres kon niet worden opgezocht'));
    }
  }
}

init();
