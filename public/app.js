// Startpunt: Almere (pas SCHOOL_LOCATION aan naar het exacte adres van de school).
const SCHOOL_LOCATION = { lat: 52.3508, lng: 5.2647 };
const DAY_COLORS = { 1: '#dc2626', 2: '#2563eb', 3: '#16a34a', 4: '#9333ea' };
const MAX_POINTS = 27; // Directions API: origin + bestemming + 25 tussenpunten

let map;
let panorama;
let directionsService;
let currentDay = 1;

// Per dag: { points: [{lat, lng}], markers: [], renderer, distanceM }
const days = {};

async function loadGoogleMaps() {
  const res = await fetch('/api/config');
  const config = await res.json();
  if (!config.googleMapsApiKey) {
    document.getElementById('map').innerHTML =
      '<p style="padding:2rem">⚠️ Geen Google Maps API-key geconfigureerd. Zet de omgevingsvariabele <code>GOOGLE_MAPS_API_KEY</code>.</p>';
    return;
  }
  const script = document.createElement('script');
  script.src = `https://maps.googleapis.com/maps/api/js?key=${config.googleMapsApiKey}&callback=initMap`;
  script.async = true;
  document.head.appendChild(script);
}

window.initMap = function () {
  map = new google.maps.Map(document.getElementById('map'), {
    center: SCHOOL_LOCATION,
    zoom: 14,
    streetViewControl: true, // het gele poppetje voor Street View
    mapTypeControl: true,
    fullscreenControl: false,
  });

  panorama = new google.maps.StreetViewPanorama(document.getElementById('pano'));

  directionsService = new google.maps.DirectionsService();

  for (let day = 1; day <= 4; day++) {
    days[day] = {
      points: [],
      markers: [],
      distanceM: 0,
      renderer: new google.maps.DirectionsRenderer({
        map,
        suppressMarkers: true,
        preserveViewport: true,
        polylineOptions: { strokeColor: DAY_COLORS[day], strokeWeight: 5, strokeOpacity: 0.8 },
      }),
    };
  }

  map.addListener('click', (e) => {
    addPoint(currentDay, { lat: e.latLng.lat(), lng: e.latLng.lng() });
  });

  loadRouteList();
};

function addPoint(day, point) {
  const d = days[day];
  if (d.points.length >= MAX_POINTS) {
    alert(`Maximaal ${MAX_POINTS} punten per route.`);
    return;
  }
  d.points.push(point);
  addMarker(day, point, d.points.length - 1);
  updateRoute(day);
}

function addMarker(day, point, index) {
  const d = days[day];
  const marker = new google.maps.Marker({
    position: point,
    map,
    draggable: true,
    label: { text: String(index + 1), color: '#fff', fontSize: '11px' },
    icon: {
      path: google.maps.SymbolPath.CIRCLE,
      scale: 10,
      fillColor: DAY_COLORS[day],
      fillOpacity: 1,
      strokeColor: '#fff',
      strokeWeight: 2,
    },
  });
  marker.addListener('dragend', () => {
    d.points[d.markers.indexOf(marker)] = {
      lat: marker.getPosition().lat(),
      lng: marker.getPosition().lng(),
    };
    updateRoute(day);
  });
  marker.addListener('rightclick', () => {
    const i = d.markers.indexOf(marker);
    d.points.splice(i, 1);
    marker.setMap(null);
    d.markers.splice(i, 1);
    relabelMarkers(day);
    updateRoute(day);
  });
  d.markers.push(marker);
}

function relabelMarkers(day) {
  days[day].markers.forEach((m, i) =>
    m.setLabel({ text: String(i + 1), color: '#fff', fontSize: '11px' })
  );
}

function updateRoute(day) {
  const d = days[day];
  if (d.points.length < 2) {
    d.renderer.setDirections({ routes: [] });
    d.distanceM = 0;
    updateInfo();
    return;
  }
  directionsService.route(
    {
      origin: d.points[0],
      destination: d.points[d.points.length - 1],
      waypoints: d.points.slice(1, -1).map((p) => ({ location: p, stopover: false })),
      travelMode: google.maps.TravelMode.WALKING,
    },
    (result, status) => {
      if (status === 'OK') {
        d.renderer.setDirections(result);
        d.distanceM = result.routes[0].legs.reduce((sum, leg) => sum + leg.distance.value, 0);
      } else {
        console.error('Directions mislukt:', status);
        d.distanceM = 0;
      }
      updateInfo();
    }
  );
}

