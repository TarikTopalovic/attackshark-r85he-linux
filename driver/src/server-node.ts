import "dotenv/config";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { createGrpcWebServer } from "./grpc-web-server";
import { NodeUsbBridge } from "./bridges/node-usb-bridge";

const HOST = process.env.MONSGEEK_HOST ?? "127.0.0.1";
const PORT = Number.parseInt(process.env.MONSGEEK_PORT ?? "3814", 10);
const VERSION = process.env.MONSGEEK_JS_VERSION ?? "223";
const DEVICE_ID = Number.parseInt(process.env.MONSGEEK_DEVICE_ID ?? "2648", 10);

const thisFileDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(thisFileDir, "..");
const protoRoot = process.env.MONSGEEK_PROTO_ROOT ?? path.join(projectRoot, "src");
const dbDir = process.env.MONSGEEK_DB_DIR ?? path.join(projectRoot, ".db");

const bridge = new NodeUsbBridge({
  vid: 0x3151,
  pid: Number(process.env.MONSGEEK_PID ?? 0x502d),
  defaultDeviceId: DEVICE_ID,
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
