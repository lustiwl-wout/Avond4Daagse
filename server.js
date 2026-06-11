const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { distanceM, findConflicts, findCrossings } = require('./geometry');

const app = express();
const port = process.env.PORT || 3000;

// Vast start- en eindpunt van alle routes. Het adres wordt alleen op de
// beheerpagina gebruikt om de plek eenmalig op te zoeken; bezoekers zien
// alleen een "Start & finish"-markering zonder adres.
const START_ADDRESS = process.env.START_ADDRESS || 'Trombonestraat 33, Almere, Nederland';

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Verkeersregelaars werken vanaf /verkeer (geen wachtwoord nodig).
app.get('/verkeer', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'verkeer.html'));
});

// Printversie van het verkeersregelaarsplan.
app.get('/print', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'print.html'));
});

let pool = null;
if (process.env.DATABASE_URL) {
  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });
} else {
  console.warn('DATABASE_URL is niet gezet — routes opslaan werkt niet.');
}

async function initDb() {
  if (!pool) return;
  await pool.query(`
    CREATE TABLE IF NOT EXISTS day_routes (
      day INTEGER PRIMARY KEY CHECK (day BETWEEN 1 AND 4),
      waypoints JSONB NOT NULL,
      path JSONB,
      distance_m INTEGER,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value JSONB NOT NULL,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('ALTER TABLE day_routes ADD COLUMN IF NOT EXISTS crossings JSONB');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS teams (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      color TEXT NOT NULL,
      mode TEXT NOT NULL DEFAULT 'BICYCLING'
    )
  `);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS team_routes (
      team_id INTEGER NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
      day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 4),
      path JSONB,
      distance_m INTEGER,
      conflicts JSONB,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      PRIMARY KEY (team_id, day)
    )
  `);
  await pool.query('ALTER TABLE team_routes ADD COLUMN IF NOT EXISTS timing JSONB');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS route_drafts (
      id SERIAL PRIMARY KEY,
      day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 4),
      waypoints JSONB NOT NULL,
      path JSONB,
      distance_m INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
  await pool.query('CREATE INDEX IF NOT EXISTS route_drafts_day_idx ON route_drafts (day, id DESC)');
  await pool.query('ALTER TABLE day_routes ADD COLUMN IF NOT EXISTS pause JSONB');
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sponsors (
      id SERIAL PRIMARY KEY,
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
}

async function getSetting(key) {
  if (!pool) return null;
  const { rows } = await pool.query('SELECT value FROM settings WHERE key = $1', [key]);
  return rows.length > 0 ? rows[0].value : null;
}

function requireDb(res) {
  if (!pool) {
    res.status(503).json({ error: 'Database niet geconfigureerd (DATABASE_URL ontbreekt).' });
    return false;
  }
  return true;
}

function requireAdmin(req, res) {
  const expected = process.env.ADMIN_PASSWORD || '';
  if (!expected) {
    res.status(503).json({ error: 'ADMIN_PASSWORD is niet ingesteld op de server.' });
    return false;
  }
  const given = req.get('x-admin-password') || '';
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
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

// Datum in Nederland (de eventdatum bepaalt of sponsoracties nog open staan).
function todayNl() {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Amsterdam' }).format(new Date());
}

async function isSponsorOpen() {
  const event = await getSetting('event');
  if (!event || !event.startDate) return false;
  return todayNl() < event.startDate;
}

// Publieke configuratie: Street View-key, start/finish-punt (zonder adres),
// planningsinstellingen en de eventdatum/sponsorstatus.
app.get('/api/config', async (req, res) => {
  let startFinish = null;
  let vrSettings = null;
  let event = null;
  let sponsorOpen = false;
  try {
    startFinish = await getSetting('start_finish');
    vrSettings = await getSetting('vr_settings');
    event = await getSetting('event');
    sponsorOpen = await isSponsorOpen();
  } catch (err) {
    console.error('Instellingen ophalen mislukt:', err);
  }
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    startFinish,
    vrSettings,
    eventStart: event ? event.startDate : null,
    sponsorOpen,
  });
});

// Admin: eerste loopdag instellen; tot die datum staat de sponsoractie-
// aanmelding op de bezoekerspagina open.
app.put('/api/admin/event-date', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const { startDate } = req.body || {};
  if (startDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(String(startDate))) {
    return res.status(400).json({ error: 'Ongeldige datum.' });
  }
  try {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at) VALUES ('event', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ startDate })]
    );
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Datum opslaan mislukt.' });
  }
});

// Admin: pauzepunt van een dag plaatsen of weghalen.
app.put('/api/admin/pause/:day', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  const { pause } = req.body || {};
  if (pause !== null && !isValidLatLng(pause)) {
    return res.status(400).json({ error: 'Ongeldig pauzepunt.' });
  }
  try {
    const { rowCount } = await pool.query(
      'UPDATE day_routes SET pause = $1, updated_at = now() WHERE day = $2',
      [pause ? JSON.stringify(pause) : null, day]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Publiceer eerst de route van deze dag.' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Pauzepunt opslaan mislukt.' });
  }
});

// --- Sponsoracties: bezoekers melden vóór het evenement een actie aan ---

// Publiek: alleen plek en actie (geen persoonsgegevens).
app.get('/api/sponsors', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { rows } = await pool.query('SELECT id, day, lat, lng, action FROM sponsors ORDER BY id');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sponsoracties ophalen mislukt.' });
  }
});

app.post('/api/sponsors', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    if (!(await isSponsorOpen())) {
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
      `INSERT INTO sponsors (day, lat, lng, first_name, last_name, email, phone, action)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [dayNum, lat, lng, firstName.trim(), lastName.trim(), email.trim(), phone.trim(), action.trim()]
    );
    res.status(201).json({ id: rows[0].id });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Aanmelden mislukt.' });
  }
});

