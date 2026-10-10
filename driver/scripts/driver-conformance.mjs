import "dotenv/config";
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import protobuf from "protobufjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 3814;
const DEFAULT_IOT_BIN =
  process.env.MONSGEEK_IOT_BIN ??
  path.join(os.homedir(), "Library", "Application Support", "MonsGeek Driver v4", "iot_driver_v217");

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (!value.startsWith("--")) continue;
    const key = value.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith("--")) {
      args[key] = "true";
      continue;
    }
    args[key] = next;
    i += 1;
  }
  return args;
}

function encodeFrame(messageBuffer) {
  const frame = Buffer.alloc(5 + messageBuffer.length);
  frame[0] = 0x00;
  frame.writeUInt32BE(messageBuffer.length, 1);
  messageBuffer.copy(frame, 5);
  return frame;
}

function decodeFrames(buffer) {
  let offset = 0;
  const frames = [];
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    if (end > buffer.length) break;
    frames.push({ flags, payload: buffer.subarray(start, end) });
    offset = end;
  }
  return frames;
}

function maybeDecodeBase64Body(buffer) {
  const text = buffer.toString("utf8").trim();
  if (!text) return buffer;
  if (!/^[A-Za-z0-9+/=\r\n]+$/.test(text)) return buffer;
  try {
    const decoded = Buffer.from(text.replace(/\s+/g, ""), "base64");
    return decoded.length > 0 ? decoded : buffer;
  } catch {
    return buffer;
  }
}

async function unaryCall({ host, port, pathName, reqType, reqValue, resType, contentType = "application/grpc-web+proto", timeoutMs = 4000 }) {
  const requestMessage = reqType.encode(reqValue).finish();
  const binaryFrame = encodeFrame(Buffer.from(requestMessage));
  const body = contentType.includes("grpc-web-text") ? binaryFrame.toString("base64") : binaryFrame;

  return await new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port,
        path: pathName,
        method: "POST",
        headers: { "content-type": contentType, "x-grpc-web": "1" },
      },
      (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        res.on("end", () => {
          const raw = Buffer.concat(chunks);
          const wire = maybeDecodeBase64Body(raw);
          const frames = decodeFrames(wire);
          let message = null;
          let trailer = "";
          for (const frame of frames) {
            if ((frame.flags & 0x80) === 0) {
              try {
                message = resType.toObject(resType.decode(frame.payload), {
                  defaults: true,
                  enums: String,
                  longs: Number,
                  bytes: Buffer,
                });
              } catch (error) {
                message = { decodeError: error instanceof Error ? error.message : String(error) };
              }
            } else {
              trailer = frame.payload.toString("utf8");
            }
          }
          resolve({
            ok: true,
            statusCode: res.statusCode ?? 0,
            responseType: res.headers["content-type"] ?? "",
            message,
            trailer,
          });
        });
      },
    );

    const timer = setTimeout(() => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);

    req.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });

    req.on("close", () => clearTimeout(timer));
    req.end(body);
  });
}

async function streamFirstMessage({
  host,
  port,
  pathName,
  reqType,
  reqValue,
  resType,
  contentType = "application/grpc-web+proto",
  timeoutMs = 2500,
}) {
  const requestMessage = reqType.encode(reqValue).finish();
  const binaryFrame = encodeFrame(Buffer.from(requestMessage));
  const body = contentType.includes("grpc-web-text") ? binaryFrame.toString("base64") : binaryFrame;

  return await new Promise((resolve) => {
    const req = http.request(
      {
        host,
        port,
        path: pathName,
        method: "POST",
        headers: { "content-type": contentType, "x-grpc-web": "1" },
      },
      (res) => {
        let acc = Buffer.alloc(0);
        res.on("data", (chunk) => {
          acc = Buffer.concat([acc, Buffer.from(chunk)]);
          const wire = maybeDecodeBase64Body(acc);
          const frames = decodeFrames(wire);
          for (const frame of frames) {
            if ((frame.flags & 0x80) !== 0) continue;
            try {
              const message = resType.toObject(resType.decode(frame.payload), {
                defaults: true,
                enums: String,
                longs: Number,
                bytes: Buffer,
                oneofs: true,
              });
              req.destroy();
              resolve({
                ok: true,
                statusCode: res.statusCode ?? 0,
                responseType: res.headers["content-type"] ?? "",
                message,
              });
            } catch (error) {
              req.destroy();
              resolve({ ok: false, error: error instanceof Error ? error.message : String(error) });
            }
            return;
          }
        });
      },
    );

    const timer = setTimeout(() => {
      req.destroy();
      resolve({ ok: false, error: "timeout" });
    }, timeoutMs);

    req.on("error", (error) => {
      clearTimeout(timer);
      resolve({ ok: false, error: error.message });
    });
    req.on("close", () => clearTimeout(timer));
    req.end(body);
  });
}

