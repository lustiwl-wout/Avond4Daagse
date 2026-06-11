const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

// Eén installatie host meerdere avondvierdaagsen ("events"): elke
// organisatie heeft een eigen pad (/syncope, /obs-noord, …) met eigen
// routes, teams, sponsors, instellingen en beheerwachtwoord.
// Het master-wachtwoord (omgevingsvariabele ADMIN_PASSWORD) werkt op
// elk event — handig voor de platformbeheerder.

app.use(express.json());
// index: false — '/' beslist zelf (landing of, op een subdomein, het event).
app.use(express.static(path.join(__dirname, 'public'), { index: false }));

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

const RESERVED_SLUGS = new Set(['api', 'admin', 'verkeer', 'print', 'beheer', 'favicon.ico', '']);
const SLUG_RE = /^[a-z0-9][a-z0-9-]{1,39}$/;

let pool = null;
if (process.env.DATABASE_URL) {
  // SSL aan voor gehoste databases (Neon); uit voor lokale verbindingen.
  const local = /localhost|127\.0\.0\.1|host=\/|sslmode=disable/.test(process.env.DATABASE_URL);
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: local ? false : { rejectUnauthorized: false },
  });
} else {
  console.warn('DATABASE_URL is niet gezet — opslaan werkt niet.');
}

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS events (
      id SERIAL PRIMARY KEY,
      slug TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS day_routes (
      event_id INTEGER NOT NULL,
      day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 4),
      waypoints JSONB NOT NULL,
      path JSONB,
      distance_m INTEGER,
      crossings JSONB,
      pause JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (event_id, day)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      event_id INTEGER NOT NULL,
      key TEXT NOT NULL,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (event_id, key)
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      color TEXT NOT NULL
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS route_drafts (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL,
      day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 4),
      waypoints JSONB NOT NULL,
      path JSONB,
      distance_m INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sponsors (
      id SERIAL PRIMARY KEY,
      event_id INTEGER NOT NULL,
      day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 4),
      lat DOUBLE PRECISION NOT NULL,
      lng DOUBLE PRECISION NOT NULL,
      first_name TEXT NOT NULL,
      last_name TEXT NOT NULL,
      email TEXT NOT NULL,
      phone TEXT NOT NULL,
      action TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await migrateToEvents();
  // Pas ná de migratie: oudere installaties hebben de event_id-kolom dan pas.
  await pool.query(
    'CREATE INDEX IF NOT EXISTS route_drafts_event_day_idx ON route_drafts (event_id, day, id DESC)'
  );
}