// Admin: volledige gegevens inzien en aanmeldingen verwijderen.
app.get('/api/admin/sponsors', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const { rows } = await pool.query(
      `SELECT id, day, lat, lng, first_name, last_name, email, phone, action, created_at
       FROM sponsors ORDER BY day, id`
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Sponsoracties ophalen mislukt.' });
  }
});

app.delete('/api/admin/sponsors/:id', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM sponsors WHERE id = $1', [Number(req.params.id)]);
    if (rowCount === 0) return res.status(404).json({ error: 'Aanmelding niet gevonden.' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Verwijderen mislukt.' });
  }
});

// Admin: planningsinstellingen (tempo's, passeertijd, marge) opslaan.
app.put('/api/admin/vr-settings', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const { walkKmh, passMin, bikeKmh, marginMin } = req.body || {};
  const values = [walkKmh, passMin, bikeKmh, marginMin];
  if (!values.every((v) => typeof v === 'number' && v >= 0 && v < 100)) {
    return res.status(400).json({ error: 'Ongeldige planningsinstellingen.' });
  }
  try {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('vr_settings', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ walkKmh, passMin, bikeKmh, marginMin })]
    );
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Instellingen opslaan mislukt.' });
  }
});

// Wachtwoordcontrole voor de adminpagina.
app.get('/api/admin/check', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.status(204).end();
});

// Alleen voor de adminpagina: het adres om eenmalig te geocoderen.
app.get('/api/admin/config', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.json({ startAddress: START_ADDRESS });
});

