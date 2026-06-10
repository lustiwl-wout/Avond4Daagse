# 🚶 Avond4Daagse Routeplanner

Webapp voor de Avondvierdaagse van basisschool Syncope (Almere). Bezoekers zien de wandelroutes van dag 1 t/m 4 op Google Maps en kunnen onderweg hun eigen positie volgen met GPS. Beheerders tekenen de routes op een aparte adminpagina. Routes worden opgeslagen in een Neon PostgreSQL-database en de app draait op Render.

## Pagina's

| URL | Voor wie | Wat |
|---|---|---|
| `/` | Iedereen | Routes van dag 1 t/m 4 bekijken (elk een eigen kleur), afstanden, GPS aan om jezelf op de kaart te volgen tijdens het lopen, Street View via het gele poppetje |
| `/admin` | Beheer (wachtwoord) | Routes tekenen en beheren |

## Routes beheren (`/admin`)

- Log in met het beheerwachtwoord (`ADMIN_PASSWORD`).
- **Start en finish liggen vast** op één punt dat voor alle vier de dagen geldt. Bij de eerste keer inloggen zoekt de app dit punt automatisch op (instelbaar via de omgevingsvariabele `START_ADDRESS`); daarna kun je de 🏁-vlag nog precies goed slepen. Bezoekers zien alleen de vlag, geen adres.
- Kies een dag en klik op de kaart om tussenpunten toe te voegen — de route loopt **altijd wandelend** van 🏁 via de tussenpunten terug naar 🏁 (Google Directions, wandelmodus) en je ziet live de afstand in km.
- Elk tussenpunt is te bewerken: **sleep** een punt om hem te verplaatsen, **klik** op een punt voor een menu met Street View, verwijderen of een nieuw punt ertussen voegen.
- "Opslaan als route dag X" overschrijft de route van die dag; er is precies één route per dag.

## Lokaal draaien

```bash
npm install
cp .env.example .env   # vul DATABASE_URL, GOOGLE_MAPS_API_KEY en ADMIN_PASSWORD in
export $(grep -v '^#' .env | xargs)
npm start              # http://localhost:3000
```

## Stap 1 — Google Maps API-key

1. Ga naar [console.cloud.google.com](https://console.cloud.google.com) en maak een project aan.
2. Schakel onder **APIs & Services → Library** deze drie API's in:
   - **Maps JavaScript API** (kaart + Street View)
   - **Directions API** (wandelroutes over straten)
   - **Geocoding API** (eenmalig het start/finish-adres opzoeken)
3. Maak onder **Credentials** een API-key aan.
4. Belangrijk: beperk de key onder *Application restrictions* tot je website-URL (HTTP referrers), bijv. `https://jouw-app.onrender.com/*`, en onder *API restrictions* tot de drie bovenstaande API's — de key is zichtbaar in de browser.
5. Google vraagt een betaalrekening, maar geeft een ruim gratis maandelijks tegoed; voor dit gebruik blijf je daar ruim binnen.

## Stap 2 — Neon database

1. Maak een gratis project aan op [neon.tech](https://neon.tech) (kies een EU-regio).
2. Kopieer de **connection string** (Dashboard → Connect), iets als
   `postgresql://...@ep-xxxx.eu-central-1.aws.neon.tech/neondb?sslmode=require`.
3. Meer hoef je niet te doen: de app maakt de `day_routes`-tabel zelf aan bij het opstarten.

## Stap 3 — Deployen op Render

1. Push deze repository naar GitHub.
2. Ga naar [render.com](https://render.com) → **New → Web Service** en koppel de repository (of gebruik **New → Blueprint**, dan wordt `render.yaml` automatisch gelezen).
3. Zet bij **Environment Variables**:
   - `DATABASE_URL` = je Neon-connectiestring
   - `GOOGLE_MAPS_API_KEY` = je Google Maps API-key
   - `ADMIN_PASSWORD` = zelfgekozen wachtwoord voor `/admin`
4. Deploy — klaar! 🎉

> De GPS-functie werkt alleen via HTTPS; op Render is dat automatisch geregeld.

## Techniek

- **Backend:** Node.js + Express (`server.js`) met een kleine REST-API (`/api/routes`)
- **Database:** PostgreSQL op Neon, tabel `day_routes` — één route per dag (1–4) met de klikpunten én het uitgerekende wandelpad als JSONB
- **Frontend:** vanilla HTML/CSS/JS in `public/` met de Google Maps JavaScript API
- Bezoekers krijgen het opgeslagen wandelpad te zien zonder dat daar Directions-aanvragen voor nodig zijn; alleen de adminpagina rekent routes uit
- De API-key staat niet in de code; de frontend haalt hem op via `/api/config` uit de omgevingsvariabele
- Adminacties vereisen het wachtwoord uit `ADMIN_PASSWORD` (header `x-admin-password`)
