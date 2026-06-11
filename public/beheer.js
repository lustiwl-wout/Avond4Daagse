// Platformbeheer (hoofddomein/admin): nieuwe avondvierdaagsen aanmaken met
// het master-wachtwoord, en de bestaande lijst inzien.
function slugify(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
}

const nameInput = document.getElementById('new-name');
const slugInput = document.getElementById('new-slug');
const preview = document.getElementById('slug-preview');
let slugTouched = false;
// Elk event leeft op een eigen subdomein; het basisdomein komt van de server.
let baseDomain = location.hostname;

function eventLink(slug, page = '') {
  return `${location.protocol}//${slug}.${baseDomain}${page}`;
}

function updatePreview() {
  preview.textContent = slugInput.value ? `Pagina: ${eventLink(slugInput.value)}` : '';
}

nameInput.addEventListener('input', () => {
  if (!slugTouched) slugInput.value = slugify(nameInput.value);
  updatePreview();
});

slugInput.addEventListener('input', () => {
  slugTouched = true;
  slugInput.value = slugify(slugInput.value);
  updatePreview();
});

document.getElementById('create-btn').addEventListener('click', async () => {
  const status = document.getElementById('create-status');
  status.textContent = 'Aanmaken…';
  const res = await fetch('/api/events', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-admin-password': document.getElementById('master-password').value,
    },
    body: JSON.stringify({
      name: nameInput.value,
      slug: slugInput.value,
      password: document.getElementById('new-password').value,
    }),
  });
  if (res.ok) {
    const { slug } = await res.json();
    status.textContent = `Gelukt! De avondvierdaagse staat op ${eventLink(slug)} — beheer via ${eventLink(slug, '/admin')}.`;
    nameInput.value = '';
    slugInput.value = '';
    document.getElementById('new-password').value = '';
    slugTouched = false;
    updatePreview();
    loadEvents();
  } else {
    const err = await res.json().catch(() => ({}));
    status.textContent = 'Let op: ' + (err.error || 'aanmaken mislukt.');
  }
});

async function loadEvents() {
  const list = document.getElementById('event-list');
  try {
    const res = await fetch('/api/events');
    if (!res.ok) throw new Error();
    const { baseDomain: base, events } = await res.json();
    if (base) baseDomain = base;
    list.innerHTML = '';
    updatePreview();
    if (events.length === 0) {
      list.innerHTML = '<li class="hint">Nog geen avondvierdaagsen.</li>';
      return;
    }
    for (const ev of events) {
      const li = document.createElement('li');
      const name = document.createElement('span');
      name.textContent = ev.name;
      li.appendChild(name);
      const links = document.createElement('span');
      links.innerHTML = `<a href="${eventLink(ev.slug)}">bekijken</a> · <a href="${eventLink(ev.slug, '/admin')}">beheer</a> · `;
      const pwdLink = document.createElement('a');
      pwdLink.href = '#';
      pwdLink.textContent = 'wachtwoord';
      pwdLink.addEventListener('click', (e) => {
        e.preventDefault();
        changeEventPassword(ev);
      });
      links.appendChild(pwdLink);
      li.appendChild(links);
      list.appendChild(li);
    }
  } catch {
    list.innerHTML = '<li class="hint">Let op: lijst laden mislukt.</li>';
  }
}

// Beheerwachtwoord van een event wijzigen — met het master-wachtwoord.
async function changeEventPassword(ev) {
  const status = document.getElementById('list-status');
  const master = document.getElementById('master-password').value;
  if (!master) {
    status.textContent = 'Vul eerst het master-wachtwoord in (bovenaan).';
    return;
  }
  const newPwd = prompt(`Nieuw beheerwachtwoord voor "${ev.name}" (minstens 6 tekens):`);
  if (newPwd === null) return;
  if (newPwd.length < 6) {
    status.textContent = 'Let op: het wachtwoord moet minstens 6 tekens lang zijn.';
    return;
  }
  status.textContent = 'Wachtwoord wijzigen…';
  const res = await fetch(`/api/${ev.slug}/admin/password`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', 'x-admin-password': master },
    body: JSON.stringify({ password: newPwd }),
  });
  if (res.ok) {
    status.textContent = `Beheerwachtwoord van "${ev.name}" gewijzigd.`;
  } else {
    const err = await res.json().catch(() => ({}));
    status.textContent = 'Let op: ' + (err.error || 'wachtwoord wijzigen mislukt.');
  }
}

loadEvents();
