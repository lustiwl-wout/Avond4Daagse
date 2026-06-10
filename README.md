# 🚶 Avond4Daagse Routeplanner

Webapp om de routes van de Avondvierdaagse van basisschool Syncope (Almere) te plannen op Google Maps, inclusief Street View. Routes worden opgeslagen in een Neon PostgreSQL-database en de app draait op Render.

## Functies

- Kaart van Almere met routeplanning voor **dag 1 t/m 4**, elk met een eigen kleur
- Klik op de kaart om punten toe te voegen — de **wandelroute volgt automatisch de straten** (Google Directions, wandelmodus)
- Punten verslepen (en met rechtermuisklik verwijderen), afstand per route in km
- **Street View**: sleep het gele poppetje op de kaart, of bekijk het laatste punt met één knop
- Routes **opslaan, laden en verwijderen** via Neon

## Lokaal draaien

```bash
npm install
cp .env.example .env   # vul DATABASE_URL en GOOGLE_MAPS_API_KEY in
export $(grep -v '^#' .env | xargs)
npm start              # http://localhost:3000
```

## Stap 1 — Google Maps API-key

1. Ga naar [console.cloud.google.com](https://console.cloud.google.com) en maak een project aan.
2. Schakel onder **APIs & Services → Library** deze twee API's in:
   - **Maps JavaScript API** (kaart + Street View)
   - **Directions API** (wandelroutes over straten)
3. Maak onder **Credentials** een API-key aan.
4. Belangrijk: beperk de key onder *Application restrictions* tot je website-URL (HTTP referrers), bijv. `https://jouw-app.onrender.com/*` — de key is zichtbaar in de browser.
5. Google vraagt een betaalrekening, maar geeft een ruim gratis maandelijks tegoed; voor dit gebruik (een handvol gebruikers) blijf je daar ruim binnen.

## Stap 2 — Neon database

1. Maak een gratis project aan op [neon.tech](https://neon.tech).
2. Kopieer de **connection string** (Dashboard → Connect), iets als
   `postgresql://...@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`.
3. Meer hoef je niet te doen: de app maakt de `routes`-tabel zelf aan bij het opstarten.

## Stap 3 — Deployen op Render

1. Push deze repository naar GitHub.
2. Ga naar [render.com](https://render.com) → **New → Web Service** en koppel de repository (of gebruik **New → Blueprint**, dan wordt `render.yaml` automatisch gelezen).
3. Zet bij **Environment Variables**:
   - `DATABASE_URL` = je Neon-connectiestring
   - `GOOGLE_MAPS_API_KEY` = je Google Maps API-key
4. Deploy — klaar! 🎉

## Techniek

- **Backend:** Node.js + Express (`server.js`) met een kleine REST-API (`/api/routes`)
- **Database:** PostgreSQL op Neon, tabel `routes` met de punten als JSONB
- **Frontend:** vanilla HTML/CSS/JS in `public/`, Google Maps JavaScript API
- De API-key staat niet in de code; de frontend haalt hem op via `/api/config` uit de omgevingsvariabele