function waitForPort({ host, port, timeoutMs = 6000 }) {
  const start = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        resolve(true);
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(attempt, 120);
      });
    };
    attempt();
  });
}

function waitForPortClosed({ host, port, timeoutMs = 6000 }) {
  const start = Date.now();
  return new Promise((resolve) => {
    const attempt = () => {
      const socket = net.connect({ host, port });
      socket.once("connect", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) resolve(false);
        else setTimeout(attempt, 120);
      });
      socket.once("error", () => {
        socket.destroy();
        resolve(true);
      });
    };
    attempt();
  });
}

async function runProbe({ host, port, mode }) {
  const root = await protobuf.load(path.join(process.cwd(), "src", "driver.proto"));
  const T = (name) => root.lookupType(`driver.${name}`);
  const contentType = mode === "text" ? "application/grpc-web-text" : "application/grpc-web+proto";

  const results = {};
  results.getVersion = await unaryCall({
    host,
    port,
    pathName: "/driver.DriverGrpc/getVersion",
    reqType: T("Empty"),
    reqValue: {},
    resType: T("Version"),
    contentType,
  });

  results.getItemFromDb = await unaryCall({
    host,
    port,
    pathName: "/driver.DriverGrpc/getItemFromDb",
    reqType: T("GetItem"),
    reqValue: { dbPath: "/user/iot_db/userSession_user", key: Buffer.from("session_user") },
    resType: T("Item"),
    contentType,
  });

  results.changeWirelessLoopStatus = await unaryCall({
    host,
    port,
    pathName: "/driver.DriverGrpc/changeWirelessLoopStatus",
    reqType: T("WirelessLoopStatus"),
    reqValue: { lock: false },
    resType: T("Empty"),
    contentType,
  });

  results.watchDevList = await streamFirstMessage({
    host,
    port,
    pathName: "/driver.DriverGrpc/watchDevList",
    reqType: T("Empty"),
    reqValue: {},
    resType: T("DeviceList"),
    contentType,
  });

  results.watchSystemInfo = await streamFirstMessage({
    host,
    port,
    pathName: "/driver.DriverGrpc/watchSystemInfo",
    reqType: T("Empty"),
    reqValue: {},
    resType: T("SystemInfo"),
    contentType,
  });

  let devPath = "1";
  const listed = results.watchDevList?.message?.devList;
  if (Array.isArray(listed) && listed.length > 0) {
    const first = listed[0];
    devPath = first?.dev?.path ?? first?.oneofDev?.dev?.path ?? devPath;
  }

  results.sendMsg = await unaryCall({
    host,
    port,
    pathName: "/driver.DriverGrpc/sendMsg",
    reqType: T("SendMsg"),
    reqValue: { devicePath: devPath, msg: Buffer.from([143]), checkSumType: 0, dangleDevType: 0 },
    resType: T("ResSend"),
    contentType,
  });

  results.readMsg = await unaryCall({
    host,
    port,
    pathName: "/driver.DriverGrpc/readMsg",
    reqType: T("ReadMsg"),
    reqValue: { devicePath: devPath },
    resType: T("ResRead"),
    contentType,
  });

  return {
    meta: { host, port, mode, timestamp: new Date().toISOString() },
    results,
  };
}