// Migratie van een oudere één-organisatie-installatie: bestaande data
// (zonder event_id) wordt het event "syncope"; het bestaande
// ADMIN_PASSWORD blijft daar werken als eigen wachtwoord.
async function migrateToEvents() {
  for (const table of ['day_routes', 'settings', 'teams', 'route_drafts', 'sponsors']) {
    await pool.query(`ALTER TABLE ${table} ADD COLUMN IF NOT EXISTS event_id INTEGER`);
  }

  const { rows: existingEvents } = await pool.query('SELECT id FROM events ORDER BY id LIMIT 1');
  let defaultEventId = existingEvents.length > 0 ? existingEvents[0].id : null;

  // Data zonder event in welke tabel dan ook = oude één-organisatie-installatie.
  let hasOrphans = false;
  for (const table of ['day_routes', 'settings', 'teams', 'route_drafts', 'sponsors']) {
    const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE event_id IS NULL LIMIT 1`);
    if (rows.length > 0) {
      hasOrphans = true;
      break;
    }
  }
  if (defaultEventId === null && hasOrphans) {
    const hash = sha256(process.env.ADMIN_PASSWORD || crypto.randomBytes(16).toString('hex'));
    const { rows } = await pool.query(
      `INSERT INTO events (slug, name, password_hash)
       VALUES ('syncope', 'Basisschool Syncope · Almere', $1)
       ON CONFLICT (slug) DO UPDATE SET name = events.name
       RETURNING id`,
      [hash]
    );
    defaultEventId = rows[0].id;
    console.log('Bestaande data gemigreerd naar event "syncope".');
  }
  if (defaultEventId !== null) {
    for (const table of ['day_routes', 'settings', 'teams', 'route_drafts', 'sponsors']) {
      await pool.query(`UPDATE ${table} SET event_id = $1 WHERE event_id IS NULL`, [defaultEventId]);
    }
  }

  // Primaire sleutels van oude installaties verbreden naar (event_id, …).
  async function pkColumns(table) {
    const { rows } = await pool.query(
      `SELECT a.attname
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
       WHERE i.indrelid = $1::regclass AND i.indisprimary
       ORDER BY a.attnum`,
      [table]
    );
    return rows.map((r) => r.attname);
  }
  if ((await pkColumns('day_routes')).join(',') === 'day') {
    await pool.query('ALTER TABLE day_routes DROP CONSTRAINT day_routes_pkey');
    await pool.query('ALTER TABLE day_routes ADD PRIMARY KEY (event_id, day)');
  }
  if ((await pkColumns('settings')).join(',') === 'key') {
    await pool.query('ALTER TABLE settings DROP CONSTRAINT settings_pkey');
    await pool.query('ALTER TABLE settings ADD PRIMARY KEY (event_id, key)');
  }
}

// --- Hulpfuncties ---

function requireDb(res) {
  if (!pool) {
    res.status(503).json({ error: 'Database niet geconfigureerd (DATABASE_URL ontbreekt).' });
    return false;
  }
  return true;
}

function requireAdmin(req, res) {
  const given = req.get('x-admin-password') || '';
  const master = process.env.ADMIN_PASSWORD || '';
  const ok =
    (master && given === master) || (req.event && given && sha256(given) === req.event.password_hash);
  if (!ok) {
    res.status(401).json({ error: 'Onjuist wachtwoord.' });
    return false;
  }
  return true;
}

function parseDay(req, res) {
  const day = Number(req.params.day);
  if (!Number.isInteger(day) || day < 1 || day > 4) {
    res.status(400).json({ error: 'Dag moet 1 t/m 4 zijn.' });
    return null;
  }
  return day;
}

function isValidLatLng(p) {
  return p && typeof p.lat === 'number' && typeof p.lng === 'number';
}

async function getSetting(eventId, key) {
  const { rows } = await pool.query('SELECT value FROM settings WHERE event_id = $1 AND key = $2', [
    eventId,
    key,
  ]);
  return rows.length > 0 ? rows[0].value : null;
}

async function setSetting(eventId, key, value) {
  await pool.query(
    `INSERT INTO settings (event_id, key, value, updated_at) VALUES ($1, $2, $3, now())
     ON CONFLICT (event_id, key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [eventId, key, JSON.stringify(value)]
  );
}

// Datum in Nederland (de loopdagen bepalen o.a. of sponsoracties open staan).
function todayNl() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date());
}

function scheduleEntries(eventSetting) {
  const days = (eventSetting && eventSetting.days) || {};
  return [1, 2, 3, 4]
    .filter((d) => days[d] && days[d].date)
    .map((d) => ({ day: d, date: days[d].date, time: days[d].time || null }))
    .sort((a, b) => a.date.localeCompare(b.date));
}

function sponsorOpenFor(eventSetting) {
  const entries = scheduleEntries(eventSetting);
  if (entries.length > 0) return todayNl() < entries[0].date;
  if (eventSetting && eventSetting.startDate) return todayNl() < eventSetting.startDate;
  return false;
}

function computeDefaultDay(eventSetting) {
  const entries = scheduleEntries(eventSetting);
  if (entries.length === 0) return 1;
  const today = todayNl();
  const upcoming = entries.find((e) => e.date >= today);
  return upcoming ? upcoming.day : entries[entries.length - 1].day;
}

// --- OpenStreetMap-diensten: routes (OSRM) en adressen (Nominatim) ---

const OSM_UA = 'Avond4Daagse-routeplanner/1.0 (https://github.com/lustiwl-wout/Avond4Daagse)';
const OSRM_PROFILES = {
  foot: 'https://routing.openstreetmap.de/routed-foot',
};

const geoCache = new Map();
let geoChain = Promise.resolve();
let lastGeoCall = 0;

function throttledNominatim(url) {
  const call = geoChain.then(async () => {
    const wait = Math.max(0, 1100 - (Date.now() - lastGeoCall));
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastGeoCall = Date.now();
    const resp = await fetch(url, { headers: { 'User-Agent': OSM_UA } });
    if (!resp.ok) throw new Error(`Nominatim gaf status ${resp.status}`);
    return resp.json();
  });
  geoChain = call.catch(() => {});
  return call;
}

