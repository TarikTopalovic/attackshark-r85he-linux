import { applyChecksum, checksumModeName, padReport } from "../protocol";
import type { DeviceBridge, DeviceListEntry } from "../types";

const REPORT_ID = 0;
const FEATURE_REPORT_LENGTH = 64;

export interface WebHidBridgeOptions {
  vid: number;
  pid: number;
  defaultDeviceId: number;
}

export class WebHidBridge implements DeviceBridge {
  private readonly vid: number;
  private readonly pid: number;
  private readonly defaultDeviceId: number;
  private readonly devices = new Map<string, HIDDevice>();
  private readonly lastRead = new Map<string, Uint8Array>();

  constructor(options: WebHidBridgeOptions) {
    this.vid = options.vid;
    this.pid = options.pid;
    this.defaultDeviceId = options.defaultDeviceId;
  }

  async requestDevice(): Promise<void> {
    const selected = await navigator.hid.requestDevice({
      filters: [{ vendorId: this.vid, productId: this.pid }],
    });

    for (const device of selected) {
      const path = this.pathFor(device);
      this.devices.set(path, device);
    }
  }

  async hydrateKnownDevices(): Promise<void> {
    const granted = await navigator.hid.getDevices();
    for (const device of granted) {
      if (device.vendorId === this.vid && device.productId === this.pid) {
        this.devices.set(this.pathFor(device), device);
      }
    }
  }

  enumerate(): DeviceListEntry[] {
    const list: DeviceListEntry[] = [];
    for (const [devicePath] of this.devices) {
      list.push({
        dev: {
          devType: 0,
          is24: false,
          path: devicePath,
          id: this.defaultDeviceId,
          battery: 0,
          isOnline: true,
          vid: this.vid,
          pid: this.pid,
        },
      });
    }
    return list;
  }

  private pathFor(device: HIDDevice): string {
    return `webhid:${device.vendorId}:${device.productId}:${device.productName ?? "unknown"}`;
  }

  private getDevice(devicePath: string): HIDDevice {
    const device = this.devices.get(devicePath);
    if (!device) throw new Error(`device not found: ${devicePath}`);
    return device;
  }

  private async withOpenDevice<T>(devicePath: string, fn: (device: HIDDevice) => Promise<T>): Promise<T> {
    const device = this.getDevice(devicePath);
    if (!device.opened) await device.open();
    return fn(device);
  }

  private async setFeature(devicePath: string, payload: Uint8Array): Promise<void> {
    await this.withOpenDevice(devicePath, async (device) => {
      await device.sendFeatureReport(REPORT_ID, payload);
    });
  }

  private async getFeature(devicePath: string): Promise<Buffer> {
    return this.withOpenDevice(devicePath, async (device) => {
      const data = await device.receiveFeatureReport(REPORT_ID);
      return Buffer.from(data.buffer.slice(0, FEATURE_REPORT_LENGTH));
    });
  }

  async send(devicePath: string, bytes: Uint8Array, checksumType: number | string, raw = false): Promise<void> {
    const payload = raw ? padReport(bytes) : applyChecksum(bytes, checksumModeName(checksumType));
    await this.setFeature(devicePath, payload);
    const response = await this.getFeature(devicePath);
    this.lastRead.set(devicePath, response);
  }

  async read(devicePath: string): Promise<Uint8Array> {
    const response = await this.getFeature(devicePath);
    this.lastRead.set(devicePath, response);
    return response;
  }

  clean(devicePath: string): void {
    this.lastRead.delete(devicePath);
  }
}
