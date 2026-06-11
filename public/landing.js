// Landingspagina: lijst van avondvierdaagsen en een formulier om er zelf
// één te starten (naam + webadres + eigen beheerwachtwoord).
async function loadEvents() {
  const list = document.getElementById('event-list');
  try {
    const res = await fetch('/api/events');
    if (!res.ok) throw new Error();
    const events = await res.json();
    list.innerHTML = '';
    if (events.length === 0) {
      list.innerHTML = '<li class="hint">Nog geen avondvierdaagsen — start hieronder de eerste!</li>';
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

function updatePreview() {
  preview.textContent = slugInput.value
    ? `Jouw pagina wordt: ${location.origin}/${slugInput.value}`
    : '';
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
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: nameInput.value,
      slug: slugInput.value,
      password: document.getElementById('new-password').value,
    }),
  });
  if (res.ok) {
    const { slug } = await res.json();
    status.textContent = 'Gelukt! Je gaat nu naar je beheerpagina…';
    location.href = `/${slug}/admin`;
  } else {
    const err = await res.json().catch(() => ({}));
    status.textContent = 'Let op: ' + (err.error || 'aanmaken mislukt.');
  }
});

loadEvents();
