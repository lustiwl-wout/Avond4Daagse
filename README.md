# 🚶 Avond4Daagse Routeplanner

Webapp voor de Avondvierdaagse van basisschool Syncope (Almere). Bezoekers zien de wandelroutes van dag 1 t/m 4 op Google Maps en kunnen onderweg hun eigen positie volgen met GPS. Beheerders tekenen de routes op een aparte adminpagina. Routes worden opgeslagen in een Neon PostgreSQL-database en de app draait op Render.

## Pagina's

| URL | Voor wie | Wat |
|---|---|---|
| `/` | Iedereen | Routes van dag 1 t/m 4 bekijken (elk een eigen kleur), afstanden, GPS aan om jezelf op de kaart te volgen tijdens het lopen, Street View via het gele poppetje. Mobiel-eerst opgezet. |
| `/verkeer` | Verkeersregelaars (geen wachtwoord) | Team kiezen, eigen posten + tijdschema zien, GPS starten en per post navigeren via Google Maps. Mobiel-eerst opgezet. |
| `/admin` | Beheer (wachtwoord) | Routes tekenen (ook al lopend vastleggen via GPS), kruisingen, teams en planning beheren |
| `/print?day=N` | Beheer | Printversie van het verkeersregelaarsplan per dag |

## Routes beheren (`/admin`)

- Log in met het beheerwachtwoord (`ADMIN_PASSWORD`).
- **Start en finish liggen vast** op één punt dat voor alle vier de dagen geldt. Bij de eerste keer inloggen zoekt de app dit punt automatisch op (instelbaar via de omgevingsvariabele `START_ADDRESS`); daarna kun je de 🏁-vlag nog precies goed slepen. Bezoekers zien alleen de vlag, geen adres.
- Kies een dag en klik op de kaart om tussenpunten toe te voegen — de route loopt **altijd wandelend** van 🏁 via de tussenpunten terug naar 🏁 (Google Directions, wandelmodus) en je ziet live de afstand in km.
- Elk tussenpunt is te bewerken: **sleep** een punt om hem te verplaatsen, **klik** op een punt voor een menu met Street View, verwijderen of een nieuw punt ertussen voegen.
- **Automatisch bewaard als concept**: elke wijziging (punt erbij, verslepen, verwijderen, wissen) wordt direct als conceptversie bewaard — er is geen opslaanknop nodig en je kunt met "Herstel vorige versie" stap voor stap terug. Bezoekers zien concepten niet.
- **"Maak route dag X definitief"** publiceert de route voor bezoekers en ruimt alle tussenversies op; er is precies één definitieve route per dag.
- **Pauzepunt**: markeer per dag waar de stoet pauze houdt (knop "Pauzepunt plaatsen", daarna klikken op de route; versleepbaar en blijft altijd op de route). Zichtbaar voor bezoekers, verkeersregelaars en op de printversie.

## Sponsoracties (promotie vóór het evenement)

- Stel in de admin (Sponsoracties & evenement) de **eerste loopdag** in. Tot die datum staat op de bezoekerspagina de oproep *"Wij zoeken nog sponsoren — heb jij een leuke actie om onze avondvierdaagse geweldig te maken?"*.
- Bezoekers kiezen een plek op de route en laten voornaam, achternaam, e-mail, telefoon en hun actie achter. De plek verschijnt als ster op de kaart (publiek alleen de actie, geen persoonsgegevens).
- Vanaf de eerste loopdag verdwijnt de aanmeldoptie automatisch; de sterren blijven zichtbaar.
- De admin ziet alle aanmeldingen met contactgegevens en kan ze verwijderen.
- **Vastlegmodus (🎯)**: leg de route vast terwijl je hem zelf loopt — start de GPS op je telefoon en tik bij elke afslag op "Leg punt vast op mijn locatie". De route wordt direct wandelend doorgerekend en punten blijven aanklikbaar en versleepbaar.

## Verkeersregelaars

**In de admin** (`/admin` → modus "🦺 Verkeersregelaars"):

- **Oversteekpunten zet de verkeersleider zelf op de kaart**: klik in de verkeersmodus op de route waar verkeersregelaars moeten staan. Het punt snapt naar de route en krijgt automatisch de straatnaam (Nominatim). De punten verschijnen als genummerde ruitjes, in routevolgorde.
- Klik op een ruitje om een **team toe te wijzen**, **Street View** te openen of het punt te **verwijderen**.
- **Teams** aanmaken met eigen kleur — verkeersregelaars fietsen altijd.
- **De verkeersleider wijst teams zelf toe**: klik op een ruitje en kies het team (of twee teams) voor dat punt. De tijden per post — wanneer de stoet aankomt (positie langs de route ÷ wandeltempo) en wanneer de hele stoet voorbij is (+ passeertijd) — staan op `/verkeer` en de printversie, als kloktijd zodra de starttijd van de dag is ingevuld.
- **Navigeren** naar een post doen de verkeersregelaars via de Google Maps-knop per post op `/verkeer`; onderweg letten ze zelf op de stoet.

**Voor de verkeersregelaars zelf** (`/verkeer`, geen wachtwoord): kies je team → je ziet je posten met tijdschema (wanneer komt de stoet, wanneer mag je weg), je kunt per post met één klik navigeren via Google Maps, en onderweg de GPS aanzetten.

**Printversie** (`/print?day=N`, knop in de admin): pagina 1 is het totaalplan (overzichtskaart + tabel met alle posten, tijden en teams), daarna per team een eigen deel met overzichtskaart en per post het adres, een detailkaartje en Street View-foto's vanuit vier windrichtingen. Hiervoor moeten naast de eerdere API's ook de **Maps Static API** en de **Street View Static API** ingeschakeld zijn (en in de API-restricties van de key staan).

## Lokaal draaien

```bash
npm install
cp .env.example .env   # vul DATABASE_URL, GOOGLE_MAPS_API_KEY en ADMIN_PASSWORD in
export $(grep -v '^#' .env | xargs)
npm start              # http://localhost:3000
```

## Kaarten en routes: OpenStreetMap — Google alleen voor Street View

- **Kaartweergave**: Leaflet met OpenStreetMap-tegels (gratis, geen key).
- **Routes**: OSRM via de routers van openstreetmap.org (voetprofiel) voor de wandelroute.
- **Adressen en straatnamen**: Nominatim (server-side, met cache en nette throttling).
- **Street View**: het enige Google-onderdeel. Overlay-panorama op de kaartpagina's en foto's vanuit vier windrichtingen op de printversie.

## Stap 1 — Google-key (alleen voor Street View)

1. Ga naar [console.cloud.google.com](https://console.cloud.google.com) en maak een project aan.
2. Schakel onder **APIs & Services → Library** deze twee API's in:
   - **Maps JavaScript API** (het Street View-panorama)
   - **Street View Static API** (Street View-foto's op de printversie)
3. Maak onder **Credentials** een API-key aan en beperk hem: *Application restrictions* → Websites → `https://jouw-app.onrender.com/*`; *API restrictions* → de twee bovenstaande API's.
4. Google vraagt een betaalrekening, maar geeft een ruim gratis maandelijks tegoed; voor dit gebruik blijf je daar ruim binnen.

> Eerder ingestelde extra API's (Directions, Geocoding, Maps Static, Roads) en een eventuele `GOOGLE_MAPS_SERVER_KEY` zijn niet meer nodig en kunnen uit.

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
   - `GOOGLE_MAPS_API_KEY` = je Google Maps-key
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
