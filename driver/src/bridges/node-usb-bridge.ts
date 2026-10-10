import HID from "node-hid";
import fs from "node:fs";
import nodePath from "node:path";
import process from "node:process";
import { applyChecksum, checksumModeName, padReport } from "../protocol";
import type { DeviceBridge, DeviceListEntry } from "../types";

const DEFAULT_LOGICAL_PATH = "1";
const DEFAULT_REPORT_ID = Number.parseInt(process.env.MONSGEEK_REPORT_ID ?? "0", 10);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Report ids of the Input reports inside vendor-defined (usage page 0xFF00+) top-level collections.
function vendorInputReportIds(desc: Buffer): Set<number> {
  const ids = new Set<number>();
  let page = 0, id = 0, depth = 0, topPage = 0;
  for (let i = 0; i < desc.length; ) {
    const b = desc[i];
    if (b === 0xfe) { i += 3 + desc[i + 1]; continue; } // long item
    const size = [0, 1, 2, 4][b & 3];
    let v = 0;
    for (let k = 0; k < size; k += 1) v |= desc[i + 1 + k] << (8 * k);
    const tag = b & 0xfc;
    i += 1 + size;
    if (tag === 0x04) page = v >>> 0;
    else if (tag === 0x84) id = v;
    else if (tag === 0xa0) { if (depth++ === 0) topPage = page; }
    else if (tag === 0xc0) depth -= 1;
    else if (tag === 0x80 && topPage >= 0xff00) ids.add(id);
  }
  return ids;
}

const sysHidraw = (devPath: string) => `/sys/class/hidraw/${nodePath.basename(devPath)}/device`;
const usbDeviceOf = (devPath: string) => nodePath.dirname(nodePath.dirname(fs.realpathSync(sysHidraw(devPath))));

export interface NodeUsbBridgeOptions {
  vid: number;
  // Skip asking the board (0x8f) and use this app device id.
  deviceId?: number;
}

export class NodeUsbBridge implements DeviceBridge {
  private readonly vid: number;
  private readonly forcedId: number | undefined;
  private readonly logicalPath = DEFAULT_LOGICAL_PATH;
  private readonly lastRead = new Map<string, Uint8Array>();
  private reportId = DEFAULT_REPORT_ID;
  private hidPath: string | null = null;
  private found: { path: string; id: number } | null = null;
  private identifying = false;

  constructor(options: NodeUsbBridgeOptions) {
    this.vid = options.vid;
    this.forcedId = options.deviceId;
  }

  // Any RongYuan-based board (Attack Shark, MonsGeek, Akko, ...): its vendor collections sit on usage page 0xFF00+.
  // Many models share one USB pid, so the app's device id comes from the board itself (0x8f reply, bytes 1-2).
  enumerate(): DeviceListEntry[] {
    const candidates = HID.devices()
      .filter((d) => d.vendorId === this.vid && (d.usagePage ?? 0) >= 0xff00 && d.path)
      .sort((x, y) => (y.usagePage ?? 0) - (x.usagePage ?? 0) || (x.usage === 2 ? -1 : y.usage === 2 ? 1 : 0));
    const dev = candidates.find((d) => d.path === this.found?.path);
    if (!dev) {
      this.found = null;
      this.hidPath = null;
      if (candidates.length) this.identify(candidates.map((d) => d.path!));
      return [];
    }
    this.hidPath = dev.path!;
    return [
      {
        dev: {
          devType: 0,
          is24: false,
          path: this.logicalPath,
          id: this.found!.id,
          battery: 0,
          isOnline: true,
          vid: this.vid,
          pid: dev.productId,
        },
      },
    ];
  }

  private identify(paths: string[]): void {
    if (this.identifying) return;
    this.identifying = true;
    const run = this.queue.then(async () => {
      for (const path of paths) {
        const id = this.forcedId || (await this.askId(path).catch(() => 0));
        if (!id) continue;
        this.found = { path, id };
        console.log(`keyboard found: device id ${id} on ${path}`);
        this.openVendorInputs(path);
        return;
      }
      console.log("keyboard seen but it did not answer the id query (0x8f); set MONSGEEK_DEVICE_ID to its app device id");
    });
    this.queue = run.catch(() => {}).finally(() => (this.identifying = false));
  }

