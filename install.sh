#!/usr/bin/env bash
# Set up the Attack Shark keyboard configurator on any Linux distro. Run from the repo folder: ./install.sh
# Brings its own Node.js when the system has none (or an old one), installs missing tools with your package
# manager, and asks for root only for the device permission rule. Optional: R85HE_ZIP=/path/to/ATTACKSHARKR85HE.zip
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
say() { printf '\n== %s\n' "$*"; }
die() { printf '\nERROR: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

asroot() {
  if [ "$(id -u)" = 0 ]; then "$@"
  elif has sudo; then sudo "$@"
  elif has doas; then doas "$@"
  elif has run0; then run0 "$@"
  elif has pkexec; then pkexec "$@"
  elif has su; then echo "(root password)"; su root -c "$(printf '%q ' "$@")"
  else die "no way to become root; run as root: $*"
  fi
}

# Install packages with whatever package manager this distro has. Args: apt dnf pacman zypper apk xbps names.
pkg() {
  if has apt-get; then asroot apt-get update -qq && asroot env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq $1
  elif has dnf; then asroot dnf install -y -q $2
  elif has pacman; then asroot pacman -Sy --needed --noconfirm $3
  elif has zypper; then asroot zypper -n -q in $4
  elif has apk; then asroot apk add -q $5
  elif has xbps-install; then asroot xbps-install -Sy $6
  else die "please install with your package manager: $1"
  fi
}

fetch() { if has curl; then curl -fL --retry 3 --progress-bar "$1" -o "$2"; else wget -q -O "$2" "$1"; fi; }
nixos() { [ -e /etc/NIXOS ]; }

# 0. Tools.
if ! has curl && ! has wget; then nixos && die "run: nix-shell -p curl libarchive nodejs --run ./install.sh"; c="curl ca-certificates"; pkg "$c" "$c" "$c" "$c" "$c" "$c"; fi
has bsdtar || (pkg libarchive-tools bsdtar libarchive bsdtar libarchive-tools bsdtar) || true  # else unpack() fetches 7-Zip
has tar && has gzip || pkg "tar gzip" "tar gzip" "tar gzip" "tar gzip" "tar gzip" "tar gzip"

# Extract an archive with bsdtar, or with 7-Zip's official static build when bsdtar can't be installed (immutable distros).
unpack() {
  if has bsdtar; then bsdtar xf "$1" -C "$2"; return; fi
  if [ ! -x .node/7zzs ]; then
    case "$(uname -m)" in
      x86_64) a=x64 sum=4ca3b7c6f2f67866b92622818b58233dc70367be2f36b498eb0bdeaaa44b53f4 ;;
      aarch64|arm64) a=arm64 sum=39c5140f02ce4436599303c59a149f654cb1bbc47cdc105a942120d747ae040d ;;
      *) die "install bsdtar (libarchive) and rerun" ;;
    esac
    t=$(mktemp -d); fetch "https://github.com/ip7z/7zip/releases/download/25.01/7z2501-linux-$a.tar.xz" "$t/7z.tar.xz"
    echo "$sum  $t/7z.tar.xz" | sha256sum -c - >/dev/null || die "7-Zip download failed its checksum"
    mkdir -p .node && tar xJf "$t/7z.tar.xz" -C .node 7zzs && rm -rf "$t"
  fi
  .node/7zzs x -y -bd -o"$2" "$1" >/dev/null
}

# 1. Node.js >= 18: the system's, else a private copy in .node/ (official build, checksum-verified).
node_ok() { "$1" -e 'process.exit(+process.versions.node.split(".")[0] >= 18 ? 0 : 1)' 2>/dev/null; }
if [ -x .node/bin/node ] && node_ok .node/bin/node; then :
elif has node && has npm && node_ok node; then :
elif nixos; then die "run: nix-shell -p curl libarchive nodejs --run ./install.sh"
elif ldd --version 2>&1 | grep -qi musl || [ -e /etc/alpine-release ]; then
  say "Installing Node.js from the distro (musl system)"
  pkg nodejs "nodejs npm" "nodejs npm" "nodejs npm" "nodejs npm" "nodejs"
else
  case "$(uname -m)" in x86_64) a=x64 ;; aarch64|arm64) a=arm64 ;; armv7l) a=armv7l ;; *) die "no Node.js build for $(uname -m); install Node.js 18+ and rerun" ;; esac
  say "Downloading Node.js (private copy in .node/)"
  base=https://nodejs.org/dist/latest-v22.x
  tmp=$(mktemp -d); fetch "$base/SHASUMS256.txt" "$tmp/sums"
  f=$(grep -o "node-v[0-9.]*-linux-$a.tar.gz" "$tmp/sums" | head -1)
  fetch "$base/$f" "$tmp/$f"
  (cd "$tmp" && grep " $f\$" sums | sha256sum -c -) || die "Node.js download failed its checksum"
  rm -rf .node && mkdir .node && tar xzf "$tmp/$f" -C .node --strip-components=1 && rm -rf "$tmp"
fi
export PATH="$PWD/.node/bin:$PATH"
echo "node $(node --version)"

