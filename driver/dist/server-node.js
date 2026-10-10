// src/server-node.ts
import "dotenv/config";
import fs4 from "fs";
import http2 from "http";
import path3 from "path";
import { fileURLToPath } from "url";
import process3 from "process";

// src/grpc-web-server.ts
import http from "http";
import fs2 from "fs";
import path2 from "path";
import os from "os";
import protobuf from "protobufjs";

// src/db.ts
import fs from "fs";
import path from "path";
var JsonDbStore = class {
  rootDir;
  constructor(rootDir) {
    this.rootDir = rootDir;
    fs.mkdirSync(this.rootDir, { recursive: true });
  }
  pathToFile(inputPath) {
    const safeName = Buffer.from(String(inputPath)).toString("base64url");
    return path.join(this.rootDir, `${safeName}.json`);
  }
  load(inputPath) {
    const filePath = this.pathToFile(inputPath);
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  }
  save(inputPath, value) {
    fs.writeFileSync(this.pathToFile(inputPath), JSON.stringify(value, null, 2));
  }
  insert(dbPath, key, value) {
    const db = this.load(dbPath);
    db[Buffer.from(key).toString("base64")] = Buffer.from(value).toString("base64");
    this.save(dbPath, db);
  }
  delete(dbPath, key) {
    const db = this.load(dbPath);
    delete db[Buffer.from(key).toString("base64")];
    this.save(dbPath, db);
  }
  get(dbPath, key) {
    const db = this.load(dbPath);
    const value = db[Buffer.from(key).toString("base64")];
    return value ? Buffer.from(value, "base64") : null;
  }
  keys(dbPath) {
    const db = this.load(dbPath);
    return Object.keys(db).map((key) => Buffer.from(key, "base64"));
  }
  values(dbPath) {
    const db = this.load(dbPath);
    return Object.values(db).map((value) => Buffer.from(value, "base64"));
  }
};

// src/protocol.ts
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
  const at = mode === "Bit7" ? 7 : 8;
  let sum = 0;
  for (let index = 0; index < at; index += 1) sum += payload[index];
  payload[at] = 255 - (sum & 255) & 255;
  return payload;
}
function encodeFrame(buffer, trailer = false) {
  const header = Buffer.alloc(5);
  header[0] = trailer ? 128 : 0;
  header.writeUInt32BE(buffer.length, 1);
  return Buffer.concat([header, Buffer.from(buffer)]);
}
function decodeGrpcWebBody(bodyBuffer) {
  let offset = 0;
  while (offset + 5 <= bodyBuffer.length) {
    const flags = bodyBuffer[offset];
    const length = bodyBuffer.readUInt32BE(offset + 1);
    const start = offset + 5;
    const end = start + length;
    if ((flags & 128) === 0) return bodyBuffer.subarray(start, end);
    offset = end;
  }
  return Buffer.alloc(0);
}

