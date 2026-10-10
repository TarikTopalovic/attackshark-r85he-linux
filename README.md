# Attack Shark keyboards on Linux

Configure **Attack Shark** keyboards (built and tested on the R85 HE magnetic keyboard) on Linux: keymap, Fn layer, macros, lighting, actuation and rapid trigger. You get the same settings app Attack Shark ships for Windows.

Attack Shark only ships a Windows app. That app is a web UI that talks to a small closed helper, `iot_driver.exe`, over gRPC-web on `127.0.0.1:3814`, and that helper is what touches the USB device. This repo replaces the helper with an open Linux driver and runs Attack Shark's own UI in your browser.

| | |
|---|---|
| Keyboard | Tested on a real Attack Shark R85HE, USB `3151:5029` (RongYuan ry5088 chip, app device id 3123). Other Attack Shark models on USB vendor `3151` should be detected automatically; they have not been tested on real hardware yet (see [Other models](#other-models)). |
| Real keyboard | CachyOS (Arch), kernel 7.2, UI in Chromium and Firefox |
| Install tested | Ubuntu 20.04 and 24.04, Debian 12, Fedora 41, Arch, openSUSE Tumbleweed, Alpine 3.20, Void: clean containers, the install runs and the driver and app start (no keyboard attached). Also tested as a normal user going through sudo, and with no package manager available. |

## Install

Plug the keyboard in **with the USB cable** (not the 2.4 GHz dongle or Bluetooth). Needs only `bash`; everything else is handled:

```bash
git clone https://github.com/TarikTopalovic/attackshark-r85he-linux
cd attackshark-r85he-linux
./install.sh
```

The installer:
1. installs anything missing (`curl`, `bsdtar`, `libusb`, `libudev`) with your package manager: apt, dnf, pacman, zypper, apk or xbps;
2. uses your Node.js if it is 18 or newer; otherwise it downloads a private copy into `.node/` (official build, checksum-verified; on Alpine it uses the distro package);
3. downloads Attack Shark's official software from `download.attackshark.pro` and unpacks only its web UI (this repo does not redistribute it). If `bsdtar` can't be installed (immutable distros such as Silverblue or Bazzite), it uses a private, checksum-verified copy of 7-Zip instead. One app covers every Attack Shark model;
4. installs the driver (prebuilt; `node-hid` ships its own binaries);
5. installs a udev rule for USB vendor `3151`, which needs root once. It uses sudo, doas, run0, pkexec or su, whichever exists. With systemd, `uaccess` gives access only to the user at the screen; without systemd, it grants access to your own group;
6. adds **Attack Shark Keyboard** to your app menu and tells you whether the keyboard is reachable.

Then open **Attack Shark Keyboard** from your app menu, or run `./r85he`. It starts the driver on `127.0.0.1:3814`, which also serves the app on `127.0.0.1:38140`, and opens it in your browser. If no browser opener works, it prints the address. Your browser doesn't need WebHID, because the driver does the USB work.

**Alpine:** run `apk add bash` first. **NixOS:** run `nix-shell -p curl libarchive nodejs --run ./install.sh`. The installer prints the `services.udev.extraRules` line to add. The prebuilt `node-hid` also needs `libudev`, `libusb` and `libstdc++`, provided for example by `programs.nix-ld` with `systemd`, `libusb1` and `stdenv.cc.cc` in its libraries. NixOS is not tested.

**If the keyboard is not found:** unplug and replug it, check that you used the cable, and look at the driver log in `/tmp/r85he-driver.log`.

## What was needed to make it work

The driver is based on [tricked-dev/monsgeek-js-driver](https://github.com/tricked-dev/monsgeek-js-driver), a reimplementation for MonsGeek boards that use the same chip family. The R85HE needed these changes:

- **Checksum position.** This firmware wants the checksum in byte 7 (`Bit7`) or byte 8 (`Bit8`), computed as `255 - sum(preceding bytes)`. The upstream driver put it in byte 63, so the keyboard silently ignored every command.
- **Unnumbered feature report.** The vendor interface (interface 2, usage page `0xFFFF`) has no report IDs, so hidraw needs a 65-byte read with the leading report-number byte stripped.
- **Reply latency.** A reply arrives about 16 ms after the command. Until then, reads return the previous reply. The driver now keeps one handle open and waits for the fresh reply. Reopening the device on every call gave zeros.
- **gRPC-web text mode.** The browser UI sends `grpc-web-text`, and protobuf-ts picks its decoder from the response `Content-Type`. The upstream driver always answered `+proto`, so the UI reported "IOT not detected".
- **Live keyboard messages.** The Simulation Test's key travel and switches made on the keyboard itself (profile, lighting) arrive as vendor Input reports on a *different* interface (on the R85HE, interface 1 with report id 5; the settings interface has only a Feature report). The driver reads the report ids from the keyboard's HID descriptor, listens there and streams only those reports to the app (`watchVender`), never normal key presses.
- **Account and community.** The app calls the vendor's servers directly, and they reject browser pages (Origin check, no CORS). `install.sh` points those calls at `/__cloud/<host>/…` on the driver, which forwards them only to the vendor's own hosts and never fetches firmware.
- **Live updates.** The app pushes pending changes to the keyboard on a 1 s timer; `install.sh` shortens it to 150 ms. With nothing pending it sends nothing.
- **Firefox.** The UI calls `navigator.hid` as it starts, and Firefox has no WebHID, so the page stayed blank. `install.sh` adds a small stand-in to `app/dist/index.html`; the real USB work goes through the driver anyway.
- **Model detection.** The app identifies a keyboard by its device id, and many models share one USB product id. The driver therefore asks the board directly (command `0x8f`, reply bytes 1-2; the R85HE answers 3123). It does this for any keyboard with USB vendor `3151` that has a vendor collection (usage page `0xFF00` or higher), and it detects the report numbering automatically.

Set `MONSGEEK_TRACE=1` to log every RPC and HID exchange to `driver/.db/ts-rpc-trace.log`.

## Status

Each feature was tested on a real R85HE through the app itself on 2026-10-10. Every test change was written, read back from the keyboard, and then restored; the final state was compared against a full backup (166 settings pages, 4 macro slots, the custom light layer).

| Feature | Status |
|---|---|
| Device detection, model id, firmware version | ✅ works |
| Key remap (Custom Keys), Reset Key | ✅ write and read-back verified |
| Fn layer remap | ✅ write and read-back verified |
| Macros: record, save, assign to a key | ✅ macro bytes read back exactly |
| Magnetic switch: actuation per key, rapid trigger | ✅ write and read-back verified |
| Advanced keys (tested: Toggle/TGL) | ✅ verified; DKS, MT and SnapKey use the same commands but were not clicked through |
| Profiles 1-4 | ✅ switch verified |
| Report rate (Other Settings) | ✅ verified |
| Lighting: effects, brightness, speed, colour (live picker) | ✅ verified |
| Side light | ✅ verified |
| Light Edit (per-key colours, custom layers) | ✅ read and write verified |
| Simulation Test (live key travel) | ✅ the live data reaches the app; check the on-screen bar yourself |
| Local Configuration / saved macros | ✅ stored by the driver in `driver/.db` |
| Community Share, Login | ✅ works through the driver (the vendor servers refuse browser pages directly); logging in with a real account was not tested |
| Travel Calibration | ⚠️ not run: it needs every key pressed fully, and an aborted run could leave bad calibration. Uses the same command path as the rest |
| Restore Factory Settings | ⚠️ not run (it would wipe your settings) |
| Music Follow lighting | ❌ not implemented (needs the PC to stream its sound to the keyboard) |
| Firmware upgrade | ⛔ blocked on purpose: the driver refuses to fetch firmware. A failed flash can brick the keyboard; update from Windows with the official tool |

Good to know:
- Opening **Light Edit** switches the keyboard to the "User Picture" lighting mode. That's how the app works; pick another effect afterwards if you want.
- **Reset Key** restores the app's factory values for that key, including its actuation. These can differ from the rest of your keys.
- Don't click **More → Disable IOT Driver**: the app would then try WebHID, which Firefox doesn't have. To undo it, clear the site data for `127.0.0.1:38140`.
- If an earlier failed session left garbage in the UI (keys shown as disabled), clear the site data for `127.0.0.1:38140` in your browser and reload.

## Other models

The Attack Shark app lists these models, all on USB vendor `3151`: Beat75, K85, K85 PRO HE, K86, R85HE, R85 Ultra, R86 PRO HE, X82HE, X820 Pro, X85 PRO, X86 and X96HE. Only the R85HE has been tested on real hardware. Boards on the ry5088 chip (most HE models) use the same protocol. The older yc3123/pan1086 boards (K86, X85 PRO, X86) are the most likely to differ.

If the driver log says the keyboard *did not answer the id query*, find your model's id in the app's device table: search `app/dist/js/index.*.js` for its `displayName`, which shows as `{id:NNNN,vid:12625,pid:...}`. Then start the driver with `MONSGEEK_DEVICE_ID=NNNN ./r85he`. Other RongYuan brands (MonsGeek, Akko, Epomaker and others) use the same vendor id and may work too.

Mice are not supported.

## License

`driver/` is MPL-2.0, following upstream monsgeek-js-driver; the changes listed above are under the same license. The install and launcher scripts are also MPL-2.0. Attack Shark's app is their property: it is downloaded from their server at install time and is not part of this repo.