// Adres bij een punt (publiek, voor de printversie en puntnamen) — gecachet.
app.get('/api/address', async (req, res) => {
  const lat = Number(req.query.lat);
  const lng = Number(req.query.lng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) {
    return res.status(400).json({ error: 'Ongeldige coördinaten.' });
  }
  const key = `${lat.toFixed(5)},${lng.toFixed(5)}`;
  if (geoCache.has(key)) return res.json(geoCache.get(key));
  try {
    const data = await throttledNominatim(
      `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=18&accept-language=nl`
    );
    const a = data.address || {};
    const road = a.road || a.pedestrian || a.cycleway || a.footway || '';
    const address =
      [
        [road, a.house_number].filter(Boolean).join(' '),
        a.suburb || a.neighbourhood || a.quarter,
        a.city || a.town || a.village,
      ]
        .filter(Boolean)
        .join(', ') ||
      (data.display_name || 'Onbekend adres').split(',').slice(0, 3).join(',');
    const out = { address, road };
    geoCache.set(key, out);
    res.json(out);
  } catch (err) {
    console.error('Adres opzoeken mislukt:', err);
    res.status(502).json({ error: 'Adres opzoeken mislukt.' });
  }
});

// --- Events: lijst en aanmaken (vanaf de landingspagina) ---

app.get('/api/events', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { rows } = await pool.query('SELECT slug, name FROM events ORDER BY name');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Lijst ophalen mislukt.' });
  }
});

app.post('/api/events', async (req, res) => {
  if (!requireDb(res)) return;
  // Nieuwe avondvierdaagsen aanmaken kan alleen door de platformbeheerder
  // (master-wachtwoord), via de /beheer-pagina.
  const master = process.env.ADMIN_PASSWORD || '';
  if (!master || req.get('x-admin-password') !== master) {
    return res.status(401).json({ error: 'Alleen de platformbeheerder kan een avondvierdaagse aanmaken.' });
  }
  const { name, slug, password } = req.body || {};
  const cleanName = String(name || '').trim();
  const cleanSlug = String(slug || '').trim().toLowerCase();
  if (cleanName.length < 2 || cleanName.length > 60) {
    return res.status(400).json({ error: 'Geef een naam van 2–60 tekens.' });
  }
  if (!SLUG_RE.test(cleanSlug) || RESERVED_SLUGS.has(cleanSlug)) {
    return res
      .status(400)
      .json({ error: 'Webadres mag alleen kleine letters, cijfers en streepjes bevatten (2–40 tekens).' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Kies een beheerwachtwoord van minstens 6 tekens.' });
  }
  try {
    await pool.query('INSERT INTO events (slug, name, password_hash) VALUES ($1, $2, $3)', [
      cleanSlug,
      cleanName,
      sha256(password),
    ]);
    res.status(201).json({ slug: cleanSlug });
  } catch (err) {
    if (err.code === '23505') {
      return res.status(409).json({ error: 'Dit webadres is al in gebruik — kies een ander.' });
    }
    console.error(err);
    res.status(500).json({ error: 'Aanmaken mislukt.' });
  }
});

// --- Event-API: alles onder /api/:slug/... ---

const eventApi = express.Router({ mergeParams: true });

app.use(
  '/api/:slug',
  async (req, res, next) => {
    if (!requireDb(res)) return;
    try {
      const { rows } = await pool.query('SELECT * FROM events WHERE slug = $1', [
        String(req.params.slug).toLowerCase(),
      ]);
      if (rows.length === 0) return res.status(404).json({ error: 'Onbekende avondvierdaagse.' });
      req.event = rows[0];
      next();
    } catch (err) {
      console.error(err);
      res.status(500).json({ error: 'Serverfout.' });
    }
  },
  eventApi
);

// Publieke configuratie van een event.
eventApi.get('/config', async (req, res) => {
  const ev = req.event;
  let startFinish = null;
  let vrSettings = null;
  let eventSetting = null;
  try {
    startFinish = await getSetting(ev.id, 'start_finish');
    vrSettings = await getSetting(ev.id, 'vr_settings');
    eventSetting = await getSetting(ev.id, 'event');
  } catch (err) {
    console.error('Instellingen ophalen mislukt:', err);
  }
  res.json({
    orgName: ev.name,
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    startFinish,
    vrSettings,
    schedule: (eventSetting && eventSetting.days) || null,
    defaultDay: computeDefaultDay(eventSetting),
    sponsorOpen: sponsorOpenFor(eventSetting),
  });
});

// Wachtwoordcontrole voor de adminpagina.
eventApi.get('/admin/check', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.status(204).end();
});

// Adres zoeken voor het start/finish-punt.
eventApi.get('/admin/geocode', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const q = String(req.query.q || '').trim();
  if (!q) return res.status(400).json({ error: 'Geen adres opgegeven.' });
  try {
    const data = await throttledNominatim(
      `https://nominatim.openstreetmap.org/search?format=json&limit=1&countrycodes=nl&q=${encodeURIComponent(q)}`
    );
    if (!data[0]) return res.status(404).json({ error: 'Adres niet gevonden.' });
    res.json({ lat: Number(data[0].lat), lng: Number(data[0].lon) });
  } catch (err) {
    console.error('Geocoderen mislukt:', err);
    res.status(502).json({ error: 'Adres opzoeken mislukt.' });
  }
});

