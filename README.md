# Gå Appen (web demo)

Dette er en enkel web-versjon (MVP) av **Gå Appen**: registrering + kart (Pokémon Go-stil) + “Start dagens tur” + poeng for **gåing/sykling**.

## Kjøre lokalt

- Åpne `index.html` i nettleseren.
- For best GPS: åpne på mobil (Chrome/Safari) og gi posisjonstilgang.

## Hvordan poeng fungerer (demo)

- Nettleseren gir GPS-posisjon og ofte fart (m/s). Hvis fart ikke finnes estimeres den av distanse/tid.
- Aktivitet klassifiseres grovt:
  - **Går**: 0.6–2.2 m/s
  - **Sykler**: 2.2–7.0 m/s
  - **Kjøretøy**: > 7.0 m/s (gir 0 poeng)
- Poeng:
  - Går: ca. 10 poeng per km
  - Sykler: ca. 6 poeng per km

## Viktig

Denne demoen lagrer registrering/poeng **kun lokalt** (LocalStorage). For en ekte konkurranse per kommune/skole trenger dere en backend (innlogging, personvern, foreldresamtykke, anti-juks, osv.).