// Admin: start/finish-punt vastleggen.
app.put('/api/admin/start-finish', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const { lat, lng } = req.body || {};
  if (typeof lat !== 'number' || typeof lng !== 'number') {
    return res.status(400).json({ error: 'lat en lng zijn verplicht.' });
  }
  try {
    await pool.query(
      `INSERT INTO settings (key, value, updated_at)
       VALUES ('start_finish', $1, now())
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify({ lat, lng })]
    );
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Start/finish opslaan mislukt.' });
  }
});

// Publiek: alle dagroutes voor de bezoekerspagina.
app.get('/api/routes', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { rows } = await pool.query(
      'SELECT day, waypoints, path, distance_m, crossings, pause, updated_at FROM day_routes ORDER BY day'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Routes ophalen mislukt.' });
  }
});

// --- Conceptversies: elke wijziging wordt automatisch bewaard ---

// Laatste concept per dag (plus aantal bewaarde wijzigingen).
app.get('/api/admin/drafts', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  try {
    const { rows } = await pool.query(
      `SELECT DISTINCT ON (day) day, waypoints, path, distance_m
       FROM route_drafts ORDER BY day, id DESC`
    );
    const { rows: counts } = await pool.query(
      'SELECT day, COUNT(*)::int AS count FROM route_drafts GROUP BY day'
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

// Nieuwe conceptversie bewaren (mag ook een lege route zijn).
app.post('/api/admin/drafts/:day', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  const { waypoints, path: routePath, distance_m } = req.body;
  if (!Array.isArray(waypoints) || !waypoints.every(isValidLatLng)) {
    return res.status(400).json({ error: 'Ongeldige punten.' });
  }
  try {
    await pool.query(
      'INSERT INTO route_drafts (day, waypoints, path, distance_m) VALUES ($1, $2, $3, $4)',
      [day, JSON.stringify(waypoints), routePath ? JSON.stringify(routePath) : null, distance_m || null]
    );
    // Geschiedenis beperken tot de laatste 100 wijzigingen per dag.
    await pool.query(
      `DELETE FROM route_drafts WHERE day = $1 AND id NOT IN
       (SELECT id FROM route_drafts WHERE day = $1 ORDER BY id DESC LIMIT 100)`,
      [day]
    );
    const { rows } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM route_drafts WHERE day = $1',
      [day]
    );
    res.json({ count: rows[0].count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Concept bewaren mislukt.' });
  }
});

// Laatste wijziging terugdraaien: nieuwste concept weg, vorige terug.
app.delete('/api/admin/drafts/:day/latest', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  try {
    await pool.query(
      `DELETE FROM route_drafts WHERE id =
       (SELECT id FROM route_drafts WHERE day = $1 ORDER BY id DESC LIMIT 1)`,
      [day]
    );
    const { rows } = await pool.query(
      'SELECT day, waypoints, path, distance_m FROM route_drafts WHERE day = $1 ORDER BY id DESC LIMIT 1',
      [day]
    );
    const { rows: counts } = await pool.query(
      'SELECT COUNT(*)::int AS count FROM route_drafts WHERE day = $1',
      [day]
    );
    res.json({ draft: rows[0] || null, count: counts[0].count });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Terugdraaien mislukt.' });
  }
});

// Admin: route voor een dag definitief publiceren; alle conceptversies
// worden daarna gewist. waypoints = de tussenpunten; start/finish ligt vast.
app.put('/api/routes/:day', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  const { waypoints, path: routePath, distance_m } = req.body;
  if (!Array.isArray(waypoints) || waypoints.length < 1 || !waypoints.every(isValidLatLng)) {
    return res.status(400).json({ error: 'Een route heeft minimaal 1 tussenpunt nodig.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO day_routes (day, waypoints, path, distance_m, updated_at)
       VALUES ($1, $2, $3, $4, now())
       ON CONFLICT (day) DO UPDATE
         SET waypoints = EXCLUDED.waypoints,
             path = EXCLUDED.path,
             distance_m = EXCLUDED.distance_m,
             updated_at = now()
       RETURNING day, waypoints, path, distance_m, updated_at`,
      [
        day,
        JSON.stringify(waypoints),
        routePath ? JSON.stringify(routePath) : null,
        distance_m || null,
      ]
    );
    // Definitief: tussenversies zijn niet meer nodig.
    await pool.query('DELETE FROM route_drafts WHERE day = $1', [day]);
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Route opslaan mislukt.' });
  }
});

// Admin: route voor een dag verwijderen.
app.delete('/api/routes/:day', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM day_routes WHERE day = $1', [day]);
    await pool.query('DELETE FROM route_drafts WHERE day = $1', [day]);
    if (rowCount === 0) return res.status(404).json({ error: 'Geen route voor deze dag.' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Route verwijderen mislukt.' });
  }
});

// --- OpenStreetMap-diensten: routes (OSRM) en adressen (Nominatim) ---

const OSM_UA = 'Avond4Daagse-routeplanner/1.0 (schoolproject basisschool Almere)';
const OSRM_PROFILES = {
  foot: 'https://routing.openstreetmap.de/routed-foot',
  bike: 'https://routing.openstreetmap.de/routed-bike',
};