function updateInfo() {
  const d = days[currentDay];
  document.getElementById('point-count').textContent = `${d.points.length} punten`;
  document.getElementById('distance').textContent =
    (d.distanceM / 1000).toFixed(1).replace('.', ',') + ' km';
}

function clearDay(day) {
  const d = days[day];
  d.points = [];
  d.markers.forEach((m) => m.setMap(null));
  d.markers = [];
  d.distanceM = 0;
  d.renderer.setDirections({ routes: [] });
  updateInfo();
}

// --- UI: dagen ---
document.querySelectorAll('.day-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    document.querySelector('.day-tab.active').classList.remove('active');
    tab.classList.add('active');
    currentDay = Number(tab.dataset.day);
    updateInfo();
  });
});

document.getElementById('undo-btn').addEventListener('click', () => {
  const d = days[currentDay];
  if (d.points.length === 0) return;
  d.points.pop();
  d.markers.pop().setMap(null);
  updateRoute(currentDay);
});

document.getElementById('clear-btn').addEventListener('click', () => clearDay(currentDay));

// --- Street View ---
document.getElementById('streetview-btn').addEventListener('click', () => {
  const d = days[currentDay];
  if (d.points.length === 0) {
    alert('Zet eerst een punt op de kaart.');
    return;
  }
  panorama.setPosition(d.points[d.points.length - 1]);
  document.getElementById('streetview').classList.remove('hidden');
});

document.getElementById('close-streetview').addEventListener('click', () => {
  document.getElementById('streetview').classList.add('hidden');
});

// --- Opslaan & laden ---
function setSaveStatus(text) {
  document.getElementById('save-status').textContent = text;
  setTimeout(() => (document.getElementById('save-status').textContent = ''), 4000);
}

document.getElementById('save-btn').addEventListener('click', async () => {
  const d = days[currentDay];
  const name = document.getElementById('route-name').value.trim();
  if (!name) return setSaveStatus('Geef de route eerst een naam.');
  if (d.points.length < 2) return setSaveStatus('Een route heeft minimaal 2 punten nodig.');

  const res = await fetch('/api/routes', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      day: currentDay,
      waypoints: d.points,
      distance_m: d.distanceM,
    }),
  });
  if (res.ok) {
    setSaveStatus('✅ Opgeslagen!');
    document.getElementById('route-name').value = '';
    loadRouteList();
  } else {
    const err = await res.json().catch(() => ({}));
    setSaveStatus('⚠️ ' + (err.error || 'Opslaan mislukt.'));
  }
});

async function loadRouteList() {
  const list = document.getElementById('route-list');
  try {
    const res = await fetch('/api/routes');
    if (!res.ok) throw new Error();
    const routes = await res.json();
    list.innerHTML = '';
    if (routes.length === 0) {
      list.innerHTML = '<li class="hint">Nog geen routes opgeslagen.</li>';
      return;
    }
    for (const route of routes) {
      const li = document.createElement('li');
      const km = route.distance_m ? (route.distance_m / 1000).toFixed(1).replace('.', ',') : '?';
      li.innerHTML = `<span>${escapeHtml(route.name)}<br>
        <span class="route-meta">Dag ${route.day} · ${km} km</span></span>`;
      const loadBtn = document.createElement('button');
      loadBtn.textContent = '📂';
      loadBtn.title = 'Route laden';
      loadBtn.addEventListener('click', () => loadRoute(route));
      const delBtn = document.createElement('button');
      delBtn.textContent = '🗑';
      delBtn.title = 'Route verwijderen';
      delBtn.addEventListener('click', async () => {
        if (!confirm(`"${route.name}" verwijderen?`)) return;
        await fetch(`/api/routes/${route.id}`, { method: 'DELETE' });
        loadRouteList();
      });
      const btns = document.createElement('span');
      btns.append(loadBtn, delBtn);
      li.appendChild(btns);
      list.appendChild(li);
    }
  } catch {
    list.innerHTML = '<li class="hint">⚠️ Routes laden mislukt (database geconfigureerd?).</li>';
  }
}

function loadRoute(route) {
  clearDay(route.day);
  currentDay = route.day;
  document.querySelector('.day-tab.active').classList.remove('active');
  document.querySelector(`.day-tab[data-day="${route.day}"]`).classList.add('active');
  for (const p of route.waypoints) {
    days[route.day].points.push(p);
    addMarker(route.day, p, days[route.day].points.length - 1);
  }
  updateRoute(route.day);
  map.panTo(route.waypoints[0]);
}

function escapeHtml(s) {
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

loadGoogleMaps();