// src/grpc-web-server.ts
function isGrpcWebText(contentType) {
  return String(contentType ?? "").toLowerCase().includes("grpc-web-text");
}
function writeChunk(res, frame, textMode, end = false) {
  if (textMode) {
    const payload = frame.toString("base64");
    if (end) res.end(payload);
    else res.write(payload);
    return;
  }
  if (end) res.end(frame);
  else res.write(frame);
}
function decodeGrpcWebBodyAuto(bodyBuffer) {
  let wireBody = bodyBuffer;
  const maybeTextBody = bodyBuffer.toString("utf8").trim();
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(maybeTextBody) && maybeTextBody.length > 0) {
    try {
      wireBody = Buffer.from(maybeTextBody.replace(/\s+/g, ""), "base64");
    } catch {
    }
  }
  return decodeGrpcWebBody(wireBody);
}
async function createGrpcWebServer(options) {
  const rpcTraceFile = path2.join(options.dbDir, "ts-rpc-trace.log");
  const traceRpc = (type, payload) => {
    if (!process.env.MONSGEEK_TRACE) return;
    fs2.mkdirSync(options.dbDir, { recursive: true });
    fs2.appendFileSync(rpcTraceFile, `${(/* @__PURE__ */ new Date()).toISOString()} ${JSON.stringify({ type, ...payload })}
`);
  };
  const toHex = (input, count = 64) => {
    if (!input) return "";
    return Buffer.from(input).subarray(0, count).toString("hex").replace(/(.{2})/g, "$1 ").trim();
  };
  const root = await protobuf.load(path2.join(options.rootDir, "driver.proto"));
  const db = new JsonDbStore(options.dbDir);
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
    WeatherRes: root.lookupType("driver.WeatherRes")
  };
  const Methods = {
    "/driver.DriverGrpc/watchDevList": { req: Types.Empty, res: Types.DeviceList },
    "/driver.DriverGrpc/watchVender": { req: Types.Empty, res: Types.VenderMsg },
    "/driver.DriverGrpc/watchSystemInfo": { req: Types.Empty, res: Types.SystemInfo },
    "/driver.DriverGrpc/sendMsg": { req: Types.SendMsg, res: Types.ResSend },
    "/driver.DriverGrpc/readMsg": { req: Types.ReadMsg, res: Types.ResRead },
    "/driver.DriverGrpc/sendRawFeature": { req: Types.SendMsg, res: Types.ResSend },
    "/driver.DriverGrpc/readRawFeature": { req: Types.ReadMsg, res: Types.ResRead },
    "/driver.DriverGrpc/setLightType": { req: Types.SetLight, res: Types.Empty },
    "/driver.DriverGrpc/upgradeOTAGATT": { req: Types.OTAUpgrade, res: Types.Progress },
    "/driver.DriverGrpc/muteMicrophone": { req: Types.MuteMicrophone, res: Types.ResSend },
    "/driver.DriverGrpc/toggleMicrophoneMute": { req: Types.Empty, res: Types.ResSend },
    "/driver.DriverGrpc/getMicrophoneMute": { req: Types.Empty, res: Types.MicrophoneMuteStatus },
    "/driver.DriverGrpc/changeWirelessLoopStatus": { req: Types.WirelessLoopStatus, res: Types.Empty },
    "/driver.DriverGrpc/insertDb": { req: Types.InsertDb, res: Types.ResSend },
    "/driver.DriverGrpc/deleteItemFromDb": { req: Types.DeleteItem, res: Types.ResSend },
    "/driver.DriverGrpc/getItemFromDb": { req: Types.GetItem, res: Types.Item },
    "/driver.DriverGrpc/getAllKeysFromDb": { req: Types.GetAll, res: Types.AllList },
    "/driver.DriverGrpc/getAllValuesFromDb": { req: Types.GetAll, res: Types.AllList },
    "/driver.DriverGrpc/cleanDev": { req: Types.ReadMsg, res: Types.ResSend },
    "/driver.DriverGrpc/getVersion": { req: Types.Empty, res: Types.Version },
    "/driver.DriverGrpc/getWeather": { req: Types.WeatherReq, res: Types.WeatherRes }
  };
  const dbPathError = (dbPath) => {
    const normalized = String(dbPath ?? "");
    if (normalized.startsWith("/")) return "IO error: Read-only file system (os error 30)";
    return "";
  };
  const UnaryHandlers = {
    "/driver.DriverGrpc/sendMsg": async (request) => {
      traceRpc("sendMsg_req", {
        devicePath: request.devicePath,
        len: request.msg?.length ?? 0,
        head: toHex(request.msg),
        checkSumType: request.checkSumType
      });
      await withTimeout(options.bridge.send(request.devicePath, request.msg, request.checkSumType, false), 1200, "sendMsg");
      traceRpc("sendMsg_ok", { devicePath: request.devicePath });
      return { err: "" };
    },
    "/driver.DriverGrpc/readMsg": async (request) => {
      const msg = await withTimeout(options.bridge.read(request.devicePath), 1200, "readMsg");
      traceRpc("readMsg_res", {
        devicePath: request.devicePath,
        len: msg?.length ?? 0,
        head: toHex(msg)
      });
      return { err: "", msg };
    },
    "/driver.DriverGrpc/sendRawFeature": async (request) => {
      await withTimeout(
        options.bridge.send(request.devicePath, request.msg, request.checkSumType, true),
        1200,
        "sendRawFeature"
      );
      return { err: "" };
    },
    "/driver.DriverGrpc/readRawFeature": async (request) => {
      const msg = await withTimeout(options.bridge.read(request.devicePath), 1200, "readRawFeature");
      return { err: "", msg };
    },
    "/driver.DriverGrpc/setLightType": async () => ({}),
    "/driver.DriverGrpc/muteMicrophone": async () => ({ err: "" }),
    "/driver.DriverGrpc/toggleMicrophoneMute": async () => ({ err: "" }),
    "/driver.DriverGrpc/getMicrophoneMute": async () => ({ isMute: false, err: "" }),
    "/driver.DriverGrpc/changeWirelessLoopStatus": async () => ({}),
    "/driver.DriverGrpc/insertDb": async (request) => {
      const err = dbPathError(request.dbPath);
      if (err) return { err };
      db.insert(request.dbPath, request.key, request.value);
      return { err: "" };
    },
    "/driver.DriverGrpc/deleteItemFromDb": async (request) => {
      const err = dbPathError(request.dbPath);
      if (err) return { err };
      db.delete(request.dbPath, request.key);
      return { err: "" };
    },
    "/driver.DriverGrpc/getItemFromDb": async (request) => {
      const err = dbPathError(request.dbPath);
      if (err) return { value: Buffer.alloc(0), errStr: err };
      const value = db.get(request.dbPath, request.key);
      return value ? { value, errStr: "" } : { value: Buffer.alloc(0), errStr: "can not find item" };
    },
    "/driver.DriverGrpc/getAllKeysFromDb": async (request) => {
      const err = dbPathError(request.dbPath);
      if (err) return { data: [], errStr: err };
      return { data: db.keys(request.dbPath), errStr: "" };
    },
    "/driver.DriverGrpc/getAllValuesFromDb": async (request) => {
      const err = dbPathError(request.dbPath);
      if (err) return { data: [], errStr: err };
      return { data: db.values(request.dbPath), errStr: "" };
    },
    "/driver.DriverGrpc/cleanDev": async (request) => {
      options.bridge.clean(request.devicePath);
      return { err: "" };
    },
    "/driver.DriverGrpc/getVersion": async () => ({
      baseVersion: options.version,
      timeStamp: String(Date.now())
    }),
    "/driver.DriverGrpc/getWeather": async () => ({ res: "" })
  };
  function writeHeaders(res, textMode) {
    res.writeHead(200, {
      // protobuf-ts picks the decoder from this header, so text replies must say text.
      "content-type": textMode ? "application/grpc-web-text" : "application/grpc-web+proto",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-expose-headers": "*",
      "grpc-accept-encoding": "identity",
      "grpc-encoding": "identity",
      "transfer-encoding": "chunked",
      "x-grpc-web": "1"
    });
  }
  function writeTrailer(res, textMode, grpcStatus = "0") {
    const trailer = `grpc-status:${grpcStatus}\r
`;
    writeChunk(res, encodeFrame(Buffer.from(trailer, "utf8"), true), textMode, true);
  }
  function writeMessage(res, messageType, payload, textMode) {
    const encoded = messageType.encode(messageType.fromObject(payload)).finish();
    writeChunk(res, encodeFrame(Buffer.from(encoded)), textMode);
  }
  function systemInfoPayload() {
    let diskSpaceTotal = 0;
    let diskSpceAvailable = 0;
    try {
      const stats = fs2.statfsSync(process.cwd(), { bigint: true });
      const bsize = Number(stats.bsize);
      const blocks = Number(stats.blocks);
      const bavail = Number(stats.bavail);
      if (Number.isFinite(bsize) && Number.isFinite(blocks)) diskSpaceTotal = bsize * blocks;
      if (Number.isFinite(bsize) && Number.isFinite(bavail)) diskSpceAvailable = bsize * bavail;
    } catch {
    }
    const memTotal = os.totalmem();
    const memUsed = Math.max(0, memTotal - os.freemem());
    const cpuCount = Math.max(1, os.cpus().length);
    const cpuUsage = Math.max(0, os.loadavg()[0] / cpuCount * 100);
    return {
      diskSpaceTotal,
      diskSpceAvailable,
      netWorkTotalUp: 0,
      netWorkTotalDown: 0,
      cpuTemperater: 0,
      memTotal,
      memUsed,
      cpuUsage
    };
  }
  async function readBody(req) {
    const chunks = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }
  function decodeRequest(method, bodyBuffer) {
    const messageBytes = decodeGrpcWebBodyAuto(bodyBuffer);
    if (!messageBytes.length) return {};
    try {
      return method.req.toObject(method.req.decode(messageBytes), {
        bytes: Buffer,
        enums: String,
        longs: Number,
        defaults: true
      });
    } catch {
      return {};
    }
  }
  function handleWatchDevList(req, res) {
    const textMode = isGrpcWebText(req.headers["content-type"]);
    traceRpc("stream_open", { path: "/driver.DriverGrpc/watchDevList", textMode });
    writeHeaders(res, textMode);
    writeMessage(res, Types.DeviceList, { devList: options.bridge.enumerate(), type: 0 }, textMode);
    const interval = setInterval(() => {
      try {
        const list = options.bridge.enumerate();
        writeMessage(res, Types.DeviceList, { devList: list, type: 3 }, textMode);
      } catch {
        clearInterval(interval);
        if (!res.writableEnded) writeTrailer(res, textMode, "13");
      }
    }, 1500);
    res.on("close", () => clearInterval(interval));
  }
  function handleEmptyStream(req, res, messageType, initialPayload) {
    const textMode = isGrpcWebText(req.headers["content-type"]);
    writeHeaders(res, textMode);
    if (initialPayload) writeMessage(res, messageType, initialPayload, textMode);
    res.on("close", () => {
    });
  }
  function handleVenderStream(req, res) {
    const textMode = isGrpcWebText(req.headers["content-type"]);
    writeHeaders(res, textMode);
    const off = options.bridge.onVendor?.((msg) => {
      traceRpc("vender", { head: msg.subarray(0, 8).toString("hex") });
      if (!res.writableEnded) writeMessage(res, Types.VenderMsg, { msg }, textMode);
    });
    res.on("close", () => off?.());
  }
  function handleSystemInfoStream(req, res) {
    const textMode = isGrpcWebText(req.headers["content-type"]);
    writeHeaders(res, textMode);
    writeMessage(res, Types.SystemInfo, systemInfoPayload(), textMode);
    const interval = setInterval(() => {
      if (res.writableEnded) return;
      writeMessage(res, Types.SystemInfo, systemInfoPayload(), textMode);
    }, 1500);
    res.on("close", () => clearInterval(interval));
  }
  async function handleUnary(req, res, method, pathname) {
    const textMode = isGrpcWebText(req.headers["content-type"]);
    const body = await readBody(req);
    traceRpc("unary", { path: pathname, textMode, bodyLen: body.length });
    const request = decodeRequest(method, body);
    const handler = UnaryHandlers[pathname];
    if (!handler) {
      writeHeaders(res, textMode);
      writeTrailer(res, textMode, "12");
      return;
    }
    try {
      const payload = await handler(request);
      writeHeaders(res, textMode);
      writeMessage(res, method.res, payload, textMode);
      writeTrailer(res, textMode);
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown error";
      writeHeaders(res, textMode);
      const response = method.res === Types.ResSend ? { err: message } : method.res === Types.ResRead ? { err: message, msg: Buffer.alloc(0) } : {};
      writeMessage(res, method.res, response, textMode);
      writeTrailer(res, textMode, "13");
    }
  }
  return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "*"
      });
      res.end();
      return;
    }
    const pathname = new URL(req.url ?? "/", `http://${options.host}:${options.port}`).pathname;
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
      handleVenderStream(req, res);
      return;
    }
    if (pathname === "/driver.DriverGrpc/watchSystemInfo") {
      handleSystemInfoStream(req, res);
      return;
    }
    if (pathname === "/driver.DriverGrpc/upgradeOTAGATT") {
      handleEmptyStream(req, res, Types.Progress, { progress: 0, err: "not implemented" });
      return;
    }
    await handleUnary(req, res, method, pathname);
  });
}
var withTimeout = async (promise, ms, label) => {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
      })
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};

