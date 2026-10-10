import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import protobuf from "protobufjs";
import { JsonDbStore } from "./db";
import { decodeGrpcWebBody, encodeFrame } from "./protocol";
import type { DeviceBridge } from "./types";

export interface GrpcWebServerOptions {
  host: string;
  port: number;
  rootDir: string;
  dbDir: string;
  version: string;
  bridge: DeviceBridge;
}

function isGrpcWebText(contentType: string | string[] | undefined): boolean {
  return String(contentType ?? "").toLowerCase().includes("grpc-web-text");
}

function writeChunk(res: http.ServerResponse, frame: Buffer, textMode: boolean, end = false): void {
  if (textMode) {
    const payload = frame.toString("base64");
    if (end) res.end(payload);
    else res.write(payload);
    return;
  }

  if (end) res.end(frame);
  else res.write(frame);
}

function decodeGrpcWebBodyAuto(bodyBuffer: Buffer): Buffer {
  let wireBody = bodyBuffer;
  const maybeTextBody = bodyBuffer.toString("utf8").trim();
  if (/^[A-Za-z0-9+/=\r\n]+$/.test(maybeTextBody) && maybeTextBody.length > 0) {
    try {
      wireBody = Buffer.from(maybeTextBody.replace(/\s+/g, ""), "base64");
    } catch {}
  }
  return decodeGrpcWebBody(wireBody);
}