// Start/finish-punt vastleggen.
eventApi.put('/admin/start-finish', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat en lng zijn verplicht.' });
  }
  try {
    await setSetting(req.event.id, 'start_finish', { lat, lng });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Start/finish opslaan mislukt.' });
  }
});

// Planningsinstellingen (wandeltempo en passeertijd).
eventApi.put('/admin/vr-settings', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { walkKmh, passMin } = req.body || {};
  if (![walkKmh, passMin].every((v) => typeof v === 'number' && v >= 0 && v < 100)) {
    return res.status(400).json({ error: 'Ongeldige planningsinstellingen.' });
  }
  try {
    await setSetting(req.event.id, 'vr_settings', { walkKmh, passMin });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Instellingen opslaan mislukt.' });
  }
});

// Datum en starttijd per loopdag.
eventApi.put('/admin/event-schedule', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { days } = req.body || {};
  if (!days || typeof days !== 'object') return res.status(400).json({ error: 'Ongeldige planning.' });
  const cleaned = {};
  for (const d of [1, 2, 3, 4]) {
    const entry = days[d] || days[String(d)];
    if (!entry || !entry.date) continue;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(entry.date))) {
      return res.status(400).json({ error: `Ongeldige datum bij dag ${d}.` });
    }
    if (entry.time && !/^\d{2}:\d{2}$/.test(String(entry.time))) {
      return res.status(400).json({ error: `Ongeldige tijd bij dag ${d}.` });
    }
    cleaned[d] = { date: entry.date, time: entry.time || null };
  }
  try {
    await setSetting(req.event.id, 'event', { days: cleaned });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Planning opslaan mislukt.' });
  }
});

// Pauzepunt van een dag plaatsen of weghalen.
eventApi.put('/admin/pause/:day', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  const { pause } = req.body || {};
  if (pause !== null && !isValidLatLng(pause)) {
    return res.status(400).json({ error: 'Ongeldig pauzepunt.' });
  }
  try {
    const { rowCount } = await pool.query(
      'UPDATE day_routes SET pause = $1, updated_at = now() WHERE event_id = $2 AND day = $3',
      [pause ? JSON.stringify(pause) : null, req.event.id, day]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Publiceer eerst de route van deze dag.' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Pauzepunt opslaan mislukt.' });
  }
});

// Route berekenen via OSRM (voetprofiel, kent alle wandel- en fietspaden).
eventApi.post('/admin/route', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { profile, points } = req.body || {};
  const base = OSRM_PROFILES[profile];
  if (!base) return res.status(400).json({ error: 'Onbekend routeprofiel.' });
  if (!Array.isArray(points) || points.length < 2 || points.length > 60 || !points.every(isValidLatLng)) {
    return res.status(400).json({ error: 'Ongeldige routepunten.' });
  }
  try {
    const coords = points.map((p) => `${p.lng.toFixed(6)},${p.lat.toFixed(6)}`).join(';');
    const url = `${base}/route/v1/driving/${coords}?overview=full&geometries=geojson&steps=false`;
    const resp = await fetch(url, { headers: { 'User-Agent': OSM_UA } });
    const data = await resp.json().catch(() => ({}));
    if (!resp.ok || data.code !== 'Ok' || !data.routes || !data.routes[0]) {
      return res.status(422).json({ error: 'Geen route mogelijk via deze punten.' });
    }
    const route = data.routes[0];
    res.json({
      path: route.geometry.coordinates.map(([lng, lat]) => ({ lat, lng })),
      distance_m: Math.round(route.distance),
      duration_s: Math.round(route.duration),
      legs: route.legs.map((l) => ({
        distance_m: Math.round(l.distance),
        duration_s: Math.round(l.duration),
      })),
    });
  } catch (err) {
    console.error('OSRM-route mislukt:', err);
    res.status(502).json({ error: 'Routeservice tijdelijk niet bereikbaar, probeer het zo opnieuw.' });
  }
});