# 2. Attack Shark's own app UI, downloaded from Attack Shark (not redistributed here). One app covers every model.
if [ ! -f app/dist/index.html ]; then
  say "Downloading the Attack Shark app"
  tmp=$(mktemp -d)
  if [ -n "${R85HE_ZIP:-}" ]; then cp "$R85HE_ZIP" "$tmp/r85.zip"
  else fetch https://download.attackshark.pro/ATTACKSHARK/R85HE/ATTACKSHARKR85HE.zip "$tmp/r85.zip"; fi
  export LC_ALL=C.UTF-8  # the archives store UTF-16 names; a C locale makes bsdtar skip them
  unpack "$tmp/r85.zip" "$tmp"
  # The .exe is an NSIS installer carrying a plain 7z archive; cut it out so any bsdtar version can read it.
  node -e 'const fs=require("fs"),d=fs.readFileSync(process.argv[1]),i=d.indexOf(Buffer.from("377abcaf271c","hex"));if(i<0)process.exit(1);fs.writeFileSync(process.argv[2],d.subarray(i))' "$(ls "$tmp"/*.exe | head -1)" "$tmp/app.7z" || die "no app archive inside the Attack Shark installer (did it change?)"
  mkdir -p "$tmp/x" && unpack "$tmp/app.7z" "$tmp/x"
  [ -f "$tmp/x/resources/app/dist/index.html" ] || die "the Attack Shark download did not contain the app (did it change?)"
  rm -rf app && mv "$tmp/x/resources/app" app && rm -rf "$tmp"
fi
# Firefox has no WebHID and the UI crashes on navigator.hid at start; it talks to the driver anyway, so stub it.
grep -q 'navigator.hid||' app/dist/index.html || sed -i 's#<head>#<head><script>navigator.hid||Object.defineProperty(navigator,"hid",{value:Object.assign(new EventTarget(),{getDevices:async()=>[],requestDevice:async()=>[]})})</script>#' app/dist/index.html
# Live colour picker: Firefox's colour dialog only reports on "Select"; this one changes the keyboard while you drag.
cp live-color.js app/dist/ && { grep -q 'live-color.js' app/dist/index.html || sed -i 's#<head>#<head><script src="./live-color.js"></script>#' app/dist/index.html; }
# The app pushes pending changes to the keyboard on a 1 s timer; 150 ms makes colour changes show while you drag.
sed -i -E 's/;\)\{await ([A-Za-z_$]+)\(1e3\);for\(const\[([a-z]),\{tasks:/;){await \1(150);for(const[\2,{tasks:/' app/dist/js/index.*.js
# Account and community calls: the vendor's servers refuse browser pages, so send them through the driver.
sed -i -E 's#https://(api[0-9]*\.(rongyuan\.tech|qmk\.top)(:[0-9]+)?)#/__cloud/\1#g' app/dist/js/*.js

# 3. The Linux driver that replaces the Windows-only iot_driver.exe (prebuilt in driver/dist; node-hid ships binaries).
say "Installing the driver"
(cd driver && npm ci --omit=dev --ignore-scripts --no-audit --no-fund --loglevel=error)
hid_ok() { node -e 'require("./driver/node_modules/node-hid").devices()' 2>/dev/null; }
hid_ok || pkg "libudev1 libusb-1.0-0" "systemd-libs libusb1" "systemd-libs libusb" "libudev1 libusb-1_0-0" "eudev-libs libusb" "eudev-libudev libusb"  # node-hid needs these
hid_ok || die "node-hid cannot load on this system ($(uname -m)); run: node -e 'require(\"./driver/node_modules/node-hid\")'"

# 4. Let the logged-in user talk to the keyboard. With systemd, uaccess limits it to whoever sits at the screen;
#    without it, fall back to your own group.
rule='SUBSYSTEM=="hidraw", ATTRS{idVendor}=="3151", TAG+="uaccess"'
[ -d /run/systemd/system ] || rule="$rule, GROUP=\"$(id -gn)\", MODE=\"0660\""
rule="# Attack Shark / RongYuan keyboards (USB vendor 3151): let the user configure them.
$rule"
if nixos; then
  say "NixOS: add this to configuration.nix and run nixos-rebuild switch:"
  printf '  services.udev.extraRules = %s\n%s\n%s;\n' "''" "$rule" "''"
elif [ "$(cat /etc/udev/rules.d/70-r85he.rules 2>/dev/null)" != "$rule" ]; then
  say "Adding the device permission rule (needs root once)"
  f=$(mktemp); printf '%s\n' "$rule" > "$f"; chmod 644 "$f"
  asroot sh -c "mkdir -p /etc/udev/rules.d && cp $f /etc/udev/rules.d/70-r85he.rules && chmod 644 /etc/udev/rules.d/70-r85he.rules && if command -v udevadm >/dev/null; then udevadm control --reload; udevadm trigger --action=add --subsystem-match=hidraw || true; fi"
  rm -f "$f"
fi

# 5. App-menu entry.
mkdir -p ~/.local/share/applications
cat > ~/.local/share/applications/r85he.desktop <<D
[Desktop Entry]
Type=Application
Name=Attack Shark Keyboard
Comment=Attack Shark keyboard settings (Linux driver)
Exec="$PWD/r85he"
Icon=$PWD/app/company/company_AttackShark/APP.png
Categories=Utility;Settings;
D

# 6. Check.
dev=$(grep -l 'HID_ID=0003:00003151' /sys/class/hidraw/*/device/uevent 2>/dev/null | head -1 | cut -d/ -f5 || true)
if [ -z "$dev" ]; then echo "No Attack Shark keyboard plugged in by USB cable right now; plug it in, then start the app."
elif [ -w "/dev/$dev" ]; then echo "Keyboard found and accessible (/dev/$dev)."
else echo "Keyboard found but not accessible yet: unplug and replug it (or log out and in)."; fi
echo "Done. Open 'Attack Shark Keyboard' from your app menu, or run ./r85he"