  // Live messages (key travel for the Simulation Test, profile/light switches made on the keyboard) arrive as
  // vendor Input reports on another interface of the same keyboard. Forward only those, never normal key reports.
  private vendorIn: HID.HID[] = [];
  private readonly vendorListeners = new Set<(msg: Buffer) => void>();

  onVendor(fn: (msg: Buffer) => void): () => void {
    this.vendorListeners.add(fn);
    return () => this.vendorListeners.delete(fn);
  }

  private openVendorInputs(featurePath: string): void {
    this.vendorIn.forEach((d) => d.close());
    this.vendorIn = [];
    try {
      const mine = usbDeviceOf(featurePath);
      const paths = new Set(HID.devices().filter((d) => d.vendorId === this.vid && d.path).map((d) => d.path!));
      for (const p of paths) {
        if (usbDeviceOf(p) !== mine) continue;
        const ids = vendorInputReportIds(fs.readFileSync(`${sysHidraw(p)}/report_descriptor`));
        if (!ids.size) continue;
        const dev = new HID.HID(p);
        dev.on("data", (data: Buffer) => {
          if (!ids.has(0) && !ids.has(data[0])) return;
          const msg = ids.has(0) ? Buffer.concat([Buffer.alloc(1), data]) : data; // the app expects byte 0 = report id
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
      console.log(`no live keyboard messages: ${(error as Error).message}`);
    }
  }

  private async askId(path: string): Promise<number> {
    const device = new HID.HID(path);
    try {
      for (const reportId of [this.reportId, 0, 1]) {
        try {
          await device.sendFeatureReport([reportId, ...applyChecksum(Uint8Array.of(0x8f), "Bit7")]);
        } catch {
          continue;
        }
        for (let attempt = 0; attempt < 75; attempt += 1) {
          await sleep(4);
          let data: Buffer;
          try {
            data = Buffer.from(await device.getFeatureReport(reportId, reportId === 0 ? 65 : 64));
          } catch {
            break;
          }
          if (data[1] === 0x8f) data = data.subarray(1);
          if (data[0] === 0x8f) {
            this.reportId = reportId;
            return data[1] | (data[2] << 8);
          }
        }
      }
      return 0;
    } finally {
      device.close();
    }
  }

  private resolveDevicePath(devicePath: string): string | null {
    this.enumerate();
    if (devicePath === this.logicalPath || devicePath === "") return this.hidPath;
    if (devicePath === this.hidPath) return this.hidPath;
    return null;
  }

  private device: HID.HID | null = null;
  private devicePathOpen: string | null = null;

  // Keep one handle open: reopening per call made this board answer with zeros/stale replies.
  private async withHid<T>(devicePath: string, fn: (device: HID.HID) => Promise<T>): Promise<T> {
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

  private async setFeature(devicePath: string, payload: Uint8Array): Promise<void> {
    const data = [this.reportId, ...Buffer.from(payload)];
    await this.withHid(devicePath, async (device) => {
      await device.sendFeatureReport(data);
    });
  }

  private async getFeature(devicePath: string): Promise<Buffer> {
    return this.withHid(devicePath, async (device) => {
      const candidates = [this.reportId, 0, 1, 2];
      for (let attempt = 0; attempt < 8; attempt += 1) {
        for (const reportId of candidates) {
          try {
            // hidraw prefixes the report number, so an unnumbered (id 0) report needs 65 bytes; drop the prefix.
            const data = Buffer.from(await device.getFeatureReport(reportId, reportId === 0 ? 65 : 64));
            this.reportId = reportId;
            return reportId === 0 ? data.subarray(1) : data;
          } catch {}
        }
        await sleep(6);
      }
      throw new Error("failed to read feature report");
    });
  }

  private fresh: Buffer | null = null;
  private queue: Promise<unknown> = Promise.resolve();

  async send(devicePath: string, bytes: Uint8Array, checksumType: number | string, raw = false): Promise<void> {
    const run = this.queue.then(async () => {
      const payload = raw ? padReport(bytes) : applyChecksum(bytes, checksumModeName(checksumType));
      const before = await this.getFeature(devicePath).catch(() => null);
      await this.setFeature(devicePath, payload);
      // The board answers ~16 ms later; until then a read returns the previous reply. Wait for the new one.
      let response: Buffer | null = null;
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
    this.queue = run.catch(() => {});
    return run;
  }

  async read(devicePath: string): Promise<Uint8Array> {
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

  clean(devicePath: string): void {
    this.lastRead.delete(devicePath);
  }
}
