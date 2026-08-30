# Telegram Chat Simulator v2 – Mini App

Separater Telegram-Bot + Telegram Mini App für private Chat-Mockups/Pranks.

## Enthalten
- `/start` und `/menu`
- Absender wechseln: Andere Person / Ich
- Textnachrichten
- Bildnachrichten + Caption
- WhatsApp-ähnliche Mini-App-Ansicht
- Kontaktname einstellbar
- Profilbild einstellbar
- Status frei einstellbar (`online`, `tippt …`, `zuletzt online ...`)
- Light / Dark Mode
- Haken: ✓, ✓✓, blaue ✓✓
- letzte Nachricht löschen
- neuen Chat starten
- Live-Aktualisierung der Mini App
- dezenter Hinweis `Chat-Simulation` außerhalb des eigentlichen Chatfensters

## Vercel Environment Variables
- `TELEGRAM_BOT_TOKEN`
- `WEBHOOK_SECRET`
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `NEXT_PUBLIC_APP_URL`
- `ADMIN_TELEGRAM_USER_ID`

## Supabase
Den kompletten Inhalt von `supabase.sql` im SQL Editor ausführen. Die Datei enthält auch `add column if not exists` für ein bestehendes v1-Projekt.

## Webhook
Webhook auf folgendes Ziel setzen:
`https://DEINE-APP.vercel.app/api/telegram/webhook`

Als `secret_token` exakt denselben Wert wie `WEBHOOK_SECRET` verwenden.

## Bedienung
1. `/start`
2. `⚙️ Chat einstellen`: Name, Profilbild, Status, Theme, Haken festlegen.
3. `⬅️ Andere Person` oder `➡️ Ich` auswählen.
4. Text oder Bild an den Bot senden.
5. `📱 Chat öffnen` öffnet die Mini App.
