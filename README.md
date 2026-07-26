# Blind Ranking Telegram V3.1 – öffentliche Player, Creator-Kontingente

## Rollen

- **Owner:** über `ADMIN_TELEGRAM_USER_ID`, unbegrenzt, verwaltet Creator und Tokens.
- **Creator:** direkte Freigabe per Telegram-ID oder einmaliger Creator-Token. Jeder Creator besitzt ein Kontingent von 1, 3, 5, 10 Kategorien oder unbegrenzt.
- **Player:** automatisch jeder Telegram-Nutzer. Keine Freigabe und kein Token nötig. Player dürfen abstimmen und Statistiken ansehen, aber keine Kategorien erstellen und keine Spiele in Gruppen starten.

Das Kategorienkontingent zählt erstellte Kategorien dauerhaft. Das Löschen einer Kategorie gibt keinen Platz zurück. Der Owner kann das Kontingent später ändern.

## Owner-Menü

Im privaten Chat:

```text
/rollen
```

Funktionen:

- Creator-Token mit Kontingent erstellen
- Creator per Telegram-ID und Kontingent genehmigen
- Creator und Verbrauch anzeigen
- offene Tokens anzeigen
- Kontingent ändern
- Creator sperren

## Creator

Token einlösen:

```text
/aktivieren BR-XXXX-XXXX-XXXX
```

Eigenes Kontingent anzeigen:

```text
/meinkonto
```

## Update installieren

1. `supabase.sql` vollständig im Supabase SQL Editor ausführen.
2. Danach den gesamten Projektinhalt in das bestehende GitHub-Repository hochladen und Dateien ersetzen.
3. Änderungen committen.
4. Vercel neu deployen lassen; Build-Cache beim manuellen Redeploy deaktivieren.
5. Webhook und vorhandene Environment Variables bleiben unverändert.

## Vorhandene Creator

Bereits gespeicherte Creator werden durch das SQL-Update auf **unbegrenzt** gesetzt. Ihre bisher erstellten Kategorien werden als Verbrauch erfasst.

## Eigene Telegram-ID anzeigen

Jeder Nutzer kann im privaten Chat oder in einer Gruppe Folgendes senden:

```text
/id
```

Der Bot zeigt die persönliche numerische Telegram-ID, den Benutzernamen und die aktuelle Rolle an. Diese ID kann an einen Owner geschickt werden, damit dieser das Konto direkt als Creator freigibt. Die Aliase `/meineid` und `/myid` funktionieren ebenfalls.


## Creator direkt per Telegram-ID freigeben

1. Der Nutzer sendet dem Bot `/id` und schickt dem Owner die angezeigte Nummer.
2. Der Owner öffnet im privaten Bot-Chat `/rollen`.
3. `➕ Creator per ID genehmigen` antippen.
4. Zuerst die numerische Telegram-ID senden.
5. Danach das Kontingent auswählen: 1, 3, 5, 10 oder unbegrenzt.
6. Erst mit der Kontingentauswahl wird die Freigabe gespeichert.

## Version 3.4 – Tokenzeit, zusätzliche Owner, Bildvorschau

- Creator-Token: erst Kategorienkontingent, dann Gültigkeitsdauer (1 Stunde, 24 Stunden, 7 Tage, 30 Tage oder ohne Ablauf). Danach wird der Token automatisch generiert.
- Im Rollenmenü kann ein bestehender Owner weitere Owner per numerischer Telegram-ID hinzufügen.
- Unter **Kategorien → Bilder verwalten** werden jetzt zuerst alle hinterlegten Bilder als Telegram-Alben mit Position und Namen angezeigt.
- Das Community-Ranking nach einer Abstimmung enthält die gerade abgegebene Stimme sofort.

## Version 3.5 – Navigation, Token-Menü und Benutzerverwaltung

- Alle zentralen Untermenüs besitzen einen **⬅️ Zurück**-Button.
- Player können im privaten Bot-Chat mit `/token` oder über **🎟 Creator-Token einlösen** ein eigenes Token-Menü öffnen und den Token anschließend als normale Nachricht senden.
- Unter `/rollen` → **Owner & Creator verwalten** werden Benutzername, Telegram-ID, Rolle und bei Creatorn das Kontingent angezeigt.
- Owner und Creator können dort einzeln ausgewählt und ihre Berechtigung nach einer Sicherheitsabfrage entfernt werden. Der Haupt-Owner aus `ADMIN_TELEGRAM_USER_ID` kann nicht entfernt werden.
- Bei Freigaben per Telegram-ID versucht der Bot den Telegram-Benutzernamen automatisch zu laden. Falls Telegram ihn noch nicht kennt, wird er aktualisiert, sobald der Nutzer `/id` verwendet.
- Zusätzliche Owner verwenden jetzt ihre eigenen Verwaltungssitzungen korrekt.

### Geprüfte vorhandene Funktionen

Weiterhin integriert sind insbesondere: eigene Kategorien und Bilder über Telegram, Bildvorschau und Bildverwaltung, Dark Mode, bis zu 30 Einträge, einmalige Abstimmung pro Nutzer/Gruppe/Kategorie, Anzeige des früheren Ergebnisses, Ergebnisbilder vor der Textnachricht, Bildversand pro Kategorie ein/aus, Community-Ranking inklusive der aktuellen Stimme, Übereinstimmung, `/statistik`, `/top`, `/leaderboard`, `/history`, getrennte Telegram-Themen für Umfrage und Ergebnisse, Creator-Kontingente, zeitlich begrenzte oder unbegrenzte Creator-Tokens, zusätzliche Owner und `/id`.


## Version 3.7
- Obermenü „Spiele“
- getrennte Verwaltung für Blind Ranking und Fuck, Marry, Kill
- FMK zeigt zufällig drei Einträge und verlangt genau eine Zuordnung zu Fuck, Marry und Kill
- vorhandene Kategorien bleiben automatisch Blind Ranking
- `supabase.sql` nach dem Update einmal ausführen
