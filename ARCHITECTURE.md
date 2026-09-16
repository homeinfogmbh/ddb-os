# ddb-os
Stand: 2026-09-16, geprüft gegen Commit 00727a0 (Bildschirmtastatur in der
Baywatch-Extension, siehe CHANGELOG.md)

## Zweck
Systemkonfigurations-Paket für das neue „DDB OS" (Das Digitale Brett).
Bündelt Konfiguration, systemd-Units, PAM, udev-Regeln, sysusers, ALPM-
Bibliothek/Hooks und Scripts, um ein Arch-System als DDB-Signage-Gerät
einzurichten. Nachfolger/Weiterentwicklung von `digital-signage`.

## Stack & Einstiegspunkte
Arch-Linux-Konfigurationspaket (kein `setup.py`). Verzeichnisse: `config`,
`systemd-units`, `pam`, `udev`, `sysusers`, `libalpm` (Hooks), `scripts`,
`extensions`, `media`.

### Chromium-Extension `baywatch`
`extensions/baywatch` wird von `systemd-units/chromium.service` ueber
`--load-extension=/usr/share/digital-signage/baywatch` ungepackt geladen (MV3).
Der Service-Worker holt seine Konfiguration von `POST /api/baywatch` (System-ID
aus dem `system=`-Parameter der URL, sonst Hostname) und legt sie in
`chrome.storage.local`; die Content-Scripts laufen in **jedem** Frame
(`all_frames`, `document_start`) und setzen daraus Zugriffsschutz
(`content-script.js`, `pattern-matcher.js`) und Bildschirmtastatur
(`keyboard.js`) um. Weil ein Content-Script je Frame eine eigene isolierte Welt
mit vollem DOM-Zugriff hat, erreicht die Tastatur auch Eingabefelder in fremden
iframes — der Weg, den ein Skript der eingebetteten Seite wegen der
Same-Origin-Policy nicht hat. Die Tastatur haengt an `config.keyboard`
(`on`/`off`, Vorgabe `off`) und ist damit je System schaltbar, ohne die
Extension neu auszurollen. Der PKGBUILD installiert die Dateien einzeln:
**neue Dateien dort nachtragen**, sonst fehlen sie auf dem Terminal.

## Schnittstellen
### Konsumiert
- **Arch/Pacman** (ALPM-Hooks), **systemd**, **PAM/udev/sysusers** des
  Zielsystems.
- **`POST https://portal.homeinfo.de/api/baywatch`** (TYPO3, `sysmon2`):
  Whitelist und Verhalten der Baywatch-Extension je System, inkl.
  `config.keyboard`. Gepflegt im Smitrac (`tx_baywatch_rule`).

### Bietet an
- Installierbare System-Konfiguration + Dienste, die ein Gerät zum DDB-OS-
  Signage-System machen (Anzeige-Dienste, Autostart, Berechtigungen).

## Deployment / Laufzeit
Als Paket auf DDB-OS-Geräten installiert; Dateien landen an Systempfaden.
⚠️ ANNAHME: Verpackung/Image-Erzeugung über `hidsl`/HIDSL-Buildprozess.

## Ersetzbarkeit
Kopplungsgrad: **mittel–hoch**. Eng an Arch/systemd und das DDB-Gerätebild
gebunden; überschneidet sich mit `digital-signage` (ältere Variante) — Abgrenzung
im Auge behalten.

## Weitere Doku
- `README.md` (Zweck: DDB-OS-Systemkonfiguration).
- Verwandt: `digital-signage`, `hidsl`, `digsigctl`, `ddb-setup-manual`.
- ⚠️ ANNAHME: Zentrales Repo `homeinfo-architektur` (Ordner `komponenten/`) noch
  nicht geprüft.
