# MonsGeek TypeScript Driver Reimplementation

TypeScript/Bun reimplementation of the MonsGeek local IoT driver, intended to replace the proprietary binary while keeping existing Electron app and web client behavior compatible.

## Why This Exists

- Remove hard dependency on a closed-source local binary.
- Keep the existing app and web frontend working with minimal changes.
- Make protocol behavior inspectable, testable, and maintainable in source control.
- Enable deterministic debugging with trace logs and side-by-side conformance checks.

## Project Goals

- Match gRPC-web RPC behavior of the official `iot_driver` for real client traffic.
- Match USB/HID request/response packet behavior for supported MonsGeek devices.
- Preserve compatibility with:
  - Electron desktop app flow
  - Browser web driver flow
- Provide tooling for protocol capture, replay, and compare.

## Implementation Overview

### Runtime Components

- `src/server-node.ts`
  - Node entrypoint.
  - Boots gRPC-web server and USB bridge.

- `src/grpc-web-server.ts`
  - Implements `driver.DriverGrpc` endpoints from `driver.proto`.
  - Handles both `grpc-web+proto` and `grpc-web-text` wire modes.
  - Provides unary + stream endpoints and response framing/trailers.

- `src/bridges/node-usb-bridge.ts`
  - USB/HID transport for keyboard device communication.
  - Sends feature reports and reads feature responses.
  - Maintains last-read fallback behavior for read error paths.

- `src/protocol.ts`
  - gRPC-web framing utilities.
  - Checksum behavior (`Bit7`/`Bit8`) and 64-byte report shaping.

- `src/db.ts`
  - Local JSON-backed key/value storage used by DB RPCs.

### Protocol + Compatibility Tooling

- `scripts/grpc-capture-proxy.mjs`
  - Proxy that captures app RPC traffic to structured logs.
  - Optional mirror mode to forward same requests to TS server for side-by-side diffs.

- `scripts/driver-conformance.mjs`
  - RPC probe and compare utility (`iot` vs `ts`).
  - Useful for regression checks during protocol parity work.

## USB Packet Confidence (How It Is Validated)

The packet path is not blind guesswork.

- We run official driver and TS driver in parallel.
- We mirror identical RPC requests to both.
- We compare:
  - Decoded RPC payloads
  - HID command/reply heads and lengths
  - Initialization opcode sequence behavior
- Trace files in `.db/` are used to validate parity against live device traffic.

## Current Compatibility Status

- Core startup/init flow: implemented and validated with side-by-side traces.
- Core HID message path (`sendMsg` / `readMsg`): implemented and actively validated.
- gRPC-web response framing/header/trailer behavior: aligned to observed client expectations.
- DB RPC behavior: implemented with compatibility handling for observed path/error cases.
- Some less-used endpoints still require full parity testing under all edge cases.

## Quick Start

### Requirements

- Bun
- Node.js (for some scripts/tools)
- Supported MonsGeek USB device connected
- macOS/Linux environment with HID access

### Windows Support

- The codebase is cross-platform at the Node layer (`node-hid`, `usb`, gRPC-web server).
- On Windows, USB/HID behavior depends on driver stack/device permissions and may require device-specific setup.
- CI runs build/typecheck on Windows, and release workflow includes a Windows `.exe` packaging step.

### Install

```bash
bun install
cp .env.example .env
```

### Build

```bash
bun run build
```

### Run TS Driver

```bash
bun run start
```

Default bind: `127.0.0.1:3814`

### Useful Environment Variables

- `MONSGEEK_PORT` (default `3814`)
- `MONSGEEK_HOST` (default `127.0.0.1`)
- `MONSGEEK_JS_VERSION` (default `223`)
- `MONSGEEK_DEVICE_ID` (default `2648`)
- `MONSGEEK_REPORT_ID` (default `1`)
- `MONSGEEK_DB_DIR` (default `./.db`)
- `MONSGEEK_IOT_BIN` (used by conformance tooling)

## Conformance + Debug Workflows

### Run Basic Conformance Probe

```bash
bun run conformance
```

### Compare Official Driver and TS Driver

```bash
bun run conformance:compare -- --mode text
```

### Run Proxy Capture

```bash
node scripts/grpc-capture-proxy.mjs \
  --host 127.0.0.1 --port 3814 \
  --upstream-host 127.0.0.1 --upstream-port 3815
```

Mirror mode (for side-by-side TS validation):

```bash
node scripts/grpc-capture-proxy.mjs \
  --host 127.0.0.1 --port 3814 \
  --upstream-host 127.0.0.1 --upstream-port 3815 \
  --mirror-host 127.0.0.1 --mirror-port 3816
```

## Repository Notes

- `src/server.js` is a legacy reference implementation kept for behavior comparison.
- `dist/`, `.db/`, `node_modules/`, and local binary artifacts are generated and should not be committed.
- This project is for interoperability and local driver replacement; avoid misuse.

## CI / Release

- GitHub Actions workflow: `.github/workflows/ci-release.yml`
- CI matrix: Linux + macOS + Windows (`build` + `typecheck`)
- Tag release (`v*`) produces:
  - packaged archives per OS
  - Windows `.exe` artifact via `pkg`