// Publiek: alle dagroutes.
eventApi.get('/routes', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT day, waypoints, path, distance_m, crossings, pause, updated_at
       FROM day_routes WHERE event_id = $1 ORDER BY day`,
      [req.event.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Routes ophalen mislukt.' });
  }
});

// --- Conceptversies: elke wijziging wordt automatisch bewaard ---

eventApi.get('/admin/drafts', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (day) day, waypoints, path, distance_m
       FROM route_drafts WHERE event_id = $1 ORDER BY day, id DESC`,
      [req.event.id]
    );
    const { rows: counts } = await pool.query(
      'SELECT day, COUNT(*)::int AS count FROM route_drafts WHERE event_id = $1 GROUP BY day',
      [req.event.id]
    );
    res.json(
      rows.map((r) => ({
        ...r,
        count: (counts.find((c) => c.day === r.day) || { count: 0 }).count,
      }))
    );
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Concepten ophalen mislukt.' });
  }
});

eventApi.post('/admin/drafts/:day', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  const { waypoints, path: routePath, distance_m } = req.body;
  if (!Array.isArray(waypoints) || !waypoints.every(isValidLatLng)) {
    return res.status(400).json({ error: 'Ongeldige punten.' });
  }
  try {
    await pool.query(
      'INSERT INTO route_drafts (event_id, day, waypoints, path, distance_m) VALUES ($1, $2, $3, $4, $5)',
      [
        req.event.id,
        day,
        JSON.stringify(waypoints),
        routePath ? JSON.stringify(routePath) : null,
        distance_m || null,
      ]
    );
    await pool.query(
      `DELETE FROM route_drafts WHERE event_id = $1 AND day = $2 AND id NOT IN
       (SELECT id FROM route_drafts WHERE event_id = $1 AND day = $2 ORDER BY id DESC LIMIT 100)`,
      [req.event.id, day]
    );
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM route_drafts WHERE event_id = $1 AND day = $2',
      [req.event.id, day]
    );
    res.json({ count: rows[0].count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Concept bewaren mislukt.' });
  }
});

eventApi.delete('/admin/drafts/:day/latest', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  try {
    await pool.query(
      `DELETE FROM route_drafts WHERE id =
       (SELECT id FROM route_drafts WHERE event_id = $1 AND day = $2 ORDER BY id DESC LIMIT 1)`,
      [req.event.id, day]
    );
    const { rows } = await pool.query(
      `SELECT day, waypoints, path, distance_m FROM route_drafts
       WHERE event_id = $1 AND day = $2 ORDER BY id DESC LIMIT 1`,
      [req.event.id, day]
    );
    const { rows: counts } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM route_drafts WHERE event_id = $1 AND day = $2',
      [req.event.id, day]
    );
    res.json({ draft: rows[0] || null, count: counts[0].count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Terugdraaien mislukt.' });
  }
});

