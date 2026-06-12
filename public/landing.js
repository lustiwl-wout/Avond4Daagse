// Landingspagina: lijst van avondvierdaagsen. Nieuwe aanmaken kan alleen
// via /beheer (platformbeheerder).
async function loadEvents() {
  const list = document.getElementById('event-list');
  try {
    const res = await fetch('/api/events');
    if (!res.ok) throw new Error();
    const { baseDomain, events } = await res.json();
    list.innerHTML = '';
    // Elk event leeft op zijn eigen subdomein; afgelopen edities staan
    // apart onder "Eerdere edities".
    const base = baseDomain || location.hostname;
    const render = (ev) => {
      const li = document.createElement('li');
      const a = document.createElement('a');
      a.href = `${location.protocol}//${ev.slug}.${base}`;
      a.textContent = ev.name;
      li.appendChild(a);
      return li;
    };
    const current = events.filter((ev) => !ev.archived);
    if (current.length === 0) {
      list.innerHTML = '<li class="hint">Er zijn nog geen avondvierdaagsen gepubliceerd.</li>';
    } else {
      for (const ev of current) list.appendChild(render(ev));
    }
    const archived = events.filter((ev) => ev.archived);
    if (archived.length > 0) {
      const archiveList = document.getElementById('archive-list');
      archiveList.innerHTML = '';
      for (const ev of archived) archiveList.appendChild(render(ev));
      document.getElementById('archive-card').hidden = false;
    }
  } catch {
    list.innerHTML = '<li class="hint">Let op: lijst laden mislukt.</li>';
  }
}

loadEvents();
