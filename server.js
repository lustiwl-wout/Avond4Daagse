const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');
const { distanceM, findCrossings, findConflicts } = require('./geometry');

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

// Publieke configuratie: Maps-key en het start/finish-punt (zonder adres).
app.get('/api/config', async (req, res) => {
  let startFinish = null;
  try {
    startFinish = await getSetting('start_finish');
  } catch (err) {
    console.error('Instelling start_finish ophalen mislukt:', err);
  }
  res.json({
    googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '',
    startFinish,
  });
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

// Admin: route voor een dag opslaan of overschrijven.
// waypoints = de tussenpunten; start en finish liggen vast.
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
    if (rowCount === 0) return res.status(404).json({ error: 'Geen route voor deze dag.' });
    res.status(204).end();
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Route verwijderen mislukt.' });
  }
});

// --- Verkeersregelaars: kruisingdetectie, teams en teamroutes ---

// Wegtypen waar verkeer kan rijden (auto's, fietsen, bussen).
const HIGHWAY_FILTER =
  '^(motorway|motorway_link|trunk|trunk_link|primary|primary_link|secondary|secondary_link|' +
  'tertiary|tertiary_link|unclassified|residential|living_street|service|busway|cycleway|track)$';

// Admin: detecteer alle oversteekpunten van de wandelroute met wegen en
// fietspaden (wegendata via OpenStreetMap/Overpass). Eerder verborgen punten
// en teamtoewijzingen blijven behouden op basis van nabijheid.
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
    const overpass = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
    });
    if (!overpass.ok) {
      return res
        .status(502)
        .json({ error: 'Wegendata ophalen mislukt (Overpass). Probeer het over een minuut opnieuw.' });
    }
    const osm = await overpass.json();
    const ways = (osm.elements || []).filter((e) => e.type === 'way' && e.geometry);
    const detected = findCrossings(walkPath, ways);

    const { rows: existingRows } = await pool.query(
      'SELECT crossings FROM day_routes WHERE day = $1',
      [day]
    );
    if (existingRows.length === 0) {
      return res.status(404).json({ error: 'Sla eerst de route van deze dag op.' });
    }
    const existing = existingRows[0].crossings || [];
    const crossings = detected.map((c) => {
      const match = existing.find((e) => distanceM(e, c) < 20);
      return {
        id: `${Math.round(c.lat * 1e5)}x${Math.round(c.lng * 1e5)}`,
        lat: c.lat,
        lng: c.lng,
        name: c.name,
        hidden: match ? !!match.hidden : false,
        team: match && match.team != null ? match.team : null,
      };
    });
    await pool.query('UPDATE day_routes SET crossings = $1, updated_at = now() WHERE day = $2', [
      JSON.stringify(crossings),
      day,
    ]);
    res.json(crossings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Kruisingen detecteren mislukt.' });
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
const TEAM_MODES = ['WALKING', 'BICYCLING', 'DRIVING'];

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
  const { name, mode } = req.body;
  if (!name || typeof name !== 'string') return res.status(400).json({ error: 'Teamnaam is verplicht.' });
  const teamMode = TEAM_MODES.includes(mode) ? mode : 'BICYCLING';
  try {
    const { rows: countRows } = await pool.query('SELECT COUNT(*)::int AS n FROM teams');
    const color = TEAM_COLORS[countRows[0].n % TEAM_COLORS.length];
    const { rows } = await pool.query(
      'INSERT INTO teams (name, color, mode) VALUES ($1, $2, $3) RETURNING id, name, color, mode',
      [name.trim(), color, teamMode]
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
  const { name, mode } = req.body;
  if (mode && !TEAM_MODES.includes(mode)) return res.status(400).json({ error: 'Ongeldig vervoersmiddel.' });
  try {
    const { rows } = await pool.query(
      `UPDATE teams SET name = COALESCE($1, name), mode = COALESCE($2, mode)
       WHERE id = $3 RETURNING id, name, color, mode`,
      [name || null, mode || null, req.params.id]
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
      'SELECT team_id, day, path, distance_m, conflicts, updated_at FROM team_routes'
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
  const { path: teamPath, distance_m, conflicts } = req.body;
  try {
    if (!teamPath) {
      await pool.query('DELETE FROM team_routes WHERE team_id = $1 AND day = $2', [teamId, day]);
      return res.status(204).end();
    }
    if (!Array.isArray(teamPath) || !teamPath.every(isValidLatLng)) {
      return res.status(400).json({ error: 'Ongeldig teamroutepad.' });
    }
    await pool.query(
      `INSERT INTO team_routes (team_id, day, path, distance_m, conflicts, updated_at)
       VALUES ($1, $2, $3, $4, $5, now())
       ON CONFLICT (team_id, day) DO UPDATE
         SET path = EXCLUDED.path, distance_m = EXCLUDED.distance_m,
             conflicts = EXCLUDED.conflicts, updated_at = now()`,
      [teamId, day, JSON.stringify(teamPath), distance_m || null, JSON.stringify(conflicts || [])]
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
