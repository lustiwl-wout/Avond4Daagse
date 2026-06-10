const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { distanceM, findConflicts, pointToPath, densifyPath } = require('./geometry');

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

// Publieke configuratie: Maps-key, start/finish-punt (zonder adres) en
// planningsinstellingen voor de verkeersregelaars.
app.get('/api/config', async (req, res) => {
  let startFinish = null;
  let vrSettings = null;
  try {
    startFinish = await getSetting('start_finish');
    vrSettings = await getSetting('vr_settings');
  } catch (err) {
    console.error('Instellingen ophalen mislukt:', err);
  }
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    startFinish,
    vrSettings,
  });
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
      'SELECT day, waypoints, path, distance_m, crossings, updated_at FROM day_routes ORDER BY day'
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

// --- Verkeersregelaars: kruisingdetectie, teams en teamroutes ---

// Server-side Google-key (zonder website-restrictie) voor de Roads API en
// Geocoding API. Dit is een ándere key dan GOOGLE_MAPS_API_KEY (de browser-key).
const SERVER_KEY = process.env.GOOGLE_MAPS_SERVER_KEY || '';

// Snapt een reeks punten aan het wegennetwerk van Google (Roads API).
// Maximaal 100 punten per aanroep, dus in delen met 1 punt overlap.
async function snapToRoads(points) {
  const snapped = [];
  for (let start = 0; start < points.length - 1; start += 99) {
    const batch = points.slice(start, start + 100);
    const pathParam = batch.map((p) => `${p.lat.toFixed(6)},${p.lng.toFixed(6)}`).join('|');
    const url =
      'https://roads.googleapis.com/v1/snapToRoads?interpolate=true' +
      `&path=${encodeURIComponent(pathParam)}&key=${SERVER_KEY}`;
    const resp = await fetch(url);
    const data = await resp.json();
    if (!resp.ok || data.error) {
      throw new Error((data.error && data.error.message) || `Roads API gaf status ${resp.status}`);
    }
    snapped.push(...(data.snappedPoints || []));
  }
  return snapped;
}

// Straatnaam bij een punt via de Google Geocoding API.
async function reverseStreetName(p) {
  const url =
    'https://maps.googleapis.com/maps/api/geocode/json' +
    `?latlng=${p.lat},${p.lng}&language=nl&key=${SERVER_KEY}`;
  const resp = await fetch(url);
  const data = await resp.json();
  const result = (data.results || [])[0];
  if (!result) return 'kruising';
  const route = result.address_components.find((c) => c.types.includes('route'));
  return route ? route.long_name : result.formatted_address.split(',')[0];
}

// Admin: detecteer alle kruisingen langs de wandelroute, volledig via Google.
// De route wordt gesnapt aan Googles wegennetwerk (Roads API); elk punt waar
// het wegsegment-ID wisselt is een knooppunt met een andere weg. Namen komen
// van de Google Geocoding API. Eerder verborgen punten, teamtoewijzingen en
// handmatig toegevoegde punten blijven behouden.
app.post('/api/admin/crossings/:day', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  if (!SERVER_KEY) {
    return res.status(503).json({
      error:
        'GOOGLE_MAPS_SERVER_KEY is niet ingesteld. Maak in Google Cloud een tweede (server-)key aan met Roads API + Geocoding API en zet die als omgevingsvariabele.',
    });
  }
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

    const snapped = await snapToRoads(densifyPath(walkPath, 40));

    // Overgang naar een ander wegsegment = knooppunt/kruising.
    const junctions = [];
    for (let i = 1; i < snapped.length; i++) {
      if (!snapped[i].placeId || snapped[i].placeId === snapped[i - 1].placeId) continue;
      const a = snapped[i - 1].location;
      const b = snapped[i].location;
      const point = { lat: (a.latitude + b.latitude) / 2, lng: (a.longitude + b.longitude) / 2 };
      const onPath = pointToPath(walkPath, point);
      if (onPath.dist > 30) continue; // ver van de route gesnapt: overslaan
      junctions.push({ ...point, along: onPath.along });
    }

    // Knooppunten binnen 30 m samenvoegen tot één oversteekpunt.
    junctions.sort((a, b) => a.along - b.along);
    const clusters = [];
    for (const j of junctions) {
      if (!clusters.some((c) => distanceM(c, j) < 30)) clusters.push(j);
    }

    const crossings = [];
    for (const c of clusters) {
      const match = existing.find((e) => distanceM(e, c) < 25);
      crossings.push({
        id: `${Math.round(c.lat * 1e5)}x${Math.round(c.lng * 1e5)}`,
        lat: c.lat,
        lng: c.lng,
        name: match && match.name ? match.name : await reverseStreetName(c),
        hidden: match ? !!match.hidden : false,
        team: match && match.team != null ? match.team : null,
      });
    }
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
