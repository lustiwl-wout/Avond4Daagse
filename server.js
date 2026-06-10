const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

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

// De frontend haalt hier de Maps-key op, zodat die niet in de code staat.
app.get('/api/config', (req, res) => {
  res.json({ googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '' });
});

// Wachtwoordcontrole voor de adminpagina.
app.get('/api/admin/check', (req, res) => {
  if (!requireAdmin(req, res)) return;
  res.status(204).end();
});

// Publiek: alle dagroutes voor de bezoekerspagina.
app.get('/api/routes', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { rows } = await pool.query(
      'SELECT day, waypoints, path, distance_m, updated_at FROM day_routes ORDER BY day'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Routes ophalen mislukt.' });
  }
});

// Admin: route voor een dag opslaan of overschrijven.
app.put('/api/routes/:day', async (req, res) => {
  if (!requireDb(res)) return;
  if (!requireAdmin(req, res)) return;
  const day = parseDay(req, res);
  if (day === null) return;
  const { waypoints, path: routePath, distance_m } = req.body;
  if (!Array.isArray(waypoints) || waypoints.length < 2) {
    return res.status(400).json({ error: 'Een route heeft minimaal 2 punten nodig.' });
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

initDb()
  .catch((err) => console.error('Database-initialisatie mislukt:', err))
  .finally(() => {
    app.listen(port, () => console.log(`Avond4Daagse routeplanner draait op poort ${port}`));
  });
