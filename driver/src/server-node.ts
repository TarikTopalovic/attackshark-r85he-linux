import "dotenv/config";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createGrpcWebServer } from "./grpc-web-server";
import { NodeUsbBridge } from "./bridges/node-usb-bridge";

const HOST = process.env.MONSGEEK_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.MONSGEEK_PORT ?? "3814", 10);
const VERSION = process.env.MONSGEEK_JS_VERSION ?? "223";
const DEVICE_ID = Number.parseInt(process.env.MONSGEEK_DEVICE_ID ?? "0", 10) || undefined;

const thisFileDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(thisFileDir, "..");
const protoRoot = process.env.MONSGEEK_PROTO_ROOT ?? path.join(projectRoot, "src");
const dbDir = process.env.MONSGEEK_DB_DIR ?? path.join(projectRoot, ".db");

const bridge = new NodeUsbBridge({
  vid: Number(process.env.MONSGEEK_VID ?? 0x3151),
  deviceId: DEVICE_ID,
});

const server = await createGrpcWebServer({
  host: HOST,
  port: PORT,
  rootDir: protoRoot,
  dbDir,
  version: VERSION,
  bridge,
});

server.listen(PORT, HOST, () => {
  console.log(`monsgeek-ts-driver listening on http://${HOST}:${PORT}`);
});

// Serve the vendor app UI (../app/dist) so no other web server is needed.
const uiDir = path.resolve(projectRoot, "..", "app", "dist");
const UI_PORT = Number.parseInt(process.env.R85HE_UI_PORT ?? "38140", 10);
const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".ico": "image/x-icon", ".woff": "font/woff", ".woff2": "font/woff2",
  ".ttf": "font/ttf", ".mp4": "video/mp4", ".wasm": "application/wasm",
};
if (fs.existsSync(path.join(uiDir, "index.html"))) {
  http
    .createServer((req, res) => {
      if (req.url?.startsWith("/__cloud/")) return void cloud(req, res);
      let file: string;
      try {
        file = path.join(uiDir, decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname));
      } catch {
        return void res.writeHead(400).end();
      }
      if (!file.startsWith(uiDir + path.sep) && file !== uiDir) return void res.writeHead(403).end();
      if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, "index.html");
      fs.readFile(file, (err, data) => {
        if (err) return void res.writeHead(404).end();
        res.writeHead(200, { "content-type": TYPES[path.extname(file).toLowerCase()] ?? "application/octet-stream", "cache-control": "no-cache" });
        res.end(data);
      });
    })
    .listen(UI_PORT, HOST, () => console.log(`app UI on http://${HOST}:${UI_PORT}/`));
}

// The app's account/community calls go to the vendor's servers, which refuse browser pages (Origin check, no CORS).
// install.sh points them at /__cloud/<host>/...; forward them from here, only to the vendor's own hosts.
const CLOUD_HOSTS = /^api\d*\.(rongyuan\.tech|qmk\.top)(:\d+)?$/;
async function cloud(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const [host, ...rest] = req.url!.slice("/__cloud/".length).split("/");
  if (!CLOUD_HOSTS.test(host)) return void res.writeHead(403).end();
  // Never fetch firmware: flashing through this driver is not validated and a failed flash can brick the keyboard.
  if (/get_fw_version|\/download\/(?!bit_image_file)/.test(req.url!)) return void res.writeHead(403).end();
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "cookie", "authorization", "accept"]) {
    const value = req.headers[name];
    if (typeof value === "string") headers[name] = value;
  }
  try {
    const upstream = await fetch(`https://${host}/${rest.join("/")}`, {
      method: req.method,
      headers,
      body: req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks),
      signal: AbortSignal.timeout(30000),
    });
    const out: Record<string, string | string[]> = { "content-type": upstream.headers.get("content-type") ?? "application/octet-stream" };
    // Keep the session cookie on this origin: drop the vendor's Domain and Secure attributes.
    const cookies = upstream.headers.getSetCookie().map((c) => c.replace(/;\s*(domain=[^;]*|secure)/gi, ""));
    if (cookies.length) out["set-cookie"] = cookies;
    res.writeHead(upstream.status, out).end(Buffer.from(await upstream.arrayBuffer()));
  } catch (error) {
    res.writeHead(502).end(String(error));
  }
}
