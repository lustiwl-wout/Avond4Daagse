// Start/finish-symbool voor op de kaart: witte vlag in een donkere cirkel.
function flagIcon() {
  const svg =
    '<svg xmlns="http://www.w3.org/2000/svg" width="34" height="34" viewBox="0 0 34 34">' +
    '<circle cx="17" cy="17" r="15" fill="#0f172a" stroke="#ffffff" stroke-width="2.5"/>' +
    '<path d="M12.5 8.5v17" stroke="#ffffff" stroke-width="2.2" stroke-linecap="round"/>' +
    '<path d="M12.5 9h10.5l-3 4 3 4H12.5z" fill="#ffffff"/>' +
    '</svg>';
  return {
    url: 'data:image/svg+xml;charset=UTF-8,' + encodeURIComponent(svg),
    anchor: new google.maps.Point(17, 17),
  };
}

// Gedeelde GPS-volgfunctie voor alle pagina's. Verwacht in de pagina:
// #gps-start, #gps-stop, #follow-label met #follow-me, en #gps-status.
// `getMap` levert de Google Map; `onFix` (optioneel) krijgt elke positie.
function setupGps(getMap, onFix) {
  let watchId = null;
  let posMarker = null;
  let accuracyCircle = null;
  let firstFix = true;
  let lastPos = null;

  const startBtn = document.getElementById('gps-start');
  const stopBtn = document.getElementById('gps-stop');
  const followLabel = document.getElementById('follow-label');
  const status = document.getElementById('gps-status');

  startBtn.addEventListener('click', () => {
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
    lastPos = null;
    if (posMarker) posMarker.setMap(null);
    if (accuracyCircle) accuracyCircle.setMap(null);
    posMarker = null;
    accuracyCircle = null;
    status.textContent = '';
    startBtn.classList.remove('hidden');
    stopBtn.classList.add('hidden');
    if (followLabel) followLabel.classList.add('hidden');
  }

  function onPosition(position) {
    const map = getMap();
    if (!map) return;
    const pos = { lat: position.coords.latitude, lng: position.coords.longitude };
    lastPos = pos;
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
    status.textContent = `Nauwkeurigheid: ±${Math.round(position.coords.accuracy)} m`;

    const follow = document.getElementById('follow-me');
    if (follow && follow.checked) {
      map.panTo(pos);
      if (firstFix) map.setZoom(17);
    }
    firstFix = false;
    if (onFix) onFix(pos, position.coords.accuracy);
  }

  function onError(err) {
    const messages = {
      1: 'Let op: Geen toestemming voor locatie. Sta locatietoegang toe in je browser.',
      2: 'Let op: Locatie niet beschikbaar.',
      3: 'Let op: GPS duurt te lang, opnieuw aan het proberen…',
    };
    status.textContent = messages[err.code] || 'Let op: GPS-fout.';
    if (err.code === 1) stop();
  }

  return {
    getPosition: () => lastPos,
    isActive: () => watchId !== null,
  };
}
