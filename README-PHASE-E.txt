PHASE E – FMK MINI APP

Diese Dateien hochladen/ersetzen:
- app/fmk/page.tsx (neu)
- app/globals.css (ersetzen)
- app/layout.tsx (ersetzen)

WICHTIGE BEREINIGUNG:
Falls diese beiden versehentlich doppelt vorhandenen Dateien in GitHub liegen, bitte löschen:
- app/api/fmk/game.route.ts
- app/api/fmk/share.route.ts

Die gültigen API-Dateien liegen ausschließlich hier:
- app/api/fmk/game/route.ts
- app/api/fmk/share/route.ts

Prüfung:
- npx tsc --noEmit: erfolgreich