// src/bridges/node-usb-bridge.ts
import HID from "node-hid";
import fs3 from "fs";
import nodePath from "path";
import process2 from "process";
var DEFAULT_LOGICAL_PATH = "1";
var DEFAULT_REPORT_ID = Number.parseInt(process2.env.MONSGEEK_REPORT_ID ?? "0", 10);
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
function vendorInputReportIds(desc) {
  const ids = /* @__PURE__ */ new Set();
  let page = 0, id = 0, depth = 0, topPage = 0;
  for (let i = 0; i < desc.length; ) {
    const b = desc[i];
    if (b === 254) {
      i += 3 + desc[i + 1];
      continue;
    }
    const size = [0, 1, 2, 4][b & 3];
    let v = 0;
    for (let k = 0; k < size; k += 1) v |= desc[i + 1 + k] << 8 * k;
    const tag = b & 252;
    i += 1 + size;
    if (tag === 4) page = v >>> 0;
    else if (tag === 132) id = v;
    else if (tag === 160) {
      if (depth++ === 0) topPage = page;
    } else if (tag === 192) depth -= 1;
    else if (tag === 128 && topPage >= 65280) ids.add(id);
  }
  return ids;
}
var sysHidraw = (devPath) => `/sys/class/hidraw/${nodePath.basename(devPath)}/device`;
var usbDeviceOf = (devPath) => nodePath.dirname(nodePath.dirname(fs3.realpathSync(sysHidraw(devPath))));
var NodeUsbBridge = class {
  vid;
  forcedId;
  logicalPath = DEFAULT_LOGICAL_PATH;
  lastRead = /* @__PURE__ */ new Map();
  reportId = DEFAULT_REPORT_ID;
  hidPath = null;
  found = null;
  identifying = false;
  constructor(options) {
    this.vid = options.vid;
    this.forcedId = options.deviceId;
  }
  // Any RongYuan-based board (Attack Shark, MonsGeek, Akko, ...): its vendor collections sit on usage page 0xFF00+.
  // Many models share one USB pid, so the app's device id comes from the board itself (0x8f reply, bytes 1-2).
  enumerate() {
    const candidates = HID.devices().filter((d) => d.vendorId === this.vid && (d.usagePage ?? 0) >= 65280 && d.path).sort((x, y) => (y.usagePage ?? 0) - (x.usagePage ?? 0) || (x.usage === 2 ? -1 : y.usage === 2 ? 1 : 0));
    const dev = candidates.find((d) => d.path === this.found?.path);
    if (!dev) {
      this.found = null;
      this.hidPath = null;
      if (candidates.length) this.identify(candidates.map((d) => d.path));
      return [];
    }
    this.hidPath = dev.path;
    return [
      {
        dev: {
          devType: 0,
          is24: false,
          path: this.logicalPath,
          id: this.found.id,
          battery: 0,
          isOnline: true,
          vid: this.vid,
          pid: dev.productId
        }
      }
    ];
  }
  identify(paths) {
    if (this.identifying) return;
    this.identifying = true;
    const run = this.queue.then(async () => {
      for (const path4 of paths) {
        const id = this.forcedId || await this.askId(path4).catch(() => 0);
        if (!id) continue;
        this.found = { path: path4, id };
        console.log(`keyboard found: device id ${id} on ${path4}`);
        this.openVendorInputs(path4);
        return;
      }
      console.log("keyboard seen but it did not answer the id query (0x8f); set MONSGEEK_DEVICE_ID to its app device id");
    });
    this.queue = run.catch(() => {
    }).finally(() => this.identifying = false);
  }
  // Live messages (key travel for the Simulation Test, profile/light switches made on the keyboard) arrive as
  // vendor Input reports on another interface of the same keyboard. Forward only those, never normal key reports.
  vendorIn = [];
  vendorListeners = /* @__PURE__ */ new Set();
  onVendor(fn) {
    this.vendorListeners.add(fn);
    return () => this.vendorListeners.delete(fn);
  }
  openVendorInputs(featurePath) {
    this.vendorIn.forEach((d) => d.close());
    this.vendorIn = [];
    try {
      const mine = usbDeviceOf(featurePath);
      const paths = new Set(HID.devices().filter((d) => d.vendorId === this.vid && d.path).map((d) => d.path));
      for (const p of paths) {
        if (usbDeviceOf(p) !== mine) continue;
        const ids = vendorInputReportIds(fs3.readFileSync(`${sysHidraw(p)}/report_descriptor`));
        if (!ids.size) continue;
        const dev = new HID.HID(p);
        dev.on("data", (data) => {
          if (!ids.has(0) && !ids.has(data[0])) return;
          const msg = ids.has(0) ? Buffer.concat([Buffer.alloc(1), data]) : data;
          this.vendorListeners.forEach((fn) => fn(msg));
        });
        dev.on("error", () => {
          dev.close();
          this.vendorIn = this.vendorIn.filter((d) => d !== dev);
        });
        this.vendorIn.push(dev);
        console.log(`listening for keyboard messages on ${p} (report ${[...ids].join(",")})`);
      }
    } catch (error) {
      console.log(`no live keyboard messages: ${error.message}`);
    }
  }
  async askId(path4) {
    const device = new HID.HID(path4);
    try {
      for (const reportId of [this.reportId, 0, 1]) {
        try {
          await device.sendFeatureReport([reportId, ...applyChecksum(Uint8Array.of(143), "Bit7")]);
        } catch {
          continue;
        }
        for (let attempt = 0; attempt < 75; attempt += 1) {
          await sleep(4);
          let data;
          try {
            data = Buffer.from(await device.getFeatureReport(reportId, reportId === 0 ? 65 : 64));
          } catch {
            break;
          }
          if (data[1] === 143) data = data.subarray(1);
          if (data[0] === 143) {
            this.reportId = reportId;
            return data[1] | data[2] << 8;
          }
        }
      }
      return 0;
    } finally {
      device.close();
    }
  }
  resolveDevicePath(devicePath) {
    this.enumerate();
    if (devicePath === this.logicalPath || devicePath === "") return this.hidPath;
    if (devicePath === this.hidPath) return this.hidPath;
    return null;
  }
  device = null;
  devicePathOpen = null;
  // Keep one handle open: reopening per call made this board answer with zeros/stale replies.
  async withHid(devicePath, fn) {
    const resolved = this.resolveDevicePath(devicePath);
    if (!resolved) throw new Error(`cant find path ${devicePath}`);
    if (!this.device || this.devicePathOpen !== resolved) {
      this.device?.close();
      this.device = new HID.HID(resolved);
      this.devicePathOpen = resolved;
    }
    try {
      return await fn(this.device);
    } catch (error) {
      this.device.close();
      this.device = null;
      throw error;
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
      const candidates = [this.reportId, 0, 1, 2];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        for (const reportId of candidates) {
          try {
            const data = Buffer.from(await device.getFeatureReport(reportId, reportId === 0 ? 65 : 64));
            this.reportId = reportId;
            return reportId === 0 ? data.subarray(1) : data;
          } catch {
          }
        }
        await sleep(6);
      }
      throw new Error("failed to read feature report");
    });
  }
  fresh = null;
  queue = Promise.resolve();
  async send(devicePath, bytes, checksumType, raw = false) {
    const run = this.queue.then(async () => {
      const payload = raw ? padReport(bytes) : applyChecksum(bytes, checksumModeName(checksumType));
      const before = await this.getFeature(devicePath).catch(() => null);
      await this.setFeature(devicePath, payload);
      let response = null;
      for (const start = Date.now(); Date.now() - start < 100; ) {
        await sleep(4);
        response = await this.getFeature(devicePath).catch(() => null);
        if (response && (before ? !response.equals(before) : response[0] === payload[0])) break;
      }
      if (response) {
        this.fresh = response;
        this.lastRead.set(devicePath, response);
        this.lastRead.set(this.logicalPath, response);
      }
    });
    this.queue = run.catch(() => {
    });
    return run;
  }
  async read(devicePath) {
    await this.queue;
    if (this.fresh) {
      const response = this.fresh;
      this.fresh = null;
      return response;
    }
    try {
      const response = await this.getFeature(devicePath);
      this.lastRead.set(devicePath, response);
      this.lastRead.set(this.logicalPath, response);
      return response;
    } catch {
      return this.lastRead.get(devicePath) ?? this.lastRead.get(this.logicalPath) ?? Buffer.alloc(64, 0);
    }
  }
  clean(devicePath) {
    this.lastRead.delete(devicePath);
  }
};

