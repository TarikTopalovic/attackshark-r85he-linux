#!/bin/bash
# Set up the Attack Shark R85HE configurator on Linux. Run from the repo folder: ./install.sh
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
for c in node npm curl bsdtar python3; do command -v $c >/dev/null || { echo "missing: $c (bsdtar comes with libarchive)"; exit 1; }; done

# 1. Attack Shark's own app UI, downloaded from Attack Shark (not redistributed here).
if [ ! -f app/dist/index.html ]; then
  tmp=$(mktemp -d)
  curl -fL --progress-bar https://download.attackshark.pro/ATTACKSHARK/R85HE/ATTACKSHARKR85HE.zip -o "$tmp/r85.zip"
  bsdtar xf "$tmp/r85.zip" -C "$tmp"
  mkdir -p "$tmp/x" && bsdtar xf "$tmp"/*.exe -C "$tmp/x"
  rm -rf app && mv "$tmp/x/resources/app" app && rm -rf "$tmp"
fi

# 2. The Linux driver that replaces the Windows-only iot_driver.exe.
(cd driver && npm ci --no-audit --no-fund && npx tsup)

# 3. Let the logged-in user talk to the keyboard (asks for your password once).
if [ ! -f /etc/udev/rules.d/70-r85he.rules ]; then
  sudo install -m644 70-r85he.rules /etc/udev/rules.d/
  sudo udevadm control --reload
  sudo udevadm trigger --subsystem-match=hidraw
fi

# 4. App-menu entry.
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/r85he.desktop <<D
[Desktop Entry]
Type=Application
Name=R85HE Keyboard
Comment=Attack Shark R85HE settings (Linux driver)
Exec=$PWD/r85he
Icon=$PWD/app/company/company_AttackShark/APP.png
Categories=Utility;Settings;
D
echo "Done. Open 'R85HE Keyboard' from your app menu, or run ./r85he"