// Route berekenen via OSRM (de router van openstreetmap.org): kent alle
// voet- en fietspaden. De wandelroute gebruikt 'foot', teamroutes 'bike'.
app.post('/api/admin/route', async (req, res) => {
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

// Nominatim (OpenStreetMap-geocoding) met nette throttling (max ~1 verzoek
// per seconde, zoals hun gebruiksvoorwaarden vragen) en een cache.
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

// Adres opzoeken voor het vaste start/finish-punt (alleen admin).
app.get('/api/admin/geocode', async (req, res) => {
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

// --- Verkeersregelaars: kruisingdetectie, teams en teamroutes ---

// Wegtypen waar verkeer kan rijden (auto's, fietsen, bussen).
const HIGHWAY_FILTER =
  '^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|' +
  'tertiary|tertiary_link|unclassified|residential|living_street|service|busway|cycleway|track)$';

// Wegendata (inclusief fiets- en wandelinfrastructuur) komt van OpenStreetMap
// via Overpass — dé kaartbron die voor voetgangers gemaakt is. Meerdere
// servers, want de publieke zijn soms even druk.
async function fetchOsmWays(walkPath) {
  const margin = 0.0015;
  const lats = walkPath.map((p) => p.lat);
  const lngs = walkPath.map((p) => p.lng);
  const bbox = [
    Math.min(...lats) - margin,
    Math.min(...lngs) - margin,
    Math.max(...lats) + margin,
    Math.max(...lngs) + margin,
  ].join(',');
  const query = `[out:json][timeout:25];way["highway"~"${HIGHWAY_FILTER}"](${bbox});out geom;`;
  const endpoints = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
  ];
  for (const endpoint of endpoints) {
    try {
      const resp = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': OSM_UA },
        body: 'data=' + encodeURIComponent(query),
      });
      if (resp.ok) {
        const osm = await resp.json();
        return (osm.elements || []).filter((e) => e.type === 'way' && e.geometry);
      }
      console.error(`Overpass ${endpoint} antwoordde ${resp.status}`);
    } catch (err) {
      console.error(`Overpass ${endpoint} niet bereikbaar:`, err.message);
    }
  }
  throw new Error('wegendata van OpenStreetMap is tijdelijk niet beschikbaar, probeer het zo opnieuw');
}

// Admin: detecteer alle kruisingen langs de wandelroute. De wegendata
// (inclusief fietspaden en zijstraten) komt van OpenStreetMap; eerder
// verborgen punten, teamtoewijzingen en handmatig toegevoegde punten
// blijven behouden.
app.post('/api/admin/crossings/:day', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  const { path: walkPath } = req.body;
  if (!Array.isArray(walkPath) || walkPath.length < 2 || !walkPath.every(isValidLatLng)) {
    return res.status(400).json({ error: 'Geen routepad meegestuurd. Teken eerst de route.' });
  }
  try {
    const { rows: existingRows } = await pool.query(
      'SELECT crossings FROM day_routes WHERE day = $1',
      [day]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Sla eerst de route van deze dag op.' });
    }
    const existing = existingRows[0].crossings || [];

    const ways = await fetchOsmWays(walkPath);
    const detected = findCrossings(walkPath, ways);

    const crossings = detected.map((c) => {
      const match = existing.find((e) => distanceM(e, c) < 25);
      return {
        id: `${Math.round(c.lat * 1e5)}x${Math.round(c.lng * 1e5)}`,
        lat: c.lat,
        lng: c.lng,
        name: c.name,
        src: 'osm', // markeert dat dit punt met de OSM-detectie is gevonden
        hidden: match ? !!match.hidden : false,
        team: match && match.team != null ? match.team : null,
      };
    });
    // Handmatig toegevoegde punten blijven altijd staan (tenzij er nu een
    // gedetecteerd punt vlakbij ligt).
    for (const e of existing) {
      if (e.manual && !crossings.some((c) => distanceM(c, e) < 25)) crossings.push(e);
    }

    await pool.query('UPDATE day_routes SET crossings = $1, updated_at = now() WHERE day = $2', [
      JSON.stringify(crossings),
      day,
    ]);
    res.json(crossings);
  } catch (err) {
    console.error('Kruisingdetectie mislukt:', err);
    res.status(502).json({ error: `Kruisingen detecteren mislukt: ${err.message}` });
  }
});

// Admin: kruisingen bijwerken (verbergen/tonen, teamtoewijzing).
app.put('/api/admin/crossings/:day', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  const { crossings } = req.body;
  if (!Array.isArray(crossings) || !crossings.every(isValidLatLng)) {
    return res.status(400).json({ error: 'Ongeldige kruisingenlijst.' });
  }
  try {
    const { rowCount } = await pool.query(
      'UPDATE day_routes SET crossings = $1, updated_at = now() WHERE day = $2',
      [JSON.stringify(crossings), day]
    );
    if (rowCount === 0) return res.status(404).json({ error: 'Geen route voor deze dag.' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Kruisingen opslaan mislukt.' });
  }
});

const TEAM_COLORS = ['#f97316', '#0ea5e9', '#84cc16', '#e11d48', '#8b5cf6', '#14b8a6', '#a16207', '#64748b'];

// Publiek: teams (de verkeersregelaarsweergave heeft geen wachtwoord).
app.get('/api/teams', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { rows } = await pool.query('SELECT id, name, color, mode FROM teams ORDER BY id');
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Teams ophalen mislukt.' });
  }
});

