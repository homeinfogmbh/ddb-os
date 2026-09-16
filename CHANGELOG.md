# Changelog

- 2026-09-16 — Claude: Baywatch-Extension um eine Bildschirmtastatur erweitert (`extensions/baywatch/keyboard.js`, neu im `content_scripts`-Block von `manifest.json`, Version 1.1.0). Sie zeichnet sich in dem Frame, in dem das fokussierte Eingabefeld liegt — also auch in fremden iframes, an die ein Skript der Portalseite wegen der Same-Origin-Policy nicht herankommt. Geschaltet wird sie ueber den neuen Konfigurationsschluessel `config.keyboard` (`on`/`off`, Vorgabe `off`), den `POST /api/baywatch` liefert und der im Smitrac je System gepflegt wird; fehlt er, bleibt die Tastatur aus. **Wichtig:** Der PKGBUILD (`/home/build/ddb-os`, nicht versioniert) installiert die Extension-Dateien einzeln — `keyboard.js` wurde dort ergaenzt, sonst landet die Datei nicht auf den Terminals.

- 2026-07-29 — Tobias Erlacher: CHANGELOG eingeführt (Claude-Onboarding)
