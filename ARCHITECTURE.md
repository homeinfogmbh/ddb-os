# ddb-os
Stand: 2026-07-29, geprüft gegen Commit 8a01aac

## Zweck
Systemkonfigurations-Paket für das neue „DDB OS" (Das Digitale Brett).
Bündelt Konfiguration, systemd-Units, PAM, udev-Regeln, sysusers, ALPM-
Bibliothek/Hooks und Scripts, um ein Arch-System als DDB-Signage-Gerät
einzurichten. Nachfolger/Weiterentwicklung von `digital-signage`.

## Stack & Einstiegspunkte
Arch-Linux-Konfigurationspaket (kein `setup.py`). Verzeichnisse: `config`,
`systemd-units`, `pam`, `udev`, `sysusers`, `libalpm` (Hooks), `scripts`,
`extensions`, `media`.

## Schnittstellen
### Konsumiert
- **Arch/Pacman** (ALPM-Hooks), **systemd**, **PAM/udev/sysusers** des
  Zielsystems.

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
