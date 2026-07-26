PHASE D – TELEGRAM-BOT v3.8

Ersetze in deinem Projekt genau diese Datei:
app/api/telegram/webhook/route.ts

Neu bzw. verbessert:
- /blindranking startet ausschließlich Blind Ranking.
- /fmk startet ausschließlich FMK.
- /neuekategorie NAME erstellt Blind Ranking.
- /neuesfmk NAME erstellt FMK.
- FMK-Verwaltung und Blind-Ranking-Verwaltung sind getrennt.
- FMK erlaubt maximal und beim Abschluss exakt 3 Bilder.
- /fmk ohne Namen wählt das neueste passende FMK-Spiel.
- Creator können nur eigene Spiele starten und verwalten.
- FMK verwendet eigene Deep Links und öffnet /fmk.
- Die globale Aktiv-Kategorie bleibt ausschließlich für Blind Ranking.

Nach dem Hochladen/Commit:
1. Vercel-Deployment abwarten.
2. Im privaten Bot-Chat /commands testen.
3. Optional BotFather-Kommandos ergänzen:
   blindranking - Blind Ranking starten
   fmk - Fuck Marry Kill starten
   neuekategorie - Blind Ranking erstellen
   neuesfmk - FMK-Spiel erstellen
