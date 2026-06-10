// Printversie van het verkeersregelaarsplan voor één dag:
// pagina 1 = totaalplan (alle posten + teams), daarna per team een deel met
// hun fietsroute, en per post het adres, een kaartje en Street View-foto's
// vanuit vier windrichtingen.
const params = new URLSearchParams(location.search);
const day = Math.min(4, Math.max(1, Number(params.get('day')) || 1));

let apiKey = '';
let vrSettings = { walkKmh: 4, passMin: 8, bikeKmh: 15, marginMin: 2 };
let startFinish = null;
let teams = [];
let teamRoutes = {}; // teamId -> rij voor deze dag
let row = null;
let posts = [];

const content = document.getElementById('content');
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const r1 = (n) => Math.round(n * 10) / 10;
const hex = (color) => color.replace('#', '0x');

function distM(a, b) {
  const R = 6371000;
  const rad = (d) => (d * Math.PI) / 180;
  const lat0 = rad((a.lat + b.lat) / 2);
  const x = (rad(b.lng) - rad(a.lng)) * Math.cos(lat0) * R;
  const y = (rad(b.lat) - rad(a.lat)) * R;
  return Math.hypot(x, y);
}

function alongPath(path, point) {
  let best = Infinity;
  let bestAlong = 0;
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
    }
    cum += segLen;
  }
  return bestAlong;
}

const headMin = (alongM) => (alongM / 1000 / vrSettings.walkKmh) * 60;
const leaveMin = (alongM) => headMin(alongM) + vrSettings.passMin;

async function init() {
  const [cfgRes, routesRes, teamsRes, trRes] = await Promise.all([
    fetch('/api/config'),
    fetch('/api/routes'),
    fetch('/api/teams'),
    fetch('/api/team-routes'),
  ]);
  const config = await cfgRes.json();
  apiKey = config.googleMapsApiKey;
  startFinish = config.startFinish;
  if (config.vrSettings) vrSettings = { ...vrSettings, ...config.vrSettings };
  if (teamsRes.ok) teams = await teamsRes.json();
  if (trRes.ok) {
    for (const r of await trRes.json()) {
      if (r.day === day) teamRoutes[r.team_id] = r;
    }
  }
  const rows = routesRes.ok ? await routesRes.json() : [];
  row = rows.find((r) => r.day === day);
  if (!row || !row.path) {
    content.innerHTML = `<div class="page"><h1>Dag ${day}</h1><p>Er is nog geen route voor deze dag.</p></div>`;
    return;
  }
  posts = (row.crossings || [])
    .filter((c) => !c.hidden)
    .map((c) => ({ ...c, along: alongPath(row.path, c) }))
    .sort((a, b) => a.along - b.along)
    .map((p, i) => ({ ...p, nr: i + 1, headMin: r1(headMin(p.along)), leaveMin: r1(leaveMin(p.along)) }));

  if (!apiKey) {
    content.innerHTML = '<div class="page"><p>Let op: Geen Google Maps API-key geconfigureerd.</p></div>';
    return;
  }
  // Maps JS API voor polyline-encoding (geometry) en reverse geocoding.
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${apiKey}&libraries=geometry&callback=buildDoc`;
  script.async = true;
  document.head.appendChild(script);
}

function encodePath(path, maxPoints = 90) {
  const step = Math.max(1, Math.ceil(path.length / maxPoints));
  const pts = path.filter((_, i) => i % step === 0);
  if (pts[pts.length - 1] !== path[path.length - 1]) pts.push(path[path.length - 1]);
  return encodeURIComponent(
    google.maps.geometry.encoding.encodePath(pts.map((p) => new google.maps.LatLng(p.lat, p.lng)))
  );
}

function staticMapUrl(parts, size = '640x400') {
  return `https://maps.googleapis.com/maps/api/staticmap?size=${size}&scale=2&${parts.join('&')}&key=${apiKey}`;
}

function streetViewUrl(p, heading) {
  return `https://maps.googleapis.com/maps/api/streetview?size=300x200&location=${p.lat},${p.lng}&heading=${heading}&fov=90&key=${apiKey}`;
}

function teamName(id) {
  const t = teams.find((x) => x.id === id);
  return t ? t.name : null;
}

