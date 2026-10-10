import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import process from "node:process";
import protobuf from "protobufjs";
import HID from "node-hid";

const HOST = "127.0.0.1";
const PORT = 3814;
const ROOT_DIR = path.dirname(new URL(import.meta.url).pathname);
const DB_DIR = path.join(ROOT_DIR, "..", ".db");
const TRACE_PATH = path.join(DB_DIR, "protocol-trace.log");
const DEFAULT_DEVICE_ID = Number.parseInt(process.env.MONSGEEK_DEVICE_ID ?? "2648", 10);
const DEFAULT_VERSION = process.env.MONSGEEK_JS_VERSION ?? "223";
const USB_FILTER = { vid: 0x3151, pid: 0x502d };
const USB_INTERFACE = 2;
const HID_REPORT_ID = Number.parseInt(process.env.MONSGEEK_REPORT_ID ?? "1", 10);

fs.mkdirSync(DB_DIR, { recursive: true });

const root = await protobuf.load(path.join(ROOT_DIR, "driver.proto"));

const Types = {
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

const Methods = {
  "/driver.DriverGrpc/watchDevList": { kind: "stream", req: Types.Empty, res: Types.DeviceList },
  "/driver.DriverGrpc/watchVender": { kind: "stream", req: Types.Empty, res: Types.VenderMsg },
  "/driver.DriverGrpc/watchSystemInfo": { kind: "stream", req: Types.Empty, res: Types.SystemInfo },
  "/driver.DriverGrpc/sendMsg": { kind: "unary", req: Types.SendMsg, res: Types.ResSend },
  "/driver.DriverGrpc/readMsg": { kind: "unary", req: Types.ReadMsg, res: Types.ResRead },
  "/driver.DriverGrpc/sendRawFeature": { kind: "unary", req: Types.SendMsg, res: Types.ResSend },
  "/driver.DriverGrpc/readRawFeature": { kind: "unary", req: Types.ReadMsg, res: Types.ResRead },
  "/driver.DriverGrpc/setLightType": { kind: "unary", req: Types.SetLight, res: Types.Empty },
  "/driver.DriverGrpc/upgradeOTAGATT": { kind: "stream", req: Types.OTAUpgrade, res: Types.Progress },
  "/driver.DriverGrpc/muteMicrophone": { kind: "unary", req: Types.MuteMicrophone, res: Types.ResSend },
  "/driver.DriverGrpc/toggleMicrophoneMute": { kind: "unary", req: Types.Empty, res: Types.ResSend },
  "/driver.DriverGrpc/getMicrophoneMute": { kind: "unary", req: Types.Empty, res: Types.MicrophoneMuteStatus },
  "/driver.DriverGrpc/changeWirelessLoopStatus": { kind: "unary", req: Types.WirelessLoopStatus, res: Types.Empty },
  "/driver.DriverGrpc/insertDb": { kind: "unary", req: Types.InsertDb, res: Types.ResSend },
  "/driver.DriverGrpc/deleteItemFromDb": { kind: "unary", req: Types.DeleteItem, res: Types.ResSend },
  "/driver.DriverGrpc/getItemFromDb": { kind: "unary", req: Types.GetItem, res: Types.Item },
  "/driver.DriverGrpc/getAllKeysFromDb": { kind: "unary", req: Types.GetAll, res: Types.AllList },
  "/driver.DriverGrpc/getAllValuesFromDb": { kind: "unary", req: Types.GetAll, res: Types.AllList },
  "/driver.DriverGrpc/cleanDev": { kind: "unary", req: Types.ReadMsg, res: Types.ResSend },
  "/driver.DriverGrpc/getVersion": { kind: "unary", req: Types.Empty, res: Types.Version },
  "/driver.DriverGrpc/getWeather": { kind: "unary", req: Types.WeatherReq, res: Types.WeatherRes },
};

function checksumModeName(value) {
  if (value === 0 || value === "Bit7") return "Bit7";
  if (value === 1 || value === "Bit8") return "Bit8";
  return "None";
}

function padReport(bytes) {
  const payload = Buffer.alloc(64, 0);
  Buffer.from(bytes).copy(payload, 0, 0, Math.min(bytes.length, 64));
  return payload;
}

function applyChecksum(bytes, mode) {
  const payload = padReport(bytes);
  if (mode === "None") return payload;

  let sum = 0;
  for (let index = 0; index < 63; index += 1) sum += payload[index];
  payload[63] = mode === "Bit7" ? sum & 0x7f : sum & 0xff;
  return payload;
}

function encodeFrame(buffer, trailer = false) {
  const header = Buffer.alloc(5);
  header[0] = trailer ? 0x80 : 0x00;
  header.writeUInt32BE(buffer.length, 1);
  return Buffer.concat([header, Buffer.from(buffer)]);
}

function isGrpcWebText(contentType) {
  return String(contentType ?? "").toLowerCase().includes("grpc-web-text");
}

function decodeGrpcWebBody(bodyBuffer) {
  let offset = 0;
  while (offset + 5 <= bodyBuffer.length) {
    const flags = bodyBuffer[offset];
    const length = bodyBuffer.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    if ((flags & 0x80) === 0) return bodyBuffer.subarray(start, end);
    offset = end;
  }
  return Buffer.alloc(0);
}

function writeHeaders(res, textMode = false) {
  res.writeHead(200, {
    "content-type": textMode ? "application/grpc-web-text+proto" : "application/grpc-web+proto",
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "*",
    "access-control-expose-headers": "*",
    "grpc-accept-encoding": "identity",
    "grpc-encoding": "identity",
    "transfer-encoding": "chunked",
    "x-grpc-web": "1",
  });
}

function writeChunk(res, frame, textMode = false, end = false) {
  if (textMode) {
    const payload = frame.toString("base64");
    if (end) res.end(payload);
    else res.write(payload);
    return;
  }
  if (end) res.end(frame);
  else res.write(frame);
}

function writeTrailer(res, grpcStatus = "0", grpcMessage = "", textMode = false) {
  const trailer = `grpc-status: ${grpcStatus}\r\ngrpc-message: ${grpcMessage}\r\n`;
  writeChunk(res, encodeFrame(Buffer.from(trailer, "utf8"), true), textMode, true);
}

function dbPathToFile(inputPath) {
  const safeName = Buffer.from(String(inputPath)).toString("base64url");
  return path.join(DB_DIR, `${safeName}.json`);
}

function loadDb(inputPath) {
  const filePath = dbPathToFile(inputPath);
  if (!fs.existsSync(filePath)) return {};
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function saveDb(inputPath, value) {
  fs.writeFileSync(dbPathToFile(inputPath), JSON.stringify(value, null, 2));
}

function hex(bytes) {
  return Buffer.from(bytes)
    .toString("hex")
    .replace(/(.{2})/g, "$1 ")
    .trim();
}

function trace(type, payload = {}) {
  const line = `${new Date().toISOString()} ${JSON.stringify({ type, ...payload })}\n`;
  fs.appendFileSync(TRACE_PATH, line);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class DeviceBridge {
  constructor() {
    this.lastRead = new Map();
    this.cached = [];
    this.reportId = HID_REPORT_ID;
    this.logicalPath = "1";
    this.hidPath = null;
  }

  enumerate() {
    const hidDev =
      HID.devices().find(
        (device) =>
          device.vendorId === USB_FILTER.vid &&
          device.productId === USB_FILTER.pid &&
          device.interface === USB_INTERFACE &&
          device.usagePage === 0xffff &&
          device.usage === 0x2,
      ) ?? null;

    if (!hidDev) {
      this.cached = [];
      this.hidPath = null;
      return [];
    }

    this.hidPath = hidDev.path;
    const entry = {
      dev: {
        devType: 0,
        is24: false,
        path: this.logicalPath,
        id: DEFAULT_DEVICE_ID,
        battery: 0,
        isOnline: true,
        vid: USB_FILTER.vid,
        pid: USB_FILTER.pid,
      },
    };

    this.cached = [entry];
    return this.cached;
  }

  findPath(devicePath) {
    const devices = this.enumerate();
    return devices.find((entry) => entry.dev?.path === devicePath);
  }

  resolveDevicePath(devicePath) {
    this.enumerate();
    if (devicePath === this.logicalPath || !devicePath) return this.hidPath;
    if (devicePath === this.hidPath) return this.hidPath;
    return null;
  }

  async withHid(devicePath, fn) {
    const resolvedPath = this.resolveDevicePath(devicePath);
    if (!resolvedPath) throw new Error(`device not found: ${devicePath}`);

    const device = new HID.HID(resolvedPath);
    try {
      return await fn(device);
    } finally {
      device.close();
    }
  }

  async setFeature(devicePath, payload) {
    const data = [this.reportId, ...Buffer.from(payload)];
    await this.withHid(devicePath, async (device) => {
      await device.sendFeatureReport(data);
    });
  }

  async getFeature(devicePath) {
    return this.withHid(devicePath, async (device) => {
      const candidates = [this.reportId, 1, 2];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        for (const reportId of candidates) {
          try {
            const data = await device.getFeatureReport(reportId, 64);
            this.reportId = reportId;
            return Buffer.from(data);
          } catch {}
        }
        await sleep(6);
      }
      throw new Error("failed to read feature report");
    });
  }

  async send(devicePath, bytes, checksumType, raw = false) {
    const payload = raw ? padReport(bytes) : applyChecksum(bytes, checksumModeName(checksumType));
    trace("send", {
      devicePath,
      raw,
      checksumType,
      requestHex: hex(payload),
    });
    await this.setFeature(devicePath, payload);
    try {
      const response = await this.getFeature(devicePath);
      trace("reply", {
        devicePath,
        reportId: this.reportId,
        responseHex: hex(response),
      });
      this.lastRead.set(devicePath, response);
    } catch (error) {
      trace("reply_error", {
        devicePath,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async read(devicePath) {
    try {
      const response = await this.getFeature(devicePath);
      trace("read", {
        devicePath,
        reportId: this.reportId,
        responseHex: hex(response),
      });
      this.lastRead.set(devicePath, response);
      return response;
    } catch (error) {
      const fallback = this.lastRead.get(devicePath) ?? this.lastRead.get(this.logicalPath) ?? Buffer.alloc(64, 0);
      trace("read_fallback", {
        devicePath,
        message: error instanceof Error ? error.message : String(error),
      });
      return fallback;
    }
  }

  clean(devicePath) {
    this.lastRead.delete(devicePath);
  }
}

const bridge = new DeviceBridge();

async function unarySend(request) {
  await bridge.send(request.devicePath, request.msg, request.checkSumType, false);
  return { err: "" };
}

async function unaryRead(request) {
  const msg = await bridge.read(request.devicePath);
  return { err: "", msg };
}

async function unarySendRaw(request) {
  await bridge.send(request.devicePath, request.msg, request.checkSumType, true);
  return { err: "" };
}

async function unaryReadRaw(request) {
  const msg = await bridge.read(request.devicePath);
  return { err: "", msg };
}

async function handleDbInsert(request) {
  const db = loadDb(request.dbPath);
  db[Buffer.from(request.key).toString("base64")] = Buffer.from(request.value).toString("base64");
  saveDb(request.dbPath, db);
  return { err: "" };
}

async function handleDbDelete(request) {
  const db = loadDb(request.dbPath);
  delete db[Buffer.from(request.key).toString("base64")];
  saveDb(request.dbPath, db);
  return { err: "" };
}

async function handleDbGet(request) {
  const db = loadDb(request.dbPath);
  const value = db[Buffer.from(request.key).toString("base64")];
  return value ? { value: Buffer.from(value, "base64"), errStr: "" } : { value: Buffer.alloc(0), errStr: "not found" };
}

async function handleDbAllKeys(request) {
  const db = loadDb(request.dbPath);
  return { data: Object.keys(db).map((key) => Buffer.from(key, "base64")), errStr: "" };
}

async function handleDbAllValues(request) {
  const db = loadDb(request.dbPath);
  return { data: Object.values(db).map((value) => Buffer.from(value, "base64")), errStr: "" };
}

const UnaryHandlers = {
  "/driver.DriverGrpc/sendMsg": unarySend,
  "/driver.DriverGrpc/readMsg": unaryRead,
  "/driver.DriverGrpc/sendRawFeature": unarySendRaw,
  "/driver.DriverGrpc/readRawFeature": unaryReadRaw,
  "/driver.DriverGrpc/setLightType": async () => ({}),
  "/driver.DriverGrpc/muteMicrophone": async () => ({ err: "" }),
  "/driver.DriverGrpc/toggleMicrophoneMute": async () => ({ err: "" }),
  "/driver.DriverGrpc/getMicrophoneMute": async () => ({ isMute: false, err: "" }),
  "/driver.DriverGrpc/changeWirelessLoopStatus": async () => ({}),
  "/driver.DriverGrpc/insertDb": handleDbInsert,
  "/driver.DriverGrpc/deleteItemFromDb": handleDbDelete,
  "/driver.DriverGrpc/getItemFromDb": handleDbGet,
  "/driver.DriverGrpc/getAllKeysFromDb": handleDbAllKeys,
  "/driver.DriverGrpc/getAllValuesFromDb": handleDbAllValues,
  "/driver.DriverGrpc/cleanDev": async (request) => {
    bridge.clean(request.devicePath);
    return { err: "" };
  },
  "/driver.DriverGrpc/getVersion": async () => ({
    baseVersion: DEFAULT_VERSION,
    timeStamp: String(Date.now()),
  }),
  "/driver.DriverGrpc/getWeather": async () => ({ res: "" }),
};

function writeMessage(res, messageType, payload) {
  const encoded = messageType.encode(messageType.fromObject(payload)).finish();
  writeChunk(res, encodeFrame(encoded), payload.__textMode === true, false);
}

function writeMessageMode(res, messageType, payload, textMode = false) {
  const encoded = messageType.encode(messageType.fromObject(payload)).finish();
  writeChunk(res, encodeFrame(encoded), textMode, false);
}

function handleWatchDevList(req, res) {
  const textMode = isGrpcWebText(req.headers["content-type"]);
  trace("rpc_stream", { path: "/driver.DriverGrpc/watchDevList", contentType: req.headers["content-type"] ?? "" });
  writeHeaders(res, textMode);
  writeMessageMode(res, Types.DeviceList, { devList: bridge.enumerate(), type: 0 }, textMode);

  const interval = setInterval(() => {
    try {
      const list = bridge.enumerate();
      writeMessageMode(res, Types.DeviceList, { devList: list, type: 3 }, textMode);
    } catch {
      clearInterval(interval);
      if (!res.writableEnded) writeTrailer(res, "13", "watchDevList failed", textMode);
    }
  }, 1500);

  res.on("close", () => clearInterval(interval));
}

function handleEmptyStream(req, res, messageType, initialPayload) {
  const textMode = isGrpcWebText(req.headers["content-type"]);
  trace("rpc_stream", { path: req.url ?? "", contentType: req.headers["content-type"] ?? "" });
  writeHeaders(res, textMode);
  if (initialPayload) writeMessageMode(res, messageType, initialPayload, textMode);
  res.on("close", () => {});
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

function decodeRequest(method, bodyBuffer) {
  let wireBody = bodyBuffer;
  const maybeTextBody = bodyBuffer.toString("utf8").trim();
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(maybeTextBody) && maybeTextBody.length > 0) {
    try {
      wireBody = Buffer.from(maybeTextBody.replace(/\s+/g, ""), "base64");
    } catch {}
  }

  const messageBytes = decodeGrpcWebBody(wireBody);
  if (!messageBytes.length) return {};
  try {
    return method.req.toObject(method.req.decode(messageBytes), {
      bytes: Buffer,
      enums: String,
      longs: Number,
      defaults: true,
    });
  } catch (error) {
    trace("decode_error", {
      message: error instanceof Error ? error.message : String(error),
      bodyHex: hex(bodyBuffer),
      wireHex: hex(wireBody),
      frameHex: hex(messageBytes),
    });
    return {};
  }
}

async function handleUnary(req, res, method, pathname) {
  const body = await readBody(req);
  const textMode = isGrpcWebText(req.headers["content-type"]);
  trace("rpc_unary", {
    path: pathname,
    contentType: req.headers["content-type"] ?? "",
    bodyLen: body.length,
  });
  const request = decodeRequest(method, body);
  const handler = UnaryHandlers[pathname];
  if (!handler) {
    writeHeaders(res, textMode);
    writeTrailer(res, "12", "unimplemented", textMode);
    return;
  }

  try {
    const payload = await handler(request);
    writeHeaders(res, textMode);
    writeMessageMode(res, method.res, payload, textMode);
    writeTrailer(res, "0", "", textMode);
  } catch (error) {
    writeHeaders(res, textMode);
    const response =
      method.res === Types.ResSend
        ? { err: error.message }
        : method.res === Types.ResRead
          ? { err: error.message, msg: Buffer.alloc(0) }
          : {};
    writeMessageMode(res, method.res, response, textMode);
    writeTrailer(res, "13", error.message, textMode);
  }
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-methods": "POST, OPTIONS",
      "access-control-allow-headers": "*",
    });
    res.end();
    return;
  }

  const pathname = new URL(req.url ?? "/", `http://${HOST}:${PORT}`).pathname;
  const method = Methods[pathname];
  if (!method) {
    res.writeHead(404);
    res.end("not found");
    return;
  }

  if (pathname === "/driver.DriverGrpc/watchDevList") {
    handleWatchDevList(req, res);
    return;
  }

  if (pathname === "/driver.DriverGrpc/watchVender") {
    handleEmptyStream(req, res, Types.VenderMsg, null);
    return;
  }

  if (pathname === "/driver.DriverGrpc/watchSystemInfo") {
    handleEmptyStream(req, res, Types.SystemInfo, {
      diskSpaceTotal: 0,
      diskSpceAvailable: 0,
      netWorkTotalUp: 0,
      netWorkTotalDown: 0,
      cpuTemperater: 0,
      memTotal: 0,
      memUsed: 0,
      cpuUsage: 0,
    });
    return;
  }

  if (pathname === "/driver.DriverGrpc/upgradeOTAGATT") {
    handleEmptyStream(req, res, Types.Progress, { progress: 0, err: "not implemented" });
    return;
  }

  await handleUnary(req, res, method, pathname);
});

server.listen(PORT, HOST, () => {
  console.log(`monsgeek-js-driver listening on http://${HOST}:${PORT}`);
});
