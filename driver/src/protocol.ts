import type { ChecksumMode } from "./types";

export function checksumModeName(value: number | string): ChecksumMode {
  if (value === 0 || value === "Bit7") return "Bit7";
  if (value === 1 || value === "Bit8") return "Bit8";
  return "None";
}

export function padReport(bytes: Uint8Array): Buffer {
  const payload = Buffer.alloc(64, 0);
  Buffer.from(bytes).copy(payload, 0, 0, Math.min(bytes.length, 64));
  return payload;
}

export function applyChecksum(bytes: Uint8Array, mode: ChecksumMode): Buffer {
  const payload = padReport(bytes);
  if (mode === "None") return payload;

  // RongYuan checksum: byte N = 255 - sum(bytes 0..N-1); Bit7 -> N=7, Bit8 -> N=8 (verified on R85HE 3151:5029).
  const at = mode === "Bit7" ? 7 : 8;
  let sum = 0;
  for (let index = 0; index < at; index += 1) sum += payload[index];
  payload[at] = (255 - (sum & 0xff)) & 0xff;
  return payload;
}

export function encodeFrame(buffer: Uint8Array, trailer = false): Buffer {
  const header = Buffer.alloc(5);
  header[0] = trailer ? 0x80 : 0x00;
  header.writeUInt32BE(buffer.length, 1);
  return Buffer.concat([header, Buffer.from(buffer)]);
}

export function decodeGrpcWebBody(bodyBuffer: Buffer): Buffer {
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

