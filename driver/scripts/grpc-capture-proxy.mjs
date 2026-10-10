import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import protobuf from "protobufjs";

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) continue;
    const key = arg.slice(2);
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

function decodeFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset + 5 <= buffer.length) {
    const flags = buffer[offset];
    const length = buffer.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    if (end > buffer.length) break;
    frames.push({ flags, payload: buffer.subarray(start, end) });
    offset = end;
  }
  return { frames, rest: buffer.subarray(offset) };
}

function maybeDecodeGrpcWebText(buffer, contentType) {
  const type = String(contentType ?? "").toLowerCase();
  const maybeText =
    type.includes("grpc-web-text") || /^[A-Za-z0-9+/=\r\n]+$/.test(buffer.toString("utf8").trim());
  if (!maybeText) return buffer;
  try {
    return Buffer.from(buffer.toString("utf8").replace(/\s+/g, ""), "base64");
  } catch {
    return buffer;
  }
}

function toHex(input, count = 16) {
  return Buffer.from(input).subarray(0, count).toString("hex").replace(/(.{2})/g, "$1 ").trim();
}

function protoToJson(type, payload) {
  try {
    return type.toObject(type.decode(payload), {
      defaults: true,
      enums: String,
      longs: Number,
      bytes: Buffer,
      oneofs: true,
    });
  } catch {
    return null;
  }
}

const args = parseArgs(process.argv.slice(2));
const LISTEN_HOST = args.host ?? "127.0.0.1";
const LISTEN_PORT = Number.parseInt(args.port ?? "3814", 10);
const UPSTREAM_HOST = args["upstream-host"] ?? "127.0.0.1";
const UPSTREAM_PORT = Number.parseInt(args["upstream-port"] ?? "3815", 10);
const MIRROR_HOST = args["mirror-host"] ?? "";
const MIRROR_PORT = Number.parseInt(args["mirror-port"] ?? "0", 10);
const MIRROR_ENABLED = MIRROR_HOST.length > 0 && Number.isFinite(MIRROR_PORT) && MIRROR_PORT > 0;

const thisDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(thisDir, "..");
const dbDir = path.join(projectRoot, ".db");
const traceFile = path.join(dbDir, "proxy-rpc-trace.log");

fs.mkdirSync(dbDir, { recursive: true });
const traceStream = fs.createWriteStream(traceFile, { flags: "a" });
traceStream.write(
  `\n=== ${new Date().toISOString()} proxy start listen=${LISTEN_HOST}:${LISTEN_PORT} upstream=${UPSTREAM_HOST}:${UPSTREAM_PORT} mirror=${MIRROR_ENABLED ? `${MIRROR_HOST}:${MIRROR_PORT}` : "off"} ===\n`,
);

const root = await protobuf.load(path.join(projectRoot, "src", "driver.proto"));

const typeByName = {
  Empty: root.lookupType("driver.Empty"),
  DeviceList: root.lookupType("driver.DeviceList"),
  VenderMsg: root.lookupType("driver.VenderMsg"),
  SystemInfo: root.lookupType("driver.SystemInfo"),
  SendMsg: root.lookupType("driver.SendMsg"),
  ReadMsg: root.lookupType("driver.ReadMsg"),
  ResSend: root.lookupType("driver.ResSend"),
  ResRead: root.lookupType("driver.ResRead"),
  SetLight: root.lookupType("driver.SetLight"),
  OTAUpgrade: root.lookupType("driver.OTAUpgrade"),
  Progress: root.lookupType("driver.Progress"),
  MuteMicrophone: root.lookupType("driver.MuteMicrophone"),
  MicrophoneMuteStatus: root.lookupType("driver.MicrophoneMuteStatus"),
  WirelessLoopStatus: root.lookupType("driver.WirelessLoopStatus"),
  InsertDb: root.lookupType("driver.InsertDb"),
  DeleteItem: root.lookupType("driver.DeleteItem"),
  GetItem: root.lookupType("driver.GetItem"),
  Item: root.lookupType("driver.Item"),
  GetAll: root.lookupType("driver.GetAll"),
  AllList: root.lookupType("driver.AllList"),
  Version: root.lookupType("driver.Version"),
  WeatherReq: root.lookupType("driver.WeatherReq"),
  WeatherRes: root.lookupType("driver.WeatherRes"),
};