export async function createGrpcWebServer(options: GrpcWebServerOptions): Promise<http.Server> {
  const rpcTraceFile = path.join(options.dbDir, "ts-rpc-trace.log");
  const traceRpc = (type: string, payload: Record<string, unknown>): void => {
    if (!process.env.MONSGEEK_TRACE) return; // opt-in: the log grows without bound
    fs.mkdirSync(options.dbDir, { recursive: true });
    fs.appendFileSync(rpcTraceFile, `${new Date().toISOString()} ${JSON.stringify({ type, ...payload })}\n`);
  };

  const toHex = (input: Uint8Array | Buffer | undefined, count = 16): string => {
    if (!input) return "";
    return Buffer.from(input)
      .subarray(0, count)
      .toString("hex")
      .replace(/(.{2})/g, "$1 ")
      .trim();
  };

  const root = await protobuf.load(path.join(options.rootDir, "driver.proto"));
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
    WeatherRes: root.lookupType("driver.WeatherRes"),
  } as const;

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
    "/driver.DriverGrpc/getWeather": { req: Types.WeatherReq, res: Types.WeatherRes },
  } as const;

  const dbPathError = (dbPath: unknown): string => {
    const normalized = String(dbPath ?? "");
    if (normalized.startsWith("/")) return "IO error: Read-only file system (os error 30)";
    return "";
  };

  const UnaryHandlers: Record<string, (request: any) => Promise<any>> = {
    "/driver.DriverGrpc/sendMsg": async (request) => {
      traceRpc("sendMsg_req", {
        devicePath: request.devicePath,
        len: (request.msg as Uint8Array | undefined)?.length ?? 0,
        head: toHex(request.msg as Uint8Array | undefined),
        checkSumType: request.checkSumType,
      });
      await withTimeout(options.bridge.send(request.devicePath, request.msg, request.checkSumType, false), 1200, "sendMsg");
      traceRpc("sendMsg_ok", { devicePath: request.devicePath });
      return { err: "" };
    },
    "/driver.DriverGrpc/readMsg": async (request) => {
      const msg = await withTimeout(options.bridge.read(request.devicePath), 1200, "readMsg");
      traceRpc("readMsg_res", {
        devicePath: request.devicePath,
        len: (msg as Uint8Array | undefined)?.length ?? 0,
        head: toHex(msg as Uint8Array | undefined),
      });
      return { err: "", msg };
    },
    "/driver.DriverGrpc/sendRawFeature": async (request) => {
      await withTimeout(
        options.bridge.send(request.devicePath, request.msg, request.checkSumType, true),
        1200,
        "sendRawFeature",
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
      timeStamp: String(Date.now()),
    }),
    "/driver.DriverGrpc/getWeather": async () => ({ res: "" }),
  };

  function writeHeaders(res: http.ServerResponse, textMode: boolean): void {
    res.writeHead(200, {
      // protobuf-ts picks the decoder from this header, so text replies must say text.
      "content-type": textMode ? "application/grpc-web-text" : "application/grpc-web+proto",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "*",
      "access-control-expose-headers": "*",
      "grpc-accept-encoding": "identity",
      "grpc-encoding": "identity",
      "transfer-encoding": "chunked",
      "x-grpc-web": "1",
    });
  }

  function writeTrailer(res: http.ServerResponse, textMode: boolean, grpcStatus = "0"): void {
    const trailer = `grpc-status:${grpcStatus}\r\n`;
    writeChunk(res, encodeFrame(Buffer.from(trailer, "utf8"), true), textMode, true);
  }

  function writeMessage(res: http.ServerResponse, messageType: protobuf.Type, payload: unknown, textMode: boolean): void {
    const encoded = messageType.encode(messageType.fromObject(payload as Record<string, unknown>)).finish();
    writeChunk(res, encodeFrame(Buffer.from(encoded)), textMode);
  }

  function systemInfoPayload(): Record<string, number> {
    let diskSpaceTotal = 0;
    let diskSpceAvailable = 0;
    try {
      const stats = fs.statfsSync(process.cwd(), { bigint: true });
      const bsize = Number(stats.bsize);
      const blocks = Number(stats.blocks);
      const bavail = Number(stats.bavail);
      if (Number.isFinite(bsize) && Number.isFinite(blocks)) diskSpaceTotal = bsize * blocks;
      if (Number.isFinite(bsize) && Number.isFinite(bavail)) diskSpceAvailable = bsize * bavail;
    } catch {}

    const memTotal = os.totalmem();
    const memUsed = Math.max(0, memTotal - os.freemem());
    const cpuCount = Math.max(1, os.cpus().length);
    const cpuUsage = Math.max(0, (os.loadavg()[0] / cpuCount) * 100);

    return {
      diskSpaceTotal,
      diskSpceAvailable,
      netWorkTotalUp: 0,
      netWorkTotalDown: 0,
      cpuTemperater: 0,
      memTotal,
      memUsed,
      cpuUsage,
    };
  }

  async function readBody(req: http.IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  function decodeRequest(method: { req: protobuf.Type }, bodyBuffer: Buffer): any {
    const messageBytes = decodeGrpcWebBodyAuto(bodyBuffer);
    if (!messageBytes.length) return {};
    try {
      return method.req.toObject(method.req.decode(messageBytes), {
        bytes: Buffer,
        enums: String,
        longs: Number,
        defaults: true,
      });
    } catch {
      return {};
    }
  }

  function handleWatchDevList(req: http.IncomingMessage, res: http.ServerResponse): void {
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

  function handleEmptyStream(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    messageType: protobuf.Type,
    initialPayload: unknown | null,
  ): void {
    const textMode = isGrpcWebText(req.headers["content-type"]);
    writeHeaders(res, textMode);
    if (initialPayload) writeMessage(res, messageType, initialPayload, textMode);
    res.on("close", () => {});
  }

  function handleVenderStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    const textMode = isGrpcWebText(req.headers["content-type"]);
    writeHeaders(res, textMode);
    const off = options.bridge.onVendor?.((msg) => {
      traceRpc("vender", { head: msg.subarray(0, 8).toString("hex") });
      if (!res.writableEnded) writeMessage(res, Types.VenderMsg, { msg }, textMode);
    });
    res.on("close", () => off?.());
  }

  function handleSystemInfoStream(req: http.IncomingMessage, res: http.ServerResponse): void {
    const textMode = isGrpcWebText(req.headers["content-type"]);
    writeHeaders(res, textMode);
    writeMessage(res, Types.SystemInfo, systemInfoPayload(), textMode);

    const interval = setInterval(() => {
      if (res.writableEnded) return;
      writeMessage(res, Types.SystemInfo, systemInfoPayload(), textMode);
    }, 1500);

    res.on("close", () => clearInterval(interval));
  }

  async function handleUnary(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    method: { req: protobuf.Type; res: protobuf.Type },
    pathname: string,
  ): Promise<void> {
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
      const response =
        method.res === Types.ResSend
          ? { err: message }
          : method.res === Types.ResRead
            ? { err: message, msg: Buffer.alloc(0) }
            : {};
      writeMessage(res, method.res, response, textMode);
      writeTrailer(res, textMode, "13");
    }
  }

  return http.createServer(async (req, res) => {
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "POST, OPTIONS",
        "access-control-allow-headers": "*",
      });
      res.end();
      return;
    }

    const pathname = new URL(req.url ?? "/", `http://${options.host}:${options.port}`).pathname;
    const method = Methods[pathname as keyof typeof Methods];
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

const withTimeout = async <T>(promise: Promise<T>, ms: number, label: string): Promise<T> => {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timeout`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
};
