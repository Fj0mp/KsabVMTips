# Kontorets VM-tips

En liten, helt statisk webbsida för att följa kontorets VM-tipskuponger mot
Svenska Spels öppna API och visa en topplista i realtid. Byggd i ren
HTML/CSS/JavaScript utan byggsteg – kan hostas direkt som en GitHub Pages-sida.

## Funktioner

- **Skapa spelomgång** genom att ange omgångsnumret (`drawNumber`) från Svenska Spel.
  Matchlistan hämtas automatiskt från API:et.
- **Registrera kuponger** per deltagare – välj `1`, `X` eller `2` per match
  (flera tecken tillåts för gardering).
- **Topplista i realtid** som räknas ut mot live-resultaten från API:et,
  med "max möjligt"-indikator så länge matcher återstår.
- **Klicka på en deltagare** i topplistan för att se hela kupongen med rätt/fel
  markerat per match.
- **Klicka på en match** för att se vilka som tippat `1`, `X` respektive `2`,
  samt svenska folkets fördelning.
- **Vallista** för att växla mellan registrerade omgångar – senaste visas först.

## Köra lokalt

Eftersom sidan hämtar `data.json` via `fetch` måste den serveras över HTTP
(inte öppnas som `file://`). Enklast:

```bash
# valfri statisk server, t.ex.
python -m http.server 8000
# öppna sedan http://localhost:8000
```

## Publicera på GitHub Pages

1. Skapa ett repo och lägg in dessa filer i roten
   (`index.html`, `styles.css`, `app.js`, `data.json`, `.nojekyll`).
2. Gå till **Settings → Pages** och välj branch `main` / mapp `/root`.
3. Sidan blir tillgänglig på `https://<användare>.github.io/<repo>/`.

## Hur delas data mellan kollegor?

GitHub Pages är helt statiskt utan databas. Datan (omgångar + kuponger) lagras i
varje besökares **localStorage** och seedas första gången från `data.json` i repot.

Arbetsflöde för en gemensam topplista:

1. En administratör lägger in alla deltagares kuponger via **Hantera**.
2. Klicka **Exportera data.json** och ersätt `data.json` i repot, pusha.
3. Övriga kollegor ser samma kuponger nästa gång de öppnar sidan (eller efter
   **Hantera → Återställ lokalt**).

Resultaten och topplistan uppdateras däremot live från API:et – bara själva
tipsen behöver checkas in.

## Om API:et och CORS

Datan hämtas från Svenska Spels öppna API:

```
https://api.spela.svenskaspel.se/draw/1/europatipset/draws/<drawNumber>
```

API:et skickar i dagsläget inte CORS-headern `Access-Control-Allow-Origin`, så
ett direktanrop från webbläsaren kan blockeras. Appen försöker därför först
direkt och faller sedan tillbaka på publika CORS-proxyer
(`corsproxy.io`, `allorigins.win`, `thingproxy`). Om alla skulle vara nere visas
ett felmeddelande men de lokalt sparade kupongerna ligger kvar.

## Filer

| Fil | Beskrivning |
| --- | --- |
| `index.html` | Sidans struktur |
| `styles.css` | Modernt mörkt tema, responsivt |
| `app.js` | All logik: API-hämtning, poängräkning, vyer, admin |
| `data.json` | Delad seed-data (omgångar + kuponger) |
| `.nojekyll` | Säkerställer att GitHub Pages serverar filerna oförändrat |
