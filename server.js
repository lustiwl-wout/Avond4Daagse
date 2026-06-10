const express = require('express');
const path = require('path');
const { Pool } = require('pg');

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

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
    CREATE TABLE IF NOT EXISTS routes (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL,
      day INTEGER NOT NULL CHECK (day BETWEEN 1 AND 4),
      waypoints JSONB NOT NULL,
      distance_m INTEGER,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
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

// De frontend haalt hier de Maps-key op, zodat die niet in de code staat.
app.get('/api/config', (req, res) => {
  res.json({ googleMapsApiKey: process.env.GOOGLE_MAPS_API_KEY || '' });
});

app.get('/api/routes', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { rows } = await pool.query(
      'SELECT id, name, day, waypoints, distance_m, updated_at FROM routes ORDER BY day, name'
    );
    res.json(rows);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Routes ophalen mislukt.' });
  }
});

app.post('/api/routes', async (req, res) => {
  if (!requireDb(res)) return;
  const { name, day, waypoints, distance_m } = req.body;
  if (!name || !day || !Array.isArray(waypoints) || waypoints.length < 2) {
    return res.status(400).json({ error: 'Naam, dag en minimaal 2 punten zijn verplicht.' });
  }
  try {
    const { rows } = await pool.query(
      `INSERT INTO routes (name, day, waypoints, distance_m)
       VALUES ($1, $2, $3, $4)
       RETURNING id, name, day, waypoints, distance_m, updated_at`,
      [name, day, JSON.stringify(waypoints), distance_m || null]
    );
    res.status(201).json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Route opslaan mislukt.' });
  }
});

app.put('/api/routes/:id', async (req, res) => {
  if (!requireDb(res)) return;
  const { name, day, waypoints, distance_m } = req.body;
  if (!name || !day || !Array.isArray(waypoints) || waypoints.length < 2) {
    return res.status(400).json({ error: 'Naam, dag en minimaal 2 punten zijn verplicht.' });
  }
  try {
    const { rows } = await pool.query(
      `UPDATE routes
       SET name = $1, day = $2, waypoints = $3, distance_m = $4, updated_at = now()
       WHERE id = $5
       RETURNING id, name, day, waypoints, distance_m, updated_at`,
      [name, day, JSON.stringify(waypoints), distance_m || null, req.params.id]
    );
    if (rows.length === 0) return res.status(404).json({ error: 'Route niet gevonden.' });
    res.json(rows[0]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Route bijwerken mislukt.' });
  }
});

app.delete('/api/routes/:id', async (req, res) => {
  if (!requireDb(res)) return;
  try {
    const { rowCount } = await pool.query('DELETE FROM routes WHERE id = $1', [req.params.id]);
    if (rowCount === 0) return res.status(404).json({ error: 'Route niet gevonden.' });
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
