# Attack Shark R85HE on Linux

Configure the **Attack Shark R85 HE** magnetic (Hall effect) keyboard on Linux: keymap, Fn layer, macros, lighting, actuation and rapid trigger. You get the same settings app Attack Shark ships for Windows.

Attack Shark only ships a Windows app. That app is a web UI that talks to a small closed helper, `iot_driver.exe`, over gRPC-web on `127.0.0.1:3814`, and that helper is what touches the USB device. This repo replaces the helper with an open Linux driver and runs Attack Shark's own UI in your browser.

| | |
|---|---|
| Keyboard | Attack Shark R85HE, USB `3151:5029` (RongYuan ry5088 chip, firmware `ry5088_sg9047_1m_8k`, app device id 3123) |
| Tested on | CachyOS (Arch), kernel 7.2, Node 26, UI in Chromium (Firefox should work the same but is untested) |

## Install

Needs `node`, `npm`, `curl`, `bsdtar` (libarchive) and `python3`.

```bash
git clone https://github.com/TarikTopalovic/attackshark-r85he-linux
cd attackshark-r85he-linux
./install.sh
```

The installer:
1. downloads Attack Shark's official R85HE software from `download.attackshark.pro` and unpacks only its web UI (this repo does not redistribute it);
2. builds the driver;
3. installs a udev rule (asks for your password once) so your logged-in user can talk to the keyboard's settings interface;
4. adds **R85HE Keyboard** to your app menu.

Then open **R85HE Keyboard** from your app menu, or run `./r85he`. It starts the driver on `127.0.0.1:3814`, serves the UI on `127.0.0.1:38140` and opens it in your default browser. Your browser doesn't need WebHID, because the driver does the USB work.

## What was needed to make it work

The driver is based on [tricked-dev/monsgeek-js-driver](https://github.com/tricked-dev/monsgeek-js-driver), a reimplementation for MonsGeek boards that use the same chip family. The R85HE needed these changes:

- **Checksum position.** This firmware wants the checksum in byte 7 (`Bit7`) or byte 8 (`Bit8`), computed as `255 - sum(preceding bytes)`. The upstream driver put it in byte 63, so the keyboard silently ignored every command.
- **Unnumbered feature report.** The vendor interface (interface 2, usage page `0xFFFF`) has no report IDs, so hidraw needs a 65-byte read with the leading report-number byte stripped.
- **Reply latency.** A reply arrives about 16 ms after the command. Until then, reads return the previous reply. The driver now keeps one handle open and waits for the fresh reply. Reopening the device on every call gave zeros.
- **gRPC-web text mode.** The browser UI sends `grpc-web-text`, and protobuf-ts picks its decoder from the response `Content-Type`. The upstream driver always answered `+proto`, so the UI reported "IOT not detected".
- **Model.** PID `0x5029` and device id 3123 are set in `driver/.env`.

Set `MONSGEEK_TRACE=1` to log every RPC and HID exchange to `driver/.db/ts-rpc-trace.log`.

## Status

Verified on a real R85HE:
- the UI detects the keyboard and reads the keymap, per-key actuation (2.0 mm default) and lighting;
- a lighting write lands on the keyboard and reads back correctly.

**Not tested yet:** macros, Fn-layer writes, rapid-trigger writes, the "Simulation Test" live key-travel view and travel calibration.

**Do not use firmware update from this app.** The driver's OTA path has not been validated, and a failed flash can brick the keyboard. Update firmware from Windows with the official tool.

If an earlier failed session left garbage in the UI (keys shown as disabled), clear the site data for `127.0.0.1:38140` in your browser and reload.

## Other RongYuan boards

Many boards with USB vendor `3151` (Attack Shark, MonsGeek, Akko, Epomaker and others) use the same protocol. To try yours, find its `vid/pid/id` in the vendor app's device table (search `app/dist/js/index.*.js` for your model's `displayName`), then set `MONSGEEK_PID`, `MONSGEEK_DEVICE_ID` and the udev rule to match.

## License

`driver/` is MPL-2.0, following upstream monsgeek-js-driver; the changes listed above are under the same license. The install and launcher scripts are also MPL-2.0. Attack Shark's app is their property: it is downloaded from their server at install time and is not part of this repo.