// Route definitief publiceren; conceptversies worden gewist.
eventApi.put('/routes/:day', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  const { waypoints, path: routePath, distance_m } = req.body;
  if (!Array.isArray(waypoints) || waypoints.length < 1 || !waypoints.every(isValidLatLng)) {
    return res.status(400).json({ error: 'Een route heeft minimaal 1 tussenpunt nodig.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO day_routes (event_id, day, waypoints, path, distance_m, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (event_id, day) DO UPDATE
         SET waypoints = EXCLUDED.waypoints,
             path = EXCLUDED.path,
             distance_m = EXCLUDED.distance_m,
             updated_at = now()
       RETURNING day, waypoints, path, distance_m, updated_at`,
      [
        req.event.id,
        day,
        JSON.stringify(waypoints),
        routePath ? JSON.stringify(routePath) : null,
        distance_m || null,
      ]
    );
    await pool.query('DELETE FROM route_drafts WHERE event_id = $1 AND day = $2', [req.event.id, day]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Route opslaan mislukt.' });
  }
});

eventApi.delete('/routes/:day', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM day_routes WHERE event_id = $1 AND day = $2', [
      req.event.id,
      day,
    ]);
    await pool.query('DELETE FROM route_drafts WHERE event_id = $1 AND day = $2', [req.event.id, day]);
    if (rowCount === 0) return res.status(404).json({ error: 'Geen route voor deze dag.' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Route verwijderen mislukt.' });
  }
});

// Route (met concepten, pauzepunt, oversteekpunten en sponsoracties) naar
// een andere dag verplaatsen; heeft de doeldag al een route, dan wisselen
// de dagen om. De loopdag-datums blijven bij hun kalenderdag.
eventApi.post('/admin/move-route', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const from = Number((req.body || {}).from);
  const to = Number((req.body || {}).to);
  if (![1, 2, 3, 4].includes(from) || ![1, 2, 3, 4].includes(to) || from === to) {
    return res.status(400).json({ error: 'Ongeldige dagen.' });
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows: routeRows } = await client.query(
      'SELECT * FROM day_routes WHERE event_id = $1 AND day IN ($2, $3) FOR UPDATE',
      [req.event.id, from, to]
    );
    await client.query('DELETE FROM day_routes WHERE event_id = $1 AND day IN ($2, $3)', [
      req.event.id,
      from,
      to,
    ]);
    for (const r of routeRows) {
      await client.query(
        `INSERT INTO day_routes (event_id, day, waypoints, path, distance_m, crossings, pause, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())`,
        [
          req.event.id,
          r.day === from ? to : from,
          JSON.stringify(r.waypoints),
          r.path ? JSON.stringify(r.path) : null,
          r.distance_m,
          r.crossings ? JSON.stringify(r.crossings) : null,
          r.pause ? JSON.stringify(r.pause) : null,
        ]
      );
    }
    await client.query(
      'UPDATE route_drafts SET day = CASE day WHEN $2 THEN $3 ELSE $2 END WHERE event_id = $1 AND day IN ($2, $3)',
      [req.event.id, from, to]
    );
    await client.query(
      'UPDATE sponsors SET day = CASE day WHEN $2 THEN $3 ELSE $2 END WHERE event_id = $1 AND day IN ($2, $3)',
      [req.event.id, from, to]
    );
    await client.query('COMMIT');
    res.status(204).end();
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Route verplaatsen mislukt:', err);
    res.status(500).json({ error: 'Route verplaatsen mislukt.' });
  } finally {
    client.release();
  }
});

// Oversteekpunten: losse, atomaire bewerkingen per punt. De server werkt
// de lijst onder een rijslot bij en stuurt de actuele lijst terug, zodat
// twee schermen (of trage verzoeken) elkaars wijzigingen nooit overschrijven.
async function withCrossings(eventId, day, mutate) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      'SELECT crossings FROM day_routes WHERE event_id = $1 AND day = $2 FOR UPDATE',
      [eventId, day]
    );
    if (rows.length === 0) {
      await client.query('ROLLBACK');
      return {
        status: 404,
        error: 'Deze dag heeft nog geen definitieve route — maak de route eerst definitief.',
      };
    }
    const crossings = mutate(rows[0].crossings || []);
    if (!crossings) {
      await client.query('ROLLBACK');
      return { status: 404, error: 'Oversteekpunt niet gevonden (al verwijderd?).' };
    }
    await client.query(
      'UPDATE day_routes SET crossings = $1, updated_at = now() WHERE event_id = $2 AND day = $3',
      [JSON.stringify(crossings), eventId, day]
    );
    await client.query('COMMIT');
    return { status: 200, crossings };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

function parseTeamIds(value) {
  if (!Array.isArray(value)) return null;
  const ids = value.map(Number).filter((n) => Number.isInteger(n) && n > 0);
  return [...new Set(ids)].slice(0, 2);
}

// Punt toevoegen.
eventApi.post('/admin/crossings/:day', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  const body = req.body || {};
  if (!isValidLatLng(body)) return res.status(400).json({ error: 'Ongeldig punt.' });
  const crossing = {
    id: crypto.randomUUID(),
    lat: body.lat,
    lng: body.lng,
    name: typeof body.name === 'string' ? body.name.slice(0, 120) : 'oversteekpunt',
    hidden: false,
    teams: parseTeamIds(body.teams) || [],
  };
  crossing.team = crossing.teams[0] ?? null; // oudere lezers blijven werken
  try {
    const out = await withCrossings(req.event.id, day, (list) => [...list, crossing]);
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.status(201).json({ crossing, crossings: out.crossings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Oversteekpunt opslaan mislukt.' });
  }
});

// Punt bijwerken (teamtoewijzing of naam).
eventApi.put('/admin/crossings/:day/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  const body = req.body || {};
  try {
    const out = await withCrossings(req.event.id, day, (list) => {
      const c = list.find((x) => String(x.id) === req.params.id);
      if (!c) return null;
      if (body.teams !== undefined) {
        const teams = parseTeamIds(body.teams);
        if (teams === null) return null;
        c.teams = teams;
        c.team = teams[0] ?? null;
      }
      if (typeof body.name === 'string') c.name = body.name.slice(0, 120);
      return list;
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json({ crossings: out.crossings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Oversteekpunt bijwerken mislukt.' });
  }
});

// Punt verwijderen.
eventApi.delete('/admin/crossings/:day/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  try {
    const out = await withCrossings(req.event.id, day, (list) => {
      const rest = list.filter((x) => String(x.id) !== req.params.id);
      return rest.length === list.length ? null : rest;
    });
    if (out.error) return res.status(out.status).json({ error: out.error });
    res.json({ crossings: out.crossings });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Oversteekpunt verwijderen mislukt.' });
  }
});

// --- Teams ---

const TEAM_COLORS = ['#f97316', '#0ea5e9', '#84cc16', '#e11d48', '#8b5cf6', '#14b8a6', '#a16207', '#64748b'];

eventApi.get('/teams', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, name, color FROM teams WHERE event_id = $1 ORDER BY id',
      [req.event.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Teams ophalen mislukt.' });
  }
});

eventApi.post('/admin/teams', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const { name } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Teamnaam is verplicht.' });
  try {
    const { rows: countRows } = await pool.query(
      'SELECT COUNT(*)::int AS n FROM teams WHERE event_id = $1',
      [req.event.id]
    );
    const color = TEAM_COLORS[countRows[0].n % TEAM_COLORS.length];
    const { rows } = await pool.query(
      'INSERT INTO teams (event_id, name, color) VALUES ($1, $2, $3) RETURNING id, name, color',
      [req.event.id, name.trim(), color]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Team aanmaken mislukt.' });
  }
});

eventApi.delete('/admin/teams/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const teamId = Number(req.params.id);
  try {
    const { rowCount } = await pool.query('DELETE FROM teams WHERE id = $1 AND event_id = $2', [
      teamId,
      req.event.id,
    ]);
    if (rowCount === 0) return res.status(404).json({ error: 'Team niet gevonden.' });
    // Toewijzingen aan dit team weghalen uit alle kruisingen (1 of 2 teams per punt).
    const { rows } = await pool.query(
      'SELECT day, crossings FROM day_routes WHERE event_id = $1 AND crossings IS NOT NULL',
      [req.event.id]
    );
    for (const row of rows) {
      const cleaned = row.crossings.map((c) => {
        const list = (Array.isArray(c.teams) ? c.teams : c.team != null ? [c.team] : []).filter(
          (id) => id !== teamId
        );
        return { ...c, teams: list, team: list[0] ?? null };
      });
      await pool.query('UPDATE day_routes SET crossings = $1 WHERE event_id = $2 AND day = $3', [
        JSON.stringify(cleaned),
        req.event.id,
        row.day,
      ]);
    }
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Team verwijderen mislukt.' });
  }
});

// --- Sponsoracties ---

eventApi.get('/sponsors', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT id, day, lat, lng, action FROM sponsors WHERE event_id = $1 ORDER BY id',
      [req.event.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sponsoracties ophalen mislukt.' });
  }
});

eventApi.post('/sponsors', async (req, res) => {
  try {
    const eventSetting = await getSetting(req.event.id, 'event');
    if (!sponsorOpenFor(eventSetting)) {
      return res.status(403).json({ error: 'De aanmelding voor sponsoracties is gesloten.' });
    }
    const { day, lat, lng, firstName, lastName, email, phone, action } = req.body || {};
    const dayNum = Number(day);
    const fields = [firstName, lastName, email, phone, action];
    if (
      !Number.isInteger(dayNum) || dayNum < 1 || dayNum > 4 ||
      !isValidLatLng({ lat, lng }) ||
      !fields.every((f) => typeof f === 'string' && f.trim().length > 0 && f.length <= 500) ||
      !/^\S+@\S+\.\S+$/.test(email)
    ) {
      return res.status(400).json({ error: 'Vul alle velden in (met een geldig e-mailadres).' });
    }
    const { rows } = await pool.query(
      `INSERT INTO sponsors (event_id, day, lat, lng, first_name, last_name, email, phone, action)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        req.event.id,
        dayNum,
        lat,
        lng,
        firstName.trim(),
        lastName.trim(),
        email.trim(),
        phone.trim(),
        action.trim(),
      ]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Aanmelden mislukt.' });
  }
});

