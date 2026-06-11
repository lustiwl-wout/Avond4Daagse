# 🚶 Avond4Daagse Routeplanner

Webapp voor het organiseren van avondvierdaagsen — één installatie host er meerdere tegelijk. De platformbeheerder maakt op het hoofddomein onder `/admin` (master-wachtwoord) avondvierdaagsen aan; elke organisatie krijgt een eigen webadres, een eigen beheerwachtwoord en: wandelroutes per dag op de kaart (OpenStreetMap), GPS voor de lopers, en verkeersregelaarsplanning met printversie. Data staat in een (gratis) Neon PostgreSQL-database, de app draait op Render.

Bestaat de installatie al langer met één organisatie, dan migreert de bestaande data bij het opstarten automatisch naar het event `syncope`; het oude `ADMIN_PASSWORD` blijft daar werken.

## Pagina's

| URL | Voor wie | Wat |
|---|---|---|
| `/` | Iedereen | Landingspagina met de lijst van avondvierdaagsen |
| `/admin` (hoofddomein) | Platformbeheerder (master-wachtwoord) | Avondvierdaagsen aanmaken en overzien |
| `<naam>.a4droute.nl` | Iedereen | Routes van dag 1 t/m 4 bekijken, afstanden, GPS om jezelf te volgen, Street View. Mobiel-eerst. |
| `<naam>.a4droute.nl/verkeer` | Verkeersregelaars (geen wachtwoord; bewust nergens gelinkt — deel de URL zelf) | Team kiezen, eigen posten + tijdschema zien en per post navigeren via Google Maps |
| `<naam>.a4droute.nl/admin` | Beheer (eigen wachtwoord per event) | Routes tekenen (ook al lopend via GPS), oversteekpunten, teams en loopdagen beheren |
| `<naam>.a4droute.nl/print?day=N` | Beheer | Printversie van het verkeersregelaarsplan per dag |

## Routes beheren (`/admin`)

- Log in met het beheerwachtwoord van jouw event (gekozen bij het aanmaken; te wijzigen in de admin onder "Beheerwachtwoord wijzigen"). Het master-wachtwoord van de platformbeheerder (omgevingsvariabele `ADMIN_PASSWORD`) werkt op elk event. Eventwachtwoorden staan als scrypt-hash met salt in de database; oudere installaties worden bij de eerste login automatisch geüpgraded.
- **Start en finish liggen vast** op één punt dat voor alle vier de dagen geldt: zoek het adres op in de admin of sleep de vlag op zijn plek. Bezoekers zien alleen de vlag, geen adres.
- Kies een dag en klik op de kaart om tussenpunten toe te voegen — de route loopt **altijd wandelend** van 🏁 via de tussenpunten terug naar 🏁 (Google Directions, wandelmodus) en je ziet live de afstand in km.
- Elk tussenpunt is te bewerken: **sleep** een punt om hem te verplaatsen, **klik** op een punt voor een menu met Street View, verwijderen of een nieuw punt ertussen voegen.
- **Automatisch bewaard als concept**: elke wijziging (punt erbij, verslepen, verwijderen, wissen) wordt direct als conceptversie bewaard — er is geen opslaanknop nodig en je kunt met "Herstel vorige versie" stap voor stap terug. Bezoekers zien concepten niet.
- **"Maak route dag X definitief"** publiceert de route voor bezoekers, ruimt alle tussenversies op en **vergrendelt de dag**: route, pauzepunt en tussenpunten zijn dan niet meer te bewerken. Wil je toch iets aanpassen, zet de dag dan eerst terug naar concept (knop in de zijbalk) — bezoekers blijven de definitieve versie zien totdat je opnieuw publiceert. De verkeersmodus (oversteekpunten en teams) blijft op een definitieve dag gewoon werken.
- **Vastlegmodus (🎯)**: leg de route vast terwijl je hem zelf loopt — start de GPS op je telefoon en tik bij elke afslag op "Leg punt vast op mijn locatie". De route wordt direct wandelend doorgerekend en punten blijven aanklikbaar en versleepbaar.
- **Pauzepunt**: markeer per dag waar de stoet pauze houdt (knop "Pauzepunt plaatsen", daarna klikken op de route; versleepbaar en blijft altijd op de route). Zichtbaar voor bezoekers, verkeersregelaars en op de printversie.

## Verkeersregelaars

**In de admin** (`/admin` → modus "🦺 Verkeersregelaars"):

- **Oversteekpunten zet de verkeersleider zelf op de kaart**: klik in de verkeersmodus op de route waar verkeersregelaars moeten staan. Het punt snapt naar de route en krijgt automatisch de straatnaam (Nominatim). De punten verschijnen als genummerde ruitjes, in routevolgorde.
- Klik op een ruitje om een **team toe te wijzen**, **Street View** te openen of het punt te **verwijderen**.
- **Teams** aanmaken met eigen kleur — verkeersregelaars fietsen altijd.
- **De verkeersleider wijst teams zelf toe**: klik op een ruitje en kies het team (of twee teams) voor dat punt. De tijden per post — wanneer de stoet aankomt (positie langs de route ÷ wandeltempo) en wanneer de hele stoet voorbij is (+ passeertijd) — staan op `/verkeer` en de printversie, als kloktijd zodra de starttijd van de dag is ingevuld.
- **Navigeren** naar een post doen de verkeersregelaars via de Google Maps-knop per post op `/verkeer`; onderweg letten ze zelf op de stoet.