const methodMap = {
  "/driver.DriverGrpc/watchDevList": { req: "Empty", res: "DeviceList" },
  "/driver.DriverGrpc/watchVender": { req: "Empty", res: "VenderMsg" },
  "/driver.DriverGrpc/watchSystemInfo": { req: "Empty", res: "SystemInfo" },
  "/driver.DriverGrpc/sendMsg": { req: "SendMsg", res: "ResSend" },
  "/driver.DriverGrpc/readMsg": { req: "ReadMsg", res: "ResRead" },
  "/driver.DriverGrpc/sendRawFeature": { req: "SendMsg", res: "ResSend" },
  "/driver.DriverGrpc/readRawFeature": { req: "ReadMsg", res: "ResRead" },
  "/driver.DriverGrpc/setLightType": { req: "SetLight", res: "Empty" },
  "/driver.DriverGrpc/upgradeOTAGATT": { req: "OTAUpgrade", res: "Progress" },
  "/driver.DriverGrpc/muteMicrophone": { req: "MuteMicrophone", res: "ResSend" },
  "/driver.DriverGrpc/toggleMicrophoneMute": { req: "Empty", res: "ResSend" },
  "/driver.DriverGrpc/getMicrophoneMute": { req: "Empty", res: "MicrophoneMuteStatus" },
  "/driver.DriverGrpc/changeWirelessLoopStatus": { req: "WirelessLoopStatus", res: "Empty" },
  "/driver.DriverGrpc/insertDb": { req: "InsertDb", res: "ResSend" },
  "/driver.DriverGrpc/deleteItemFromDb": { req: "DeleteItem", res: "ResSend" },
  "/driver.DriverGrpc/getItemFromDb": { req: "GetItem", res: "Item" },
  "/driver.DriverGrpc/getAllKeysFromDb": { req: "GetAll", res: "AllList" },
  "/driver.DriverGrpc/getAllValuesFromDb": { req: "GetAll", res: "AllList" },
  "/driver.DriverGrpc/cleanDev": { req: "ReadMsg", res: "ResSend" },
  "/driver.DriverGrpc/getVersion": { req: "Empty", res: "Version" },
  "/driver.DriverGrpc/getWeather": { req: "WeatherReq", res: "WeatherRes" },
};

function trace(type, payload) {
  traceStream.write(`${new Date().toISOString()} ${JSON.stringify({ type, ...payload })}\n`);
}

function decodeRequest(pathname, body, contentType) {
  const method = methodMap[pathname];
  if (!method) return null;
  const wire = maybeDecodeGrpcWebText(body, contentType);
  const { frames } = decodeFrames(wire);
  const msgFrame = frames.find((f) => (f.flags & 0x80) === 0);
  if (!msgFrame) return null;
  return protoToJson(typeByName[method.req], msgFrame.payload);
}

function tryDecodeResponseFrame(pathname, frame) {
  if ((frame.flags & 0x80) !== 0) {
    return { trailer: frame.payload.toString("utf8") };
  }
  const method = methodMap[pathname];
  if (!method) return { rawHex: toHex(frame.payload, 24) };
  const json = protoToJson(typeByName[method.res], frame.payload);
  return json ?? { rawHex: toHex(frame.payload, 24) };
}

const noisyStreamPaths = new Set([
  "/driver.DriverGrpc/watchDevList",
  "/driver.DriverGrpc/watchVender",
  "/driver.DriverGrpc/watchSystemInfo",
]);

function shouldMirror(pathname) {
  if (!MIRROR_ENABLED) return false;
  if (noisyStreamPaths.has(pathname)) return false;
  if (pathname === "/driver.DriverGrpc/upgradeOTAGATT") return false;
  return true;
}