eventApi.get('/admin/sponsors', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, day, lat, lng, first_name, last_name, email, phone, action, created_at
       FROM sponsors WHERE event_id = $1 ORDER BY day, id`,
      [req.event.id]
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sponsoracties ophalen mislukt.' });
  }
});

eventApi.delete('/admin/sponsors/:id', async (req, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM sponsors WHERE id = $1 AND event_id = $2', [
      Number(req.params.id),
      req.event.id,
    ]);
    if (rowCount === 0) return res.status(404).json({ error: 'Aanmelding niet gevonden.' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verwijderen mislukt.' });
  }
});

// --- Pagina's ---
// Events zijn bereikbaar via een pad (a4droute.nl/syncope) én — met
// BASE_DOMAIN ingesteld — via een subdomein (syncope.a4droute.nl).

const BASE_DOMAIN = (process.env.BASE_DOMAIN || '').toLowerCase();

function slugFromHost(req) {
  if (!BASE_DOMAIN) return null;
  const host = String(req.headers.host || '').toLowerCase().split(':')[0];
  if (!host.endsWith('.' + BASE_DOMAIN)) return null;
  const sub = host.slice(0, host.length - BASE_DOMAIN.length - 1);
  if (!sub || sub === 'www' || sub.includes('.') || !SLUG_RE.test(sub) || RESERVED_SLUGS.has(sub)) {
    return null;
  }
  return sub;
}

async function eventExists(slug) {
  if (!pool) return true; // de API meldt databaseproblemen zelf
  try {
    const { rows } = await pool.query('SELECT 1 FROM events WHERE slug = $1', [slug]);
    return rows.length > 0;
  } catch {
    return true;
  }
}

function sendPage(res, file) {
  res.sendFile(path.join(__dirname, 'public', file));
}

app.get('/', async (req, res) => {
  const hostSlug = slugFromHost(req);
  if (hostSlug && (await eventExists(hostSlug))) return sendPage(res, 'index.html');
  sendPage(res, 'landing.html');
});

// /admin: op een event-subdomein het routebeheer van dat event; op het
// hoofddomein (of de onrender-URL) het platformbeheer, waar de
// platformbeheerder nieuwe avondvierdaagsen aanmaakt.
app.get('/admin', async (req, res) => {
  const hostSlug = slugFromHost(req);
  if (hostSlug && (await eventExists(hostSlug))) return sendPage(res, 'admin.html');
  sendPage(res, 'beheer.html');
});

// Op een subdomein staan de overige subpagina's direct in de root.
for (const [route, file] of [
  ['/verkeer', 'verkeer.html'],
  ['/print', 'print.html'],
]) {
  app.get(route, async (req, res) => {
    const hostSlug = slugFromHost(req);
    if (hostSlug && (await eventExists(hostSlug))) return sendPage(res, file);
    res.redirect('/');
  });
}

async function serveEventPage(req, res, file) {
  const slug = String(req.params.slug).toLowerCase();
  if (RESERVED_SLUGS.has(slug) || !SLUG_RE.test(slug)) return res.redirect('/');
  if (!(await eventExists(slug))) return res.redirect('/');
  sendPage(res, file);
}

app.get('/:slug', (req, res) => serveEventPage(req, res, 'index.html'));
app.get('/:slug/verkeer', (req, res) => serveEventPage(req, res, 'verkeer.html'));
app.get('/:slug/admin', (req, res) => serveEventPage(req, res, 'admin.html'));
app.get('/:slug/print', (req, res) => serveEventPage(req, res, 'print.html'));

initDb()
  .catch((err) => console.error('Database-initialisatie mislukt:', err))
  .finally(() => {
    app.listen(port, () => console.log(`Avond4Daagse routeplanner draait op poort ${port}`));
  });