app.post('/api/admin/teams', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const { name } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Teamnaam is verplicht.' });
  try {
    const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS n FROM teams');
    const color = TEAM_COLORS[countRows[0].n % TEAM_COLORS.length];
    // Verkeersregelaars fietsen altijd.
    const { rows } = await pool.query(
      "INSERT INTO teams (name, color, mode) VALUES ($1, $2, 'BICYCLING') RETURNING id, name, color, mode",
      [name.trim(), color]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Team aanmaken mislukt.' });
  }
});

app.put('/api/admin/teams/:id', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const { name } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Teamnaam is verplicht.' });
  try {
    const { rows } = await pool.query(
      'UPDATE teams SET name = $1 WHERE id = $2 RETURNING id, name, color, mode',
      [name.trim(), req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Team niet gevonden.' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Team bijwerken mislukt.' });
  }
});

app.delete('/api/admin/teams/:id', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const teamId = Number(req.params.id);
  try {
    const { rowCount } = await pool.query('DELETE FROM teams WHERE id = $1', [teamId]);
    if (rowCount === 0) return res.status(404).json({ error: 'Team niet gevonden.' });
    // Toewijzingen aan dit team weghalen uit alle kruisingen.
    const { rows } = await pool.query('SELECT day, crossings FROM day_routes WHERE crossings IS NOT NULL');
    for (const row of rows) {
      const cleaned = row.crossings.map((c) => (c.team === teamId ? { ...c, team: null } : c));
      await pool.query('UPDATE day_routes SET crossings = $1 WHERE day = $2', [
        JSON.stringify(cleaned),
        row.day,
      ]);
    }
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Team verwijderen mislukt.' });
  }
});

// Publiek: alle teamroutes (voor de verkeersregelaarsweergave).
app.get('/api/team-routes', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { rows } = await pool.query(
      'SELECT team_id, day, path, distance_m, conflicts, timing, updated_at FROM team_routes'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Teamroutes ophalen mislukt.' });
  }
});

// Admin: controleer of een teamroute de wandelroute van die dag doorkruist.
app.post('/api/admin/conflicts/:day', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  const { path: teamPath, exclude } = req.body;
  if (!Array.isArray(teamPath) || teamPath.length < 2 || !teamPath.every(isValidLatLng)) {
    return res.status(400).json({ error: 'Ongeldig teamroutepad.' });
  }
  try {
    const { rows } = await pool.query('SELECT path FROM day_routes WHERE day = $1', [day]);
    if (rows.length === 0 || !rows[0].path) {
      return res.status(404).json({ error: 'Geen wandelroute voor deze dag.' });
    }
    const excludePoints = Array.isArray(exclude) ? exclude.filter(isValidLatLng) : [];
    const conflicts = findConflicts(teamPath, rows[0].path, excludePoints);
    res.json({ conflicts });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Conflictcontrole mislukt.' });
  }
});

// Admin: teamroute voor een dag opslaan (path null wist de route).
app.put('/api/admin/team-route/:teamId/:day', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  const teamId = Number(req.params.teamId);
  const { path: teamPath, distance_m, conflicts, timing } = req.body;
  try {
    if (!teamPath) {
      await pool.query('DELETE FROM team_routes WHERE team_id = $1 AND day = $2', [teamId, day]);
      return res.status(204).end();
    }
    if (!Array.isArray(teamPath) || !teamPath.every(isValidLatLng)) {
      return res.status(400).json({ error: 'Ongeldig teamroutepad.' });
    }
    await pool.query(
      `INSERT INTO team_routes (team_id, day, path, distance_m, conflicts, timing, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, now())
       ON CONFLICT (team_id, day) DO UPDATE
         SET path = EXCLUDED.path, distance_m = EXCLUDED.distance_m,
             conflicts = EXCLUDED.conflicts, timing = EXCLUDED.timing, updated_at = now()`,
      [
        teamId,
        day,
        JSON.stringify(teamPath),
        distance_m || null,
        JSON.stringify(conflicts || []),
        timing ? JSON.stringify(timing) : null,
      ]
    );
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Teamroute opslaan mislukt.' });
  }
});

initDb()
  .catch((err) => console.error('Database-initialisatie mislukt:', err))
  .finally(() => {
    app.listen(port, () => console.log(`Avond4Daagse routeplanner draait op poort ${port}`));
  });