// src/server-node.ts
var HOST = process3.env.MONSGEEK_HOST ?? "127.0.0.1";
var PORT = Number.parseInt(process3.env.MONSGEEK_PORT ?? "3814", 10);
var VERSION = process3.env.MONSGEEK_JS_VERSION ?? "223";
var DEVICE_ID = Number.parseInt(process3.env.MONSGEEK_DEVICE_ID ?? "0", 10) || void 0;
var thisFileDir = path3.dirname(fileURLToPath(import.meta.url));
var projectRoot = path3.resolve(thisFileDir, "..");
var protoRoot = process3.env.MONSGEEK_PROTO_ROOT ?? path3.join(projectRoot, "src");
var dbDir = process3.env.MONSGEEK_DB_DIR ?? path3.join(projectRoot, ".db");
var bridge = new NodeUsbBridge({
  vid: Number(process3.env.MONSGEEK_VID ?? 12625),
  deviceId: DEVICE_ID
});
var server = await createGrpcWebServer({
  host: HOST,
  port: PORT,
  rootDir: protoRoot,
  dbDir,
  version: VERSION,
  bridge
});
server.listen(PORT, HOST, () => {
  console.log(`monsgeek-ts-driver listening on http://${HOST}:${PORT}`);
});
var uiDir = path3.resolve(projectRoot, "..", "app", "dist");
var UI_PORT = Number.parseInt(process3.env.R85HE_UI_PORT ?? "38140", 10);
var TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".mp4": "video/mp4",
  ".wasm": "application/wasm"
};
if (fs4.existsSync(path3.join(uiDir, "index.html"))) {
  http2.createServer((req, res) => {
    if (req.url?.startsWith("/__cloud/")) return void cloud(req, res);
    let file;
    try {
      file = path3.join(uiDir, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
    } catch {
      return void res.writeHead(400).end();
    }
    if (!file.startsWith(uiDir + path3.sep) && file !== uiDir) return void res.writeHead(403).end();
    if (fs4.existsSync(file) && fs4.statSync(file).isDirectory()) file = path3.join(file, "index.html");
    fs4.readFile(file, (err, data) => {
      if (err) return void res.writeHead(404).end();
      res.writeHead(200, { "content-type": TYPES[path3.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
      res.end(data);
    });
  }).listen(UI_PORT, HOST, () => console.log(`app UI on http://${HOST}:${UI_PORT}/`));
}
var CLOUD_HOSTS = /^api\d*\.(rongyuan\.tech|qmk\.top)(:\d+)?$/;
async function cloud(req, res) {
  const [host, ...rest] = req.url.slice("/__cloud/".length).split("/");
  if (!CLOUD_HOSTS.test(host)) return void res.writeHead(403).end();
  if (/get_fw_version|\/download\/(?!bit_image_file)/.test(req.url)) return void res.writeHead(403).end();
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const headers = {};
  for (const name of ["content-type", "cookie", "authorization", "accept"]) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  try {
    const upstream = await fetch(`https://${host}/${rest.join("/")}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? void 0 : Buffer.concat(chunks),
      signal: AbortSignal.timeout(3e4)
    });
    const out = { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" };
    const cookies = upstream.headers.getSetCookie().map((c) => c.replace(/;\s*(domain=[^;]*|secure)/gi, ""));
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(upstream.status, out).end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    res.writeHead(502).end(String(error));
  }
}
//# sourceMappingURL=server-node.js.map