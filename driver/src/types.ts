export type ChecksumMode = "Bit7" | "Bit8" | "None";

export interface DeviceIdentity {
  devType: number;
  is24: boolean;
  path: string;
  id: number;
  battery: number;
  isOnline: boolean;
  vid: number;
  pid: number;
}

export interface DeviceListEntry {
  dev?: DeviceIdentity;
  dangleCommonDev?: unknown;
}

export interface SendRequest {
  devicePath: string;
  msg: Uint8Array;
  checkSumType: number | string;
}

export interface ReadRequest {
  devicePath: string;
}

export interface DeviceBridge {
  enumerate(): DeviceListEntry[];
  send(devicePath: string, bytes: Uint8Array, checksumType: number | string, raw?: boolean): Promise<void>;
  read(devicePath: string): Promise<Uint8Array>;
  clean(devicePath: string): void;
}
