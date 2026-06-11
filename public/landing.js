// Landingspagina: lijst van avondvierdaagsen. Nieuwe aanmaken kan alleen
// via /beheer (platformbeheerder).
async function loadEvents() {
  const list = document.getElementById('event-list');
  try {
    const res = await fetch('/api/events');
    if (!res.ok) throw new Error();
    const events = await res.json();
    list.innerHTML = '';
    if (events.length === 0) {
      list.innerHTML = '<li class="hint">Er zijn nog geen avondvierdaagsen gepubliceerd.</li>';
      return;
    }
    for (const ev of events) {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `/${ev.slug}`;
      a.textContent = ev.name;
      li.appendChild(a);
      list.appendChild(li);
    }
  } catch {
    list.innerHTML = '<li class="hint">Let op: lijst laden mislukt.</li>';
  }
}

loadEvents();
