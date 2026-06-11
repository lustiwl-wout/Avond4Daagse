// Gedeelde GPS-volgfunctie (Leaflet) voor alle pagina's. Verwacht in de
// pagina: #gps-start, #gps-stop, #follow-label met #follow-me, en #gps-status.
// `getMap` levert de Leaflet-kaart; `onFix` (optioneel) krijgt elke positie.
//
// Op /simulate gedraagt de pagina zich hetzelfde, maar zet een klik op de
// kaart de "GPS-positie" — om voortgang e.d. te testen zonder te lopen.
const GPS_SIMULATE = /\/simulate\/?$/.test(location.pathname);

function setupGps(getMap, onFix) {
  let watchId = null;
  let posMarker = null;
  let accuracyCircle = null;
  let firstFix = true;
  let lastPos = null;
  let simActive = false;

  const startBtn = document.getElementById('gps-start');
  const stopBtn = document.getElementById('gps-stop');
  const followLabel = document.getElementById('follow-label');
  const status = document.getElementById('gps-status');

  if (GPS_SIMULATE) startBtn.textContent = 'Start GPS-simulatie';

  function simClick(e) {
    onPosition({ coords: { latitude: e.latlng.lat, longitude: e.latlng.lng, accuracy: 8 } });
  }

  startBtn.addEventListener('click', () => {
    if (GPS_SIMULATE) {
      simActive = true;
      window.__gpsSimActive = true; // pagina's slaan hun eigen kaartklik-acties over
      getMap().on('click', simClick);
      firstFix = true;
      status.textContent = 'Simulatie: klik op de kaart om je positie te zetten.';
      startBtn.classList.add('hidden');
      stopBtn.classList.remove('hidden');
      if (followLabel) followLabel.classList.remove('hidden');
      return;
    }
    if (!navigator.geolocation) {
      status.textContent = 'Let op: GPS wordt niet ondersteund door deze browser.';
      return;
    }
    firstFix = true;
    status.textContent = 'GPS zoeken…';
    watchId = navigator.geolocation.watchPosition(onPosition, onError, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000,
    });
    startBtn.classList.add('hidden');
    stopBtn.classList.remove('hidden');
    if (followLabel) followLabel.classList.remove('hidden');
  });

  stopBtn.addEventListener('click', stop);

  function stop() {
    if (watchId !== null) navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (simActive) {
      const map = getMap();
      if (map) map.off('click', simClick);
      simActive = false;
      window.__gpsSimActive = false;
    }
    lastPos = null;
    if (posMarker) posMarker.remove();
    if (accuracyCircle) accuracyCircle.remove();
    posMarker = null;
    accuracyCircle = null;
    status.textContent = '';
    startBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    if (followLabel) followLabel.classList.add('hidden');
    if (onFix) onFix(null); // de pagina kan voortgang e.d. opruimen
  }

  function onPosition(position) {
    const map = getMap();
    if (!map) return;
    const pos = { lat: position.coords.latitude, lng: position.coords.longitude };
    lastPos = pos;
    const latlng = [pos.lat, pos.lng];
    if (!posMarker) {
      posMarker = L.marker(latlng, { icon: posIcon(), zIndexOffset: 1200, interactive: false }).addTo(map);
      accuracyCircle = L.circle(latlng, {
        radius: position.coords.accuracy,
        color: '#4285F4',
        weight: 1,
        opacity: 0.3,
        fillColor: '#4285F4',
        fillOpacity: 0.12,
        interactive: false,
      }).addTo(map);
    }
    posMarker.setLatLng(latlng);
    accuracyCircle.setLatLng(latlng);
    accuracyCircle.setRadius(position.coords.accuracy);
    status.textContent = simActive
      ? 'Simulatie: klik op de kaart om je positie te verplaatsen.'
      : `Nauwkeurigheid: ±${Math.round(position.coords.accuracy)} m`;

    const follow = document.getElementById('follow-me');
    if (follow && follow.checked) {
      map.panTo(latlng);
      if (firstFix) map.setZoom(17);
    }
    firstFix = false;
    if (onFix) onFix(pos, position.coords.accuracy);
  }

  function onError(err) {
    const messages = {
      1: 'Let op: geen toestemming voor locatie. Sta locatietoegang toe in je browser.',
      2: 'Let op: locatie niet beschikbaar.',
      3: 'GPS duurt te lang, opnieuw aan het proberen…',
    };
    status.textContent = messages[err.code] || 'Let op: GPS-fout.';
    if (err.code === 1) stop();
  }

  return {
    getPosition: () => lastPos,
    isActive: () => watchId !== null,
  };
}
