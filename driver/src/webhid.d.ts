interface HIDDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly opened: boolean;
  open(): Promise<void>;
  sendFeatureReport(reportId: number, data: ArrayBufferLike | ArrayBufferView): Promise<void>;
  receiveFeatureReport(reportId: number): Promise<DataView>;
}

interface HID {
  requestDevice(options?: { filters?: Array<{ vendorId?: number; productId?: number }> }): Promise<HIDDevice[]>;
  getDevices(): Promise<HIDDevice[]>;
}

interface Navigator {
  readonly hid: HID;
}
