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

function baseHost() {
  // Op een subdomein-installatie tonen we het subdomein-adres als voorbeeld.
  const labels = location.hostname.split('.');
  if (labels.length > 2 && !location.hostname.endsWith('.onrender.com')) {
    return labels.slice(1).join('.');
  }
  return null;
}

function updatePreview() {
  if (!slugInput.value) {
    preview.textContent = '';
    return;
  }
  const base = baseHost();
  preview.textContent = base
    ? `Pagina: https://${slugInput.value}.${base}`
    : `Pagina: ${location.origin}/${slugInput.value}`;
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
    status.textContent = `Gelukt! De avondvierdaagse staat op /${slug} — beheer via /${slug}/admin.`;
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
    const events = await res.json();
    list.innerHTML = '';
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
      links.innerHTML = `<a href="/${ev.slug}">bekijken</a> · <a href="/${ev.slug}/admin">beheer</a>`;
      li.appendChild(links);
      list.appendChild(li);
    }
  } catch {
    list.innerHTML = '<li class="hint">Let op: lijst laden mislukt.</li>';
  }
}

loadEvents();
