# Wetterstation-Dashboard

Sammelt die Live-Daten der Wetterstation (Weathercloud `d4526664740`), speichert jede
Messung und zeigt alles als Webseite an – mit Verlauf, Vergleichen, Regentank-Rechner
und Downloads.

**Läuft komplett kostenlos bei GitHub, es braucht keinen eigenen Computer:**

- **GitHub Actions** fragt die Station alle 5 Minuten ab (Workflow `.github/workflows/sammeln.yml`)
  und legt die Werte als CSV-Dateien im Zweig **`daten`** ab (`data/JJJJ-MM.csv`).
- **GitHub Pages** zeigt das Dashboard aus dem Ordner `docs/` an. Der Browser lädt die
  CSV-Dateien und rechnet Diagramme, Vergleiche und Liter selbst aus.

## Einmalig einrichten: GitHub Pages einschalten

1. Im Repository oben auf **Settings** klicken.
2. Links im Menü **Pages** wählen.
3. Unter *Build and deployment* → *Source*: **Deploy from a branch**.
4. Bei *Branch*: **main** und Ordner **/docs** wählen, dann **Save**.
5. Nach 1–2 Minuten erscheint oben die Adresse, z.B.
   `https://pascalnufer75-prog.github.io/Wetterstation-/`

Diese Adresse auf dem Handy als Lesezeichen oder „Zum Home-Bildschirm“ speichern.

## Was die Seite kann

- **Übersicht**: aktuelle Werte, Trends, Kompass, 24-h-Diagramme, Rekorde
- **Verlauf**: beliebiger Zeitraum mit Min/Max-Bändern, Windrose, Kennzahlen
- **Vergleich**: Jahre, Monate oder Tage übereinanderlegen (z.B. Regentank kumuliert 2025 vs. 2026)
- **Regentank**: Liter pro Tag/Monat/Jahr
- **Daten**: Download als CSV (Excel), JSON oder als komplette SQLite-Datenbank

## Regentank-Berechnung

    Liter = Regen [mm] × Dachfläche [m²] × Abflussbeiwert

1 mm Regen auf 1 m² ergibt 1 Liter. Mit 36 m² Dach bringt jeder Millimeter **36 Liter**.
Der Abflussbeiwert steht auf 1.0 (jeder Tropfen zählt); für Verluste durch Verdunstung
und Spritzwasser z.B. 0.85 eintragen.

## Einstellungen ändern

In der Datei **`config.json`** (auf GitHub anklicken → Stift-Symbol → ändern → *Commit changes*):

| Schlüssel | Bedeutung | Standard |
|---|---|---|
| `station_name` | Name oben auf der Seite | Meine Wetterstation |
| `source_url` | Adresse der Station | `https://app.weathercloud.net/d4526664740` |
| `roof_area` | Dachfläche in m² | 36 |
| `runoff_coefficient` | Abflussbeiwert 0.05–1.0 | 1.0 |
| `tank_capacity` | Tankvolumen in Litern (0 = unbekannt) | 0 |

Dachfläche, Beiwert und Tankvolumen lassen sich auch auf der Seite unter *Einstellungen*
ändern – das gilt dann aber nur für den jeweiligen Browser.

## Gut zu wissen

- Ein Durchlauf läuft knapp 6 Stunden und startet sich dann selbst neu; ein stündlicher
  Zeitplan springt ein, falls die Kette einmal abreisst. Kurze Lücken sind für den Regen
  unproblematisch, weil der Tageszähler der Station ausgewertet wird.
- Manuell abrufen: **Actions** → *Wetterdaten sammeln* → **Run workflow**.
- Das Repository ist öffentlich, die Wetterdaten sind also für alle sichtbar.

## Alternative: auf einem eigenen Rechner betreiben

Mit Python 3.9+ (ohne Zusatzpakete) läuft dieselbe Seite auch lokal, inkl. Abruf jede Minute:

    python3 server.py            # http://localhost:8080
    python3 server.py --demo     # mit simulierten Daten
    python3 server.py --test-url https://app.weathercloud.net/d4526664740

Neben Weathercloud werden auch Ecowitt/Froggit, Weather Underground, `clientraw.txt`,
Cumulus `realtime.txt` und allgemeines JSON erkannt.