**Voor de verkeersregelaars zelf** (`/verkeer`, geen wachtwoord): kies je team → je ziet je posten met tijdschema (wanneer komt de stoet, wanneer mag je weg) en je kunt per post met één klik navigeren via Google Maps.

**Printversie** (`/print?day=N`, knop in de admin): pagina 1 is het totaalplan (overzichtskaart + tabel met alle posten, tijden en teams), daarna per team een eigen deel met overzichtskaart en per post het adres, een detailkaartje en Street View-foto's vanuit vier windrichtingen. Hiervoor moeten naast de eerdere API's ook de **Maps Static API** en de **Street View Static API** ingeschakeld zijn (en in de API-restricties van de key staan).

## Extra's

- **Mededelingenbalk**: zet in de admin een mededeling ("De start van dag 3 is verplaatst") — die verschijnt als balk bovenaan de bezoekers- en verkeerspagina.
- **QR-codes** in de admin voor de bezoekers- en verkeerspagina (poster/appgroep).
- **GPX-download** per dag in de afstandenlijst, voor sporthorloges en navigatie-apps.
- **Voortgang voor lopers**: met GPS aan zie je hoeveel je gelopen hebt, wat er nog komt, de afstand tot de pauze en je verwachte finishtijd; het gelopen deel van de route vervaagt op de kaart.
- **Weer per loopdag** (Open-Meteo, zonder key) in de afstandenlijst.

## Lokaal draaien

```bash
npm install
cp .env.example .env   # vul DATABASE_URL, GOOGLE_MAPS_API_KEY en ADMIN_PASSWORD in
export $(grep -v '^#' .env | xargs)
npm start              # http://localhost:3000
```

## Kaarten en routes: OpenStreetMap — Google alleen voor Street View

- **Kaartweergave**: Leaflet met OpenStreetMap-tegels (gratis, geen key).
- **Routes**: wandelroutes via OSRM (voetprofiel) met automatische terugval op Valhalla. Zet bij voorkeur ook een gratis key van [openrouteservice.org](https://openrouteservice.org) in de omgevingsvariabele `ORS_API_KEY`: dan rekent die dienst met eigen quotum de routes uit en ben je niet afhankelijk van de (soms overbelaste of afgeschermde) publieke OSM-servers.
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

## Eigen domein met subdomeinen per event

Elk event leeft op een eigen subdomein: `syncope.a4droute.nl`. Zo zet je dat op:

1. Koop een domein (bv. `a4droute.nl`) en voeg het in Render toe onder **Settings → Custom Domains**: zowel `a4droute.nl` als `*.a4droute.nl` (wildcard).
2. Zet bij je registrar de DNS-records die Render toont (A-record voor het hoofddomein, CNAME/wildcard voor `*`).
3. Zet de omgevingsvariabele `BASE_DOMAIN=a4droute.nl` in Render.
4. Voeg in de Google Cloud Console `https://a4droute.nl/*` en `https://*.a4droute.nl/*` toe aan de referrer-restrictie van je key (anders valt Street View stil).


## Stap 3 — Deployen op Render

1. Push deze repository naar GitHub.
2. Ga naar [render.com](https://render.com) → **New → Web Service** en koppel de repository (of gebruik **New → Blueprint**, dan wordt `render.yaml` automatisch gelezen).
3. Zet bij **Environment Variables**:
   - `DATABASE_URL` = je Neon-connectiestring
   - `GOOGLE_MAPS_API_KEY` = je Google Maps-key (Street View)
   - `ADMIN_PASSWORD` = master-wachtwoord van de platformbeheerder (optioneel; events hebben hun eigen wachtwoord)
   - `BASE_DOMAIN` = eigen domein; elk event krijgt een subdomein (zie hierboven)
4. Deploy — klaar! 🎉

> De GPS-functie werkt alleen via HTTPS; op Render is dat automatisch geregeld.

## Techniek

- **Backend:** Node.js + Express (`server.js`) met een kleine REST-API (`/api/routes`)
- **Database:** PostgreSQL op Neon, tabel `day_routes` — één route per dag (1–4) met de klikpunten én het uitgerekende wandelpad als JSONB
- **Frontend:** vanilla HTML/CSS/JS in `public/` met de Google Maps JavaScript API
- Bezoekers krijgen het opgeslagen wandelpad te zien zonder dat daar Directions-aanvragen voor nodig zijn; alleen de adminpagina rekent routes uit
- De API-key staat niet in de code; de frontend haalt hem op via `/api/config` uit de omgevingsvariabele
- Adminacties vereisen het wachtwoord uit `ADMIN_PASSWORD` (header `x-admin-password`)