function mirrorRequest(pathname, method, headers, body) {
  const mirrorReq = http.request(
    {
      host: MIRROR_HOST,
      port: MIRROR_PORT,
      method,
      path: pathname,
      headers,
    },
    (mirrorRes) => {
      let pending = Buffer.alloc(0);
      mirrorRes.on("data", (chunk) => {
        const buf = Buffer.from(chunk);
        const contentType = String(mirrorRes.headers["content-type"] ?? "");
        const wire = maybeDecodeGrpcWebText(buf, contentType);
        pending = Buffer.concat([pending, wire]);
        const parsed = decodeFrames(pending);
        pending = parsed.rest;
        for (const frame of parsed.frames) {
          trace("mirror_response_frame", {
            path: pathname,
            statusCode: mirrorRes.statusCode ?? 0,
            flags: frame.flags,
            len: frame.payload.length,
            decoded: tryDecodeResponseFrame(pathname, frame),
          });
        }
      });
      mirrorRes.on("end", () => {
        trace("mirror_done", {
          path: pathname,
          statusCode: mirrorRes.statusCode ?? 0,
          contentType: String(mirrorRes.headers["content-type"] ?? ""),
        });
      });
    },
  );

  mirrorReq.on("error", (error) => {
    trace("mirror_error", { path: pathname, message: error.message });
  });
  mirrorReq.end(body);
}

const server = http.createServer((clientReq, clientRes) => {
  const pathname = new URL(clientReq.url ?? "/", `http://${LISTEN_HOST}:${LISTEN_PORT}`).pathname;
  const reqChunks = [];
  clientReq.on("data", (chunk) => reqChunks.push(Buffer.from(chunk)));

  const upstreamReq = http.request(
    {
      host: UPSTREAM_HOST,
      port: UPSTREAM_PORT,
      method: clientReq.method,
      path: clientReq.url,
      headers: clientReq.headers,
    },
    (upstreamRes) => {
      clientRes.writeHead(upstreamRes.statusCode ?? 502, upstreamRes.headers);

      let pending = Buffer.alloc(0);
      upstreamRes.on("data", (chunk) => {
        const buf = Buffer.from(chunk);
        clientRes.write(buf);

        const contentType = String(upstreamRes.headers["content-type"] ?? "");
        const wire = maybeDecodeGrpcWebText(buf, contentType);
        pending = Buffer.concat([pending, wire]);
        const parsed = decodeFrames(pending);
        pending = parsed.rest;
        for (const frame of parsed.frames) {
          if (noisyStreamPaths.has(pathname) && (frame.flags & 0x80) === 0) continue;
          trace("response_frame", {
            path: pathname,
            flags: frame.flags,
            len: frame.payload.length,
            decoded: tryDecodeResponseFrame(pathname, frame),
          });
        }
      });
      upstreamRes.on("end", () => clientRes.end());
    },
  );

  upstreamReq.on("error", (error) => {
    trace("upstream_error", { path: pathname, message: error.message });
    if (!clientRes.headersSent) clientRes.writeHead(502, { "content-type": "text/plain" });
    clientRes.end("upstream error");
  });

  clientReq.on("end", () => {
    const body = Buffer.concat(reqChunks);
    const requestContentType = String(clientReq.headers["content-type"] ?? "");
    trace("request", {
      path: pathname,
      method: clientReq.method,
      contentType: requestContentType,
      len: body.length,
      head: toHex(body, 24),
      decoded: decodeRequest(pathname, body, requestContentType),
    });
    if (shouldMirror(pathname)) {
      mirrorRequest(pathname, clientReq.method ?? "POST", clientReq.headers, body);
    }
    upstreamReq.end(body);
  });
});

server.listen(LISTEN_PORT, LISTEN_HOST, () => {
  console.log(`grpc-capture-proxy listening on ${LISTEN_HOST}:${LISTEN_PORT} -> ${UPSTREAM_HOST}:${UPSTREAM_PORT}`);
  if (MIRROR_ENABLED) {
    console.log(`grpc-capture-proxy mirror enabled -> ${MIRROR_HOST}:${MIRROR_PORT}`);
  }
  console.log(`trace file: ${traceFile}`);
});