window.buildDoc = function () {
  const walkEnc = encodePath(row.path);
  const flagMarker = startFinish
    ? `markers=${encodeURIComponent(`size:mid|color:0x0f172a|label:S|${startFinish.lat},${startFinish.lng}`)}`
    : '';

  // --- Pagina 1: totaalplan ---
  let html = `<div class="page">
    <h1>Verkeersregelaarsplan — Dag ${day}</h1>
    <p class="sub">Avond4Daagse Basisschool Syncope · wandeltempo ${vrSettings.walkKmh} km/u ·
      passeertijd groep ${vrSettings.passMin} min · tijden in minuten na vertrek bij start/finish</p>
    <img class="overview-map" alt="Overzichtskaart"
      src="${staticMapUrl([
        `path=${encodeURIComponent('color:0x1d4ed8ff|weight:4')}|enc:${walkEnc}`,
        flagMarker,
        ...posts.slice(0, 30).map((p) => {
          const t = teams.find((x) => x.id === p.team);
          const label = p.nr <= 9 ? `|label:${p.nr}` : '';
          return `markers=${encodeURIComponent(`size:mid|color:${hex(t ? t.color : '#f59e0b')}${label}`)}|${p.lat},${p.lng}`;
        }),
      ])}" />
    <table>
      <tr><th>Post</th><th>Plek</th><th>Groep er</th><th>Weg mogen</th><th>Team</th></tr>
      ${posts
        .map((p) => {
          const t = teams.find((x) => x.id === p.team);
          const team = t
            ? `<span class="dot" style="background:${t.color}"></span>${esc(t.name)}`
            : '<span class="warn">NOG NIET TOEGEWEZEN</span>';
          return `<tr><td>${p.nr}</td><td>${esc(p.name)}</td><td>+${p.headMin} min</td><td>+${p.leaveMin} min</td><td>${team}</td></tr>`;
        })
        .join('')}
    </table>
  </div>`;

  // --- Per team een eigen deel ---
  for (const team of teams) {
    const teamPosts = posts.filter((p) => p.team === team.id);
    if (teamPosts.length === 0) continue;
    const tr = teamRoutes[team.id];
    const schedule = (tr && tr.timing && tr.timing.schedule) || [];
    const approved = ((tr && tr.conflicts) || []).filter((c) => c.approved).length;
    const open = ((tr && tr.conflicts) || []).filter((c) => !c.approved).length;

    const mapParts = [
      `path=${encodeURIComponent('color:0x9ca3afcc|weight:3')}|enc:${walkEnc}`,
      flagMarker,
      ...teamPosts.map((p) => {
        const label = p.nr <= 9 ? `|label:${p.nr}` : '';
        return `markers=${encodeURIComponent(`size:mid|color:${hex(team.color)}${label}`)}|${p.lat},${p.lng}`;
      }),
    ];
    if (tr && tr.path) {
      mapParts.unshift(`path=${encodeURIComponent(`color:${hex(team.color)}ff|weight:4`)}|enc:${encodePath(tr.path)}`);
    }

    html += `<div class="page">
      <h2><span class="dot" style="background:${team.color}"></span>${esc(team.name)} — Dag ${day}</h2>
      <p class="sub">Grijze lijn = wandelroute · gekleurde lijn = jullie fietsroute start → posten → finish.
        Vertrek bij een post pas als de héle groep voorbij is.</p>
      ${open > 0 ? `<p class="warn">Let op: Deze route doorkruist de wandelroute op ${open} niet-goedgekeurde plek(ken) — overleg met de organisatie!</p>` : ''}
      ${approved > 0 ? `<p class="warn">Let op: Let op: jullie route steekt de wandelroute ${approved}× over (goedgekeurd). Stap daar af en kijk goed uit.</p>` : ''}
      <img class="team-map" alt="Teamkaart" src="${staticMapUrl(mapParts)}" />
      ${teamPosts
        .map((p, i) => {
          const sched = schedule[i] || {};
          const arrive = sched.arriveMin != null ? ` · jullie er: +${sched.arriveMin} min` : '';
          return `<div class="post">
            <h3>Post ${p.nr} — ${esc(p.name)}</h3>
            <p class="addr" data-post="${p.nr}">Adres wordt opgezocht…</p>
            <p class="times">Groep er: +${p.headMin} min · weg mogen: +${p.leaveMin} min${arrive}</p>
            <div class="post-media">
              <figure>
                <img width="300" height="200" alt="Kaart post ${p.nr}"
                  src="${staticMapUrl([
                    'zoom=17',
                    `markers=${encodeURIComponent(`size:mid|color:${hex(team.color)}`)}|${p.lat},${p.lng}`,
                  ], '300x200')}" />
                <figcaption>Kaart</figcaption>
              </figure>
              ${[
                [0, 'Noord'],
                [90, 'Oost'],
                [180, 'Zuid'],
                [270, 'West'],
              ]
                .map(
                  ([h, label]) => `<figure>
                    <img width="300" height="200" alt="Street View ${label}" src="${streetViewUrl(p, h)}" />
                    <figcaption>Street View — kijkend naar het ${label.toLowerCase()}en</figcaption>
                  </figure>`
                )
                .join('')}
            </div>
          </div>`;
        })
        .join('')}
    </div>`;
  }

  const unassigned = posts.filter((p) => p.team == null);
  if (unassigned.length > 0) {
    html += `<div class="page">
      <h2 class="warn">Let op: Nog niet toegewezen posten</h2>
      <table><tr><th>Post</th><th>Plek</th><th>Groep er</th></tr>
      ${unassigned.map((p) => `<tr><td>${p.nr}</td><td>${esc(p.name)}</td><td>+${p.headMin} min</td></tr>`).join('')}
      </table>
    </div>`;
  }

  content.innerHTML = html;
  fillAddresses();
};

// Adres per post via reverse geocoding (zelfde API-key, werkt in de browser).
async function fillAddresses() {
  const geocoder = new google.maps.Geocoder();
  for (const p of posts) {
    const targets = document.querySelectorAll(`[data-post="${p.nr}"]`);
    if (targets.length === 0) continue;
    try {
      const { results } = await geocoder.geocode({ location: { lat: p.lat, lng: p.lng } });
      const address = results[0] ? results[0].formatted_address.replace(', Nederland', '') : 'Adres onbekend';
      targets.forEach((el) => (el.textContent = `${address}`));
    } catch {
      targets.forEach((el) => (el.textContent = 'Adres kon niet worden opgezocht'));
    }
  }
}

init();