function summarize(report) {
  const checks = [];
  const r = report.results;
  checks.push({ name: "getVersion", pass: !!r.getVersion?.ok && !!r.getVersion?.message?.baseVersion, note: r.getVersion?.error ?? "" });
  checks.push({
    name: "watchDevList",
    pass: !!r.watchDevList?.ok && Array.isArray(r.watchDevList?.message?.devList),
    note: r.watchDevList?.error ?? "",
  });
  checks.push({
    name: "sendMsg",
    pass: !!r.sendMsg?.ok && (r.sendMsg?.message?.err ?? "") === "",
    note: r.sendMsg?.message?.err ?? r.sendMsg?.error ?? "",
  });
  checks.push({
    name: "readMsg",
    pass: !!r.readMsg?.ok && typeof r.readMsg?.message?.err === "string",
    note: r.readMsg?.message?.err ?? r.readMsg?.error ?? "",
  });
  return checks;
}

function compareReports(reference, candidate) {
  const keys = [
    "getVersion",
    "getItemFromDb",
    "changeWirelessLoopStatus",
    "watchDevList",
    "watchSystemInfo",
    "sendMsg",
    "readMsg",
  ];
  const diffs = [];
  for (const key of keys) {
    const a = reference.results[key];
    const b = candidate.results[key];
    const aErr = a?.message?.err ?? a?.error ?? "";
    const bErr = b?.message?.err ?? b?.error ?? "";
    const aOk = !!a?.ok;
    const bOk = !!b?.ok;
    const same = aOk === bOk && String(aErr) === String(bErr);
    if (!same) diffs.push({ rpc: key, reference: { ok: aOk, err: aErr }, candidate: { ok: bOk, err: bErr } });
  }
  return diffs;
}

function startTargetProcess(target) {
  if (target === "iot") {
    return spawn(DEFAULT_IOT_BIN, { stdio: "ignore", shell: false, detached: true });
  }
  if (target === "ts") {
    return spawn("node", ["dist/server-node.js"], {
      env: { ...process.env, MONSGEEK_PORT: String(DEFAULT_PORT) },
      stdio: "ignore",
      shell: false,
      detached: true,
    });
  }
  return null;
}

async function runManagedTarget(target, mode) {
  await waitForPortClosed({ host: DEFAULT_HOST, port: DEFAULT_PORT, timeoutMs: 3000 });

  const child = startTargetProcess(target);
  let startedHere = false;
  if (child?.pid) {
    startedHere = true;
    const ready = await waitForPort({ host: DEFAULT_HOST, port: DEFAULT_PORT, timeoutMs: 25000 });
    if (!ready) {
      throw new Error(`${target} did not become ready on port ${DEFAULT_PORT}`);
    }
  }

  const report = await runProbe({ host: DEFAULT_HOST, port: DEFAULT_PORT, mode });

  if (startedHere && child?.pid) {
    try {
      process.kill(child.pid, "SIGTERM");
    } catch {}
    const closed = await waitForPortClosed({ host: DEFAULT_HOST, port: DEFAULT_PORT, timeoutMs: 3000 });
    if (!closed) {
      try {
        process.kill(child.pid, "SIGKILL");
      } catch {}
      await waitForPortClosed({ host: DEFAULT_HOST, port: DEFAULT_PORT, timeoutMs: 3000 });
    }
  }
  return report;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const mode = args.mode === "text" ? "text" : "proto";

  if (args.compare) {
    const parts = String(args.compare).split(",");
    const [refTarget, candTarget] = parts;
    const reference = await runManagedTarget(refTarget, mode);
    const candidate = await runManagedTarget(candTarget, mode);
    const diffs = compareReports(reference, candidate);
    console.log(JSON.stringify({ reference: summarize(reference), candidate: summarize(candidate), diffs }, null, 2));
    process.exit(diffs.length > 0 ? 2 : 0);
  }

  if (args.target === "iot") {
    const report = await runManagedTarget("iot", mode);
    console.log(JSON.stringify({ summary: summarize(report), report }, null, 2));
    return;
  }

  if (args.target === "ts") {
    const report = await runManagedTarget("ts", mode);
    console.log(JSON.stringify({ summary: summarize(report), report }, null, 2));
    return;
  }

  const report = await runProbe({ host: DEFAULT_HOST, port: DEFAULT_PORT, mode });
  console.log(JSON.stringify({ summary: summarize(report), report }, null, 2));
}

await main();
