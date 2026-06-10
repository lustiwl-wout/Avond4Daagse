# 🚶 Avond4Daagse Routeplanner

Webapp voor de Avondvierdaagse van basisschool Syncope (Almere). Bezoekers zien de wandelroutes van dag 1 t/m 4 op Google Maps en kunnen onderweg hun eigen positie volgen met GPS. Beheerders tekenen de routes op een aparte adminpagina. Routes worden opgeslagen in een Neon PostgreSQL-database en de app draait op Render.

## Pagina's

| URL | Voor wie | Wat |
|---|---|---|
| `/` | Iedereen | Routes van dag 1 t/m 4 bekijken (elk een eigen kleur), afstanden, GPS aan om jezelf op de kaart te volgen tijdens het lopen, Street View via het gele poppetje. Mobiel-eerst opgezet. |
| `/verkeer` | Verkeersregelaars (geen wachtwoord) | Team kiezen, eigen posten + fietsroute + tijdschema zien, GPS starten. Mobiel-eerst opgezet. |
| `/admin` | Beheer (wachtwoord) | Routes tekenen (ook al lopend vastleggen via GPS), kruisingen, teams en planning beheren |
| `/print?day=N` | Beheer | Printversie van het verkeersregelaarsplan per dag |

## Routes beheren (`/admin`)

- Log in met het beheerwachtwoord (`ADMIN_PASSWORD`).
- **Start en finish liggen vast** op één punt dat voor alle vier de dagen geldt. Bij de eerste keer inloggen zoekt de app dit punt automatisch op (instelbaar via de omgevingsvariabele `START_ADDRESS`); daarna kun je de 🏁-vlag nog precies goed slepen. Bezoekers zien alleen de vlag, geen adres.
- Kies een dag en klik op de kaart om tussenpunten toe te voegen — de route loopt **altijd wandelend** van 🏁 via de tussenpunten terug naar 🏁 (Google Directions, wandelmodus) en je ziet live de afstand in km.
- Elk tussenpunt is te bewerken: **sleep** een punt om hem te verplaatsen, **klik** op een punt voor een menu met Street View, verwijderen of een nieuw punt ertussen voegen.
- **Automatisch bewaard als concept**: elke wijziging (punt erbij, verslepen, verwijderen, wissen) wordt direct als conceptversie bewaard — er is geen opslaanknop nodig en je kunt met "⏪ Herstel vorige versie" stap voor stap terug. Bezoekers zien concepten niet.
- **"Maak route dag X definitief"** publiceert de route voor bezoekers en ruimt alle tussenversies op; er is precies één definitieve route per dag.
- **Vastlegmodus (🎯)**: leg de route vast terwijl je hem zelf loopt — start de GPS op je telefoon en tik bij elke afslag op "Leg punt vast op mijn locatie". De route wordt direct wandelend doorgerekend en punten blijven aanklikbaar en versleepbaar.

## Verkeersregelaars

**In de admin** (`/admin` → modus "🦺 Verkeersregelaars"):

- **Kruisingen detecteren** (automatisch na het publiceren van een route) via twee Google-signalen: wisselingen van wegsegment-ID langs de gesnapte route (**Roads API snapToRoads** — kruispunten op wegen waar de stoet overheen loopt) én plekken waar een weg de route maar heel kort dicht nadert (**Roads API nearestRoads** — oversteken vanaf fiets-/wandelpaden die Google niet als weg kent). Straatnamen komen van de **Google Geocoding API**. De punten verschijnen als genummerde ruitjes op de kaart.
- Klik op een ruitje om het punt te **verbergen** (route blijft gelijk, punt telt niet meer mee in de planning), een **team toe te wijzen** of **Street View** te openen. Klik op de kaart om **zelf een extra punt toe te voegen** (blijft staan bij herdetectie).
- **Teams** aanmaken met eigen kleur — verkeersregelaars fietsen altijd.
- **De planning loopt volautomatisch**: na elke routepublicatie of teamwijziging worden de punten over de teams verdeeld (haasje-over) en de fietsroutes per team (start → posten → finish, stippellijn) berekend, met twee controles:
  - **Tijdstoets**: een team mag pas vertrekken als de héle groep (±500 wandelaars, instelbare passeertijd) voorbij is, en moet zijn volgende post bereiken vóór de kop van de groep daar aankomt. Wandeltempo, passeertijd, fietstempo en veiligheidsmarge zijn instelbaar. Haalt een team het niet, dan zie je precies welke post en hoeveel minuten te laat.
  - **Conflictcontrole**: een teamroute mag de wandelroute **nooit doorkruisen** (aanraken bij de eigen posten en start/finish mag). Conflicten krijgen een rood uitroepteken; is er echt geen alternatief, dan kan de admin de uitzondering per punt **goedkeuren** (wordt een gele ✓ — daar geldt: afstappen en uitkijken). Goedkeuringen blijven bewaard bij herberekening.

**Voor de verkeersregelaars zelf** (`/verkeer`, geen wachtwoord): kies je team → je ziet de oversteekpunten, je eigen fietsroute, een tijdschema per post (wanneer komt de groep, wanneer mag je weg) en eventuele waarschuwingen, en je kunt onderweg de GPS aanzetten.

**Printversie** (`/print?day=N`, knop in de admin): pagina 1 is het totaalplan (overzichtskaart + tabel met alle posten, tijden en teams), daarna per team een eigen deel met hun fietsroutekaart en per post het adres, een detailkaartje en Street View-foto's vanuit vier windrichtingen. Hiervoor moeten naast de eerdere API's ook de **Maps Static API** en de **Street View Static API** ingeschakeld zijn (en in de API-restricties van de key staan).

## Lokaal draaien

```bash
npm install
cp .env.example .env   # vul DATABASE_URL, GOOGLE_MAPS_API_KEY en ADMIN_PASSWORD in
export $(grep -v '^#' .env | xargs)
npm start              # http://localhost:3000
```

## Stap 1 — Google Maps API-keys (twee stuks)

1. Ga naar [console.cloud.google.com](https://console.cloud.google.com) en maak een project aan.
2. Schakel onder **APIs & Services → Library** deze zes API's in:
   - **Maps JavaScript API** (kaart + Street View)
   - **Directions API** (wandel- en fietsroutes over straten)
   - **Geocoding API** (adressen en straatnamen)
   - **Maps Static API** (kaartafbeeldingen op de printversie)
   - **Street View Static API** (Street View-foto's op de printversie)
   - **Roads API** (kruisingdetectie via het wegennetwerk van Google)
3. Maak onder **Credentials** twee API-keys aan:
   - **Browser-key** (`GOOGLE_MAPS_API_KEY`): *Application restrictions* → Websites → `https://jouw-app.onrender.com/*`; *API restrictions* → Maps JavaScript, Directions, Geocoding, Maps Static, Street View Static.
   - **Server-key** (`GOOGLE_MAPS_SERVER_KEY`): *Application restrictions* → **None** (de server roept Google rechtstreeks aan; een website-restrictie zou dit blokkeren); *API restrictions* → **Roads API + Geocoding API**. Deze key staat alleen op de server en is nooit zichtbaar in de browser.
4. Google vraagt een betaalrekening, maar geeft een ruim gratis maandelijks tegoed; voor dit gebruik blijf je daar ruim binnen.

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
   - `GOOGLE_MAPS_API_KEY` = je browser-key
   - `GOOGLE_MAPS_SERVER_KEY` = je server-key (Roads + Geocoding)
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
