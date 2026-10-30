# Wetterstation-Dashboard

Holt die Live-Daten deiner Wetterstation regelmässig ab, speichert jede Messung in
einer lokalen SQLite-Datenbank und zeigt alles in einem Web-Dashboard an.

- **Übersicht**: aktuelle Werte, Trends, Kompass, 24-h-Diagramme, Rekorde
- **Verlauf**: beliebiger Zeitraum mit Min/Max-Bändern, Windrose, Kennzahlen
- **Vergleich**: Jahre, Monate oder Tage übereinanderlegen (z.B. Regentank kumuliert 2025 vs. 2026)
- **Regentank**: Liter pro Tag/Monat/Jahr aus der Regenmenge
- **Daten**: Export als CSV (Excel) oder JSON, Download der kompletten SQLite-Datenbank

## Regentank-Berechnung

    Liter = Regen [mm] × Dachfläche [m²] × Abflussbeiwert

1 mm Regen auf 1 m² ergibt 1 Liter. Mit 36 m² Dach bringt also jeder Millimeter
**36 Liter**. Der Abflussbeiwert steht auf 1.0 (jeder Tropfen zählt). Wer Verluste
durch Verdunstung und Spritzwasser einrechnen will, setzt ihn unter *Einstellungen*
z.B. auf 0.85 (Ziegeldach).

## Starten

Es braucht nur Python 3.9 oder neuer, keine Zusatzpakete. Die Diagramm-Bibliothek
liegt unter `static/vendor`, die App läuft also auch ohne Internet-CDN.

    python3 server.py

Danach im Browser **http://localhost:8080** öffnen (oder `http://<IP-des-Rechners>:8080`
vom Handy im selben WLAN). Voreingestellt ist die Weathercloud-Station
`https://app.weathercloud.net/d4526664740`; ändern lässt sie sich unter *Einstellungen*.

Weathercloud aktualisiert die Werte je nach Konto etwa alle 1–10 Minuten. Der Server
fragt jede Minute nach und speichert nur neue Messungen (anhand des Messzeitpunkts).

Ausprobieren ohne Station (simulierte Daten über 2 Jahre, separate `wetter-demo.db`):

    python3 server.py --demo

Prüfen, was aus einer URL gelesen wird:

    python3 server.py --test-url "https://…"

Damit die Historie lückenlos ist, muss der Server dauernd laufen, z.B. auf einem
Raspberry Pi, NAS oder Heimserver. Beispiel für einen systemd-Dienst:

    # /etc/systemd/system/wetterstation.service
    [Unit]
    Description=Wetterstation-Dashboard
    After=network-online.target

    [Service]
    WorkingDirectory=/home/pi/wetterstation
    ExecStart=/usr/bin/python3 server.py
    Restart=always
    User=pi

    [Install]
    WantedBy=multi-user.target

    sudo systemctl enable --now wetterstation

## Konfiguration (`config.json`)

Wird beim ersten Start angelegt. Die meisten Werte lassen sich auch im Browser ändern.

| Schlüssel | Bedeutung | Standard |
|---|---|---|
| `source_url` | Live-Daten-URL der Station | Weathercloud d4526664740 |
| `adapter` | `auto`, `weathercloud`, `ecowitt_local`, `clientraw`, `cumulus`, `generic` | `auto` |
| `poll_interval` | Abfrageintervall in Sekunden | 60 |
| `roof_area` | Dachfläche in m² | 36 |
| `runoff_coefficient` | Abflussbeiwert 0.05–1.0 | 1.0 |
| `tank_capacity` | Tankvolumen in Litern (0 = unbekannt) | 0 |
| `mapping` | Feld → JSON-Pfad, falls die automatische Erkennung danebenliegt | `{}` |
| `units` | Feld → Einheit erzwingen (`f`, `mph`, `inhg`, `in`, `m/s` …) | `{}` |
| `port`, `database` | HTTP-Port, Dateiname der Datenbank | 8080, `wetter.db` |

Automatisch erkannt werden u.a. **Weathercloud** (einfach die Geräteseite
`https://app.weathercloud.net/d<ID>` eintragen), Ecowitt/Froggit (lokales Gateway und Cloud-API),
Weather Underground (API und Upload-Format, metrisch und imperial), Weather Display
`clientraw.txt`, Cumulus `realtime.txt` sowie allgemeines JSON und `key=value`-Text.

## Datenbank

Tabelle `readings`, eine Zeile pro Abruf (`ts` = Unix-Zeit). Werte in °C, %, hPa,
km/h, mm, W/m². `rain_mm` ist der Regen seit der vorherigen Messung (aus Tages- oder
Gesamtzähler der Station berechnet, Mitternachts-Resets werden erkannt). Summen
über beliebige Zeiträume sind damit einfach `SUM(rain_mm)`.

## API

| Endpunkt | Inhalt |
|---|---|
| `GET /api/latest` | aktuelle Werte, Tagesextreme, Trends, Regen-/Literzusammenfassung |
| `GET /api/history?from=&to=&bucket=` | Zeitreihe; `bucket` = `auto`, `raw`, `10min`, `hour`, `day`, `month`, `year` |
| `GET /api/windrose?from=&to=` | Häufigkeiten nach Richtung und Stärke |
| `GET /api/records` | Rekordwerte |
| `GET /api/export?format=csv\|json\|sqlite&bucket=&from=&to=` | Download |
| `POST /api/settings` | Einstellungen speichern |
