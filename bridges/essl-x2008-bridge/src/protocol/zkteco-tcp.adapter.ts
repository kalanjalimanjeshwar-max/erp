import net from 'net';
import {
  BiometricVerifyType,
  DeviceAttendanceRecord,
  DeviceEnrolledUser,
  DeviceInfo,
  IBiometricProtocolAdapter,
  ProtocolConnectOptions,
  PunchInOutMode,
} from '../types.js';

// ZKTeco Standalone Pull TCP Protocol Constants (Port 4370 / ZLM60_TFT compatible)
export const ZK_TCP_START_TAG = 0x5050827d; // Little-endian header bytes: 7d 82 50 50 -> wait: uint32BE 0x5050827d = bytes [0x50, 0x50, 0x82, 0x7d]
export const ZK_CMD = {
  CONNECT: 1000,
  EXIT: 1001,
  ENABLE_DEVICE: 1002,
  DISABLE_DEVICE: 1003,
  AUTH: 1102,
  USERTEMP_RRQ: 9,
  OPTIONS_RRQ: 11,
  ATTLOG_RRQ: 13,
  GET_VERSION: 1100,
  PREPARE_DATA: 1500,
  DATA: 1501,
  FREE_DATA: 1502,
  ACK_OK: 2000,
  ACK_ERROR: 2001,
  ACK_DATA: 2002,
  ACK_RETRY: 2003,
  ACK_REPEAT: 2004,
  ACK_UNAUTH: 2005,
} as const;

const TCP_MAGIC = Buffer.from([0x50, 0x50, 0x82, 0x7d]);

/**
 * Computes ZKTeco 16-bit 1's complement checksum over a ZK command packet (bytes 2..3 zeroed).
 */
export function computeZkChecksum(packet: Buffer): number {
  let sum = 0;
  for (let i = 0; i < packet.length; i += 2) {
    if (i === 2) continue; // skip checksum field itself
    if (i + 1 < packet.length) {
      sum += packet.readUInt16LE(i);
    } else {
      sum += packet[i];
    }
    while (sum > 0xffff) {
      sum = (sum & 0xffff) + (sum >>> 16);
    }
  }
  return (~sum) & 0xffff;
}

/**
 * Generates scrambled 4-byte ZKTeco CommKey challenge buffer for CMD_AUTH (1102).
 */
export function encodeZkCommKey(commKey: number, sessionId: number, ticks = 50): Buffer {
  let reversed = 0;
  const unsignedKey = commKey >>> 0;
  for (let i = 0; i < 32; i++) {
    reversed = ((reversed << 1) | ((unsignedKey >>> i) & 1)) >>> 0;
  }
  const mixed = (reversed + (sessionId & 0xffff)) >>> 0;

  const buf = Buffer.allocUnsafe(4);
  buf.writeUInt32LE(mixed, 0);

  // XOR with 'ZKSO'
  const xored = Buffer.from([
    buf[0] ^ 0x5a,
    buf[1] ^ 0x4b,
    buf[2] ^ 0x53,
    buf[3] ^ 0x4f,
  ]);

  // Swap 16-bit halves
  const swapped = Buffer.from([xored[2], xored[3], xored[0], xored[1]]);
  const b = ticks & 0xff;
  return Buffer.from([swapped[0] ^ b, swapped[1] ^ b, b, swapped[3] ^ b]);
}

/**
 * Builds a complete ZKTeco TCP wire frame: [50 50 82 7d] + [lenLE:4] + [zkPacket]
 */
export function buildZkTcpFrame(
  command: number,
  sessionId: number,
  replyId: number,
  data: Buffer = Buffer.alloc(0)
): Buffer {
  const zkPacket = Buffer.alloc(8 + data.length);
  zkPacket.writeUInt16LE(command & 0xffff, 0);
  zkPacket.writeUInt16LE(0, 2);
  zkPacket.writeUInt16LE(sessionId & 0xffff, 4);
  zkPacket.writeUInt16LE(replyId & 0xffff, 6);
  if (data.length > 0) {
    data.copy(zkPacket, 8);
  }
  const checksum = computeZkChecksum(zkPacket);
  zkPacket.writeUInt16LE(checksum, 2);

  const frame = Buffer.allocUnsafe(8 + zkPacket.length);
  TCP_MAGIC.copy(frame, 0);
  frame.writeUInt32LE(zkPacket.length, 4);
  zkPacket.copy(frame, 8);
  return frame;
}

export interface ParsedZkFrame {
  command: number;
  checksum: number;
  sessionId: number;
  replyId: number;
  payload: Buffer;
}

/**
 * Extracts complete TCP ZK frames from a streaming byte buffer.
 */
export function extractZkTcpFrames(buffer: Buffer): { frames: ParsedZkFrame[]; remaining: Buffer } {
  const frames: ParsedZkFrame[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    // Locate TCP magic header if stream offset needs synchronization
    if (
      buffer[offset] !== TCP_MAGIC[0] ||
      buffer[offset + 1] !== TCP_MAGIC[1] ||
      buffer[offset + 2] !== TCP_MAGIC[2] ||
      buffer[offset + 3] !== TCP_MAGIC[3]
    ) {
      const nextMagic = buffer.indexOf(TCP_MAGIC, offset + 1);
      if (nextMagic === -1) {
        return { frames, remaining: Buffer.alloc(0) };
      }
      offset = nextMagic;
      if (offset + 8 > buffer.length) break;
    }

    const packetLen = buffer.readUInt32LE(offset + 4);
    if (packetLen < 8 || packetLen > 16 * 1024 * 1024) {
      // Corrupt frame header; advance past magic and continue
      offset += 4;
      continue;
    }

    if (offset + 8 + packetLen > buffer.length) {
      break; // Wait for more bytes
    }

    const zkPacket = buffer.subarray(offset + 8, offset + 8 + packetLen);
    frames.push({
      command: zkPacket.readUInt16LE(0),
      checksum: zkPacket.readUInt16LE(2),
      sessionId: zkPacket.readUInt16LE(4),
      replyId: zkPacket.readUInt16LE(6),
      payload: zkPacket.subarray(8),
    });

    offset += 8 + packetLen;
  }

  return {
    frames,
    remaining: offset < buffer.length ? Buffer.from(buffer.subarray(offset)) : Buffer.alloc(0),
  };
}

/**
 * Decodes ZKTeco packed 32-bit local timestamp integer.
 */
export function decodeZkTimestamp(packed: number): {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
} {
  let t = packed >>> 0;
  const second = t % 60;
  t = Math.floor(t / 60);
  const minute = t % 60;
  t = Math.floor(t / 60);
  const hour = t % 24;
  t = Math.floor(t / 24);
  const day = (t % 31) + 1;
  t = Math.floor(t / 31);
  const month = (t % 12) + 1;
  const year = Math.floor(t / 12) + 2000;

  return { year, month, day, hour, minute, second };
}

export function mapZkVerifyType(code: number): BiometricVerifyType {
  switch (code) {
    case 0:
    case 3:
      return 'PASSWORD';
    case 2:
    case 4:
      return 'CARD';
    case 15:
    case 16:
    case 17:
    case 18:
      return 'FACE';
    case 1:
    default:
      return 'FINGERPRINT';
  }
}

export function mapZkInOutMode(code: number): PunchInOutMode {
  switch (code) {
    case 1:
    case 5: // OT-Out
      return 'CHECK_OUT';
    case 2:
      return 'BREAK_OUT';
    case 3:
      return 'BREAK_IN';
    case 0:
    case 4: // OT-In
    default:
      return 'CHECK_IN';
  }
}

function readNullTerminatedAscii(buf: Buffer): string {
  const nullIdx = buf.indexOf(0);
  const slice = nullIdx === -1 ? buf : buf.subarray(0, nullIdx);
  return slice.toString('ascii').replace(/[^\x20-\x7e]/g, '').trim();
}

/**
 * Decodes raw CMD_ATTLOG_RRQ attendance payload into normalized device attendance records.
 * Supports 40-byte (ZLM60_TFT / eSSL X2008), 16-byte, and 8-byte ZK record formats.
 */
export function decodeAttendancePayload(rawPayload: Buffer): DeviceAttendanceRecord[] {
  if (!rawPayload || rawPayload.length === 0) return [];

  // Leading 4-byte total payload size header is standard in TCP CMD_ATTLOG_RRQ responses
  let recordBuffer = rawPayload;
  if (rawPayload.length >= 4) {
    const declaredSize = rawPayload.readUInt32LE(0);
    if (declaredSize === 0 && rawPayload.length === 4) {
      return [];
    }
    if (declaredSize > 0 && rawPayload.length - 4 >= declaredSize) {
      recordBuffer = rawPayload.subarray(4, 4 + declaredSize);
    } else if (rawPayload.length > 4 && (rawPayload.length - 4) % 40 === 0) {
      recordBuffer = rawPayload.subarray(4);
    }
  }

  if (recordBuffer.length === 0) return [];

  let recordSize = 40;
  if (recordBuffer.length % 40 === 0) {
    recordSize = 40;
  } else if (recordBuffer.length % 16 === 0) {
    recordSize = 16;
  } else if (recordBuffer.length % 8 === 0) {
    recordSize = 8;
  } else {
    throw new Error(
      `Unsupported ZK attendance payload size (${recordBuffer.length} bytes); expected multiple of 40 (ZLM60_TFT), 16, or 8.`
    );
  }

  const records: DeviceAttendanceRecord[] = [];
  const count = Math.floor(recordBuffer.length / recordSize);

  for (let i = 0; i < count; i++) {
    const offset = i * recordSize;
    const rec = recordBuffer.subarray(offset, offset + recordSize);

    if (recordSize === 40) {
      const uid = rec.readUInt16LE(0);
      const userId = readNullTerminatedAscii(rec.subarray(2, 26)) || String(uid);
      const verifyCode = rec.readUInt8(26);
      const packedTime = rec.readUInt32LE(27);
      const inOutCode = rec.readUInt8(31);
      const workCode = rec.readUInt32LE(32);

      records.push({
        uid,
        userEnrollmentId: userId,
        localDateTime: decodeZkTimestamp(packedTime),
        verifyCode,
        verifyType: mapZkVerifyType(verifyCode),
        inOutCode,
        inOutMode: mapZkInOutMode(inOutCode),
        workCode,
        recordSequence: i,
      });
    } else if (recordSize === 16) {
      const uid = rec.readUInt32LE(0);
      const verifyCode = rec.readUInt8(4);
      const packedTime = rec.readUInt32LE(5);
      const inOutCode = rec.readUInt8(9);

      records.push({
        uid,
        userEnrollmentId: String(uid),
        localDateTime: decodeZkTimestamp(packedTime),
        verifyCode,
        verifyType: mapZkVerifyType(verifyCode),
        inOutCode,
        inOutMode: mapZkInOutMode(inOutCode),
        workCode: 0,
        recordSequence: i,
      });
    } else {
      const uid = rec.readUInt16LE(0);
      const verifyCode = rec.readUInt8(2);
      const inOutCode = rec.readUInt8(3);
      const packedTime = rec.readUInt32LE(4);

      records.push({
        uid,
        userEnrollmentId: String(uid),
        localDateTime: decodeZkTimestamp(packedTime),
        verifyCode,
        verifyType: mapZkVerifyType(verifyCode),
        inOutCode,
        inOutMode: mapZkInOutMode(inOutCode),
        workCode: 0,
        recordSequence: i,
      });
    }
  }

  return records;
}

/**
 * Decodes raw CMD_USERTEMP_RRQ (type=5) enrolled user records.
 * Supports 72-byte (ZLM60_TFT / eSSL X2008) and 28-byte legacy ZK user records.
 */
export function decodeUserTablePayload(rawPayload: Buffer): DeviceEnrolledUser[] {
  if (!rawPayload || rawPayload.length === 0) return [];

  let recordBuffer = rawPayload;
  if (rawPayload.length >= 4) {
    const declaredSize = rawPayload.readUInt32LE(0);
    if (declaredSize === 0 && rawPayload.length === 4) {
      return [];
    }
    if (declaredSize > 0 && rawPayload.length - 4 >= declaredSize) {
      recordBuffer = rawPayload.subarray(4, 4 + declaredSize);
    } else if (rawPayload.length > 4 && (rawPayload.length - 4) % 72 === 0) {
      recordBuffer = rawPayload.subarray(4);
    } else if (rawPayload.length > 4 && (rawPayload.length - 4) % 28 === 0) {
      recordBuffer = rawPayload.subarray(4);
    }
  }

  if (recordBuffer.length === 0) return [];

  let recordSize = 0;
  if (recordBuffer.length % 72 === 0) {
    recordSize = 72;
  } else if (recordBuffer.length % 28 === 0) {
    recordSize = 28;
  } else {
    throw new Error(
      `Unsupported ZK user table payload size (${recordBuffer.length} bytes); expected multiple of 72 (ZLM60_TFT) or 28.`
    );
  }

  const users: DeviceEnrolledUser[] = [];
  const count = Math.floor(recordBuffer.length / recordSize);

  for (let i = 0; i < count; i++) {
    const offset = i * recordSize;
    const rec = recordBuffer.subarray(offset, offset + recordSize);
    if (recordSize === 72) {
      const uid = rec.readUInt16LE(0);
      const name = readNullTerminatedAscii(rec.subarray(11, 35)) || null;
      const cardNum = rec.readUInt32LE(35);
      const userId = readNullTerminatedAscii(rec.subarray(48, 72)) || String(uid);
      if (userId) {
        users.push({
          uid,
          enrollmentId: userId,
          name,
          cardNo: cardNum > 0 ? String(cardNum) : null,
        });
      }
    } else {
      const uid = rec.readUInt16LE(0);
      const name = readNullTerminatedAscii(rec.subarray(8, 16)) || null;
      const cardNum = rec.readUInt32LE(16);
      const numericUserId = rec.readUInt32LE(24);
      const enrollmentId = numericUserId > 0 ? String(numericUserId) : String(uid);
      if (enrollmentId) {
        users.push({
          uid,
          enrollmentId,
          name,
          cardNo: cardNum > 0 ? String(cardNum) : null,
        });
      }
    }
  }

  return users;
}

/**
 * Pure Node.js ZKTeco Standalone Pull TCP Protocol Adapter (Port 4370).
 * Compatible with eSSL X2008 (Platform ZLM60_TFT, Fingerprint Algorithm VX10.0).
 * Strictly read-only: NEVER sends CMD_CLEAR_ATTLOG.
 */
export class ZKTecoTcpAdapter implements IBiometricProtocolAdapter {
  readonly protocolName = 'zkteco-standalone-tcp-4370';

  private socket: net.Socket | null = null;
  private recvBuffer: Buffer = Buffer.alloc(0);
  private sessionId = 0;
  private replyId = 0;
  private timeoutMs = 5000;
  private frameQueue: ParsedZkFrame[] = [];
  private waitingResolvers: Array<{
    resolve: (frame: ParsedZkFrame) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
  }> = [];

  async connect(options: ProtocolConnectOptions): Promise<void> {
    await this.disconnect();

    this.timeoutMs = options.timeoutMs ?? 5000;
    this.sessionId = 0;
    this.replyId = 0;
    this.recvBuffer = Buffer.alloc(0);
    this.frameQueue = [];

    await new Promise<void>((resolve, reject) => {
      const sock = net.createConnection({ host: options.host, port: options.port });
      let settled = false;

      const onError = (err: Error) => {
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(new Error(`TCP connection failed to ${options.host}:${options.port}: ${err.message}`));
        } else {
          this.rejectWaiters(err);
        }
      };

      const onTimeout = () => {
        if (!settled) {
          settled = true;
          sock.destroy();
          reject(new Error(`TCP connection timed out connecting to ${options.host}:${options.port}`));
        }
      };

      sock.setTimeout(this.timeoutMs);
      sock.once('connect', () => {
        if (settled) return;
        settled = true;
        sock.setTimeout(0);
        this.socket = sock;
        sock.on('data', (chunk: Buffer) => this.handleIncomingChunk(chunk));
        sock.on('close', () => {
          this.rejectWaiters(new Error('Biometric device closed TCP connection unexpectedly.'));
        });
        resolve();
      });
      sock.once('timeout', onTimeout);
      sock.on('error', onError);
    });

    const connectReply = await this.sendCommand(ZK_CMD.CONNECT);
    this.sessionId = connectReply.sessionId;

    if (connectReply.command === ZK_CMD.ACK_UNAUTH) {
      const commKey = options.commKey ?? 0;
      const authPayload = encodeZkCommKey(commKey, this.sessionId);
      const authReply = await this.sendCommand(ZK_CMD.AUTH, authPayload);
      if (authReply.command !== ZK_CMD.ACK_OK) {
        throw new Error('Biometric device rejected CommKey authentication (CMD_AUTH failed).');
      }
    } else if (connectReply.command !== ZK_CMD.ACK_OK) {
      throw new Error(`Unexpected ZK CMD_CONNECT reply code: ${connectReply.command}`);
    }
  }

  async getDeviceInfo(): Promise<DeviceInfo> {
    const readOption = async (key: string): Promise<string | null> => {
      try {
        const res = await this.sendCommand(ZK_CMD.OPTIONS_RRQ, Buffer.from(`${key}\0`, 'ascii'));
        if (res.command !== ZK_CMD.ACK_OK) return null;
        const raw = readNullTerminatedAscii(res.payload);
        const eqIdx = raw.indexOf('=');
        return (eqIdx !== -1 ? raw.slice(eqIdx + 1) : raw).trim() || null;
      } catch {
        return null;
      }
    };

    const readVersion = async (): Promise<string | null> => {
      try {
        const res = await this.sendCommand(ZK_CMD.GET_VERSION);
        if (res.command !== ZK_CMD.ACK_OK) return null;
        return readNullTerminatedAscii(res.payload) || null;
      } catch {
        return null;
      }
    };

    const [serialNumber, platform, fingerprintAlgorithm, deviceName, oemVendor, firmwareVersion] =
      await Promise.all([
        readOption('~SerialNumber'),
        readOption('~Platform'),
        readOption('~ZKFPVersion'),
        readOption('~DeviceName'),
        readOption('~OEMVendor'),
        readVersion(),
      ]);

    return {
      serialNumber,
      platform,
      fingerprintAlgorithm,
      firmwareVersion,
      deviceName,
      oemVendor,
    };
  }

  async getAttendanceLogs(): Promise<DeviceAttendanceRecord[]> {
    this.ensureConnected();

    const firstReply = await this.sendCommand(ZK_CMD.ATTLOG_RRQ);

    if (firstReply.command === ZK_CMD.ACK_OK) {
      return firstReply.payload.length > 0 ? decodeAttendancePayload(firstReply.payload) : [];
    }

    if (firstReply.command === ZK_CMD.ACK_DATA) {
      return decodeAttendancePayload(firstReply.payload);
    }

    if (firstReply.command === ZK_CMD.PREPARE_DATA) {
      const expectedBytes = firstReply.payload.length >= 4 ? firstReply.payload.readUInt32LE(0) : 0;
      const chunks: Buffer[] = [];
      let receivedBytes = 0;

      while (receivedBytes < expectedBytes) {
        const frame = await this.waitForNextFrame(this.timeoutMs * 3);
        if (frame.command === ZK_CMD.DATA) {
          chunks.push(frame.payload);
          receivedBytes += frame.payload.length;
        } else if (frame.command === ZK_CMD.ACK_OK) {
          break;
        } else if (frame.command === ZK_CMD.ACK_ERROR) {
          throw new Error('Biometric device returned CMD_ACK_ERROR while streaming attendance logs.');
        }
      }

      // Some ZLM60_TFT firmware emits a trailing CMD_ACK_OK after all CMD_DATA frames
      if (this.frameQueue.length > 0 && this.frameQueue[0].command === ZK_CMD.ACK_OK) {
        this.frameQueue.shift();
      }

      try {
        await this.sendCommand(ZK_CMD.FREE_DATA);
      } catch {
        // Non-fatal cleanup
      }

      const fullPayload = Buffer.concat(chunks);
      return decodeAttendancePayload(fullPayload);
    }

    if (firstReply.command === ZK_CMD.ACK_ERROR) {
      throw new Error('Device returned CMD_ACK_ERROR on CMD_ATTLOG_RRQ.');
    }

    throw new Error(`Unexpected response command ${firstReply.command} for CMD_ATTLOG_RRQ.`);
  }

  async getUsers(): Promise<DeviceEnrolledUser[]> {
    this.ensureConnected();

    const firstReply = await this.sendCommand(ZK_CMD.USERTEMP_RRQ, Buffer.from([0x05]));
    if (firstReply.command === ZK_CMD.ACK_OK || firstReply.command === ZK_CMD.ACK_DATA) {
      return firstReply.payload.length > 0 ? decodeUserTablePayload(firstReply.payload) : [];
    }

    if (firstReply.command === ZK_CMD.PREPARE_DATA) {
      const expectedBytes = firstReply.payload.length >= 4 ? firstReply.payload.readUInt32LE(0) : 0;
      const chunks: Buffer[] = [];
      let receivedBytes = 0;

      while (receivedBytes < expectedBytes) {
        const frame = await this.waitForNextFrame(this.timeoutMs * 3);
        if (frame.command === ZK_CMD.DATA) {
          chunks.push(frame.payload);
          receivedBytes += frame.payload.length;
        } else if (frame.command === ZK_CMD.ACK_OK) {
          break;
        } else if (frame.command === ZK_CMD.ACK_ERROR) {
          throw new Error('Biometric device returned CMD_ACK_ERROR while streaming enrolled users.');
        } else {
          throw new Error(`Unexpected response command ${frame.command} while streaming enrolled users.`);
        }
      }

      if (this.frameQueue.length > 0 && this.frameQueue[0].command === ZK_CMD.ACK_OK) {
        this.frameQueue.shift();
      }

      try {
        await this.sendCommand(ZK_CMD.FREE_DATA);
      } catch {
        // Non-fatal cleanup
      }

      return decodeUserTablePayload(Buffer.concat(chunks));
    }

    if (firstReply.command === ZK_CMD.ACK_ERROR) {
      throw new Error('Device returned CMD_ACK_ERROR on CMD_USERTEMP_RRQ.');
    }

    throw new Error(`Unexpected response command ${firstReply.command} for CMD_USERTEMP_RRQ.`);
  }

  async disconnect(): Promise<void> {
    const sock = this.socket;
    this.socket = null;
    if (!sock) return;

    this.rejectWaiters(new Error('Disconnected.'));

    try {
      if (!sock.destroyed && sock.writable && this.sessionId !== 0) {
        this.replyId = (this.replyId + 1) & 0xffff;
        const exitFrame = buildZkTcpFrame(ZK_CMD.EXIT, this.sessionId, this.replyId);
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 150);
          sock.once('close', () => {
            clearTimeout(timer);
            resolve();
          });
          sock.end(exitFrame);
        });
      }
    } catch {
      // Ignore write failure during teardown
    } finally {
      sock.destroy();
    }
  }

  private ensureConnected(): void {
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Not connected to biometric terminal.');
    }
  }

  private async sendCommand(command: number, data: Buffer = Buffer.alloc(0)): Promise<ParsedZkFrame> {
    this.ensureConnected();
    this.replyId = command === ZK_CMD.CONNECT ? 0 : (this.replyId + 1) & 0xffff;
    const frame = buildZkTcpFrame(command, this.sessionId, this.replyId, data);

    await new Promise<void>((resolve, reject) => {
      this.socket!.write(frame, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });

    return this.waitForNextFrame(this.timeoutMs);
  }

  private handleIncomingChunk(chunk: Buffer): void {
    this.recvBuffer = Buffer.concat([this.recvBuffer, chunk]);
    const { frames, remaining } = extractZkTcpFrames(this.recvBuffer);
    this.recvBuffer = remaining;

    for (const frame of frames) {
      const waiter = this.waitingResolvers.shift();
      if (waiter) {
        clearTimeout(waiter.timer);
        waiter.resolve(frame);
      } else {
        this.frameQueue.push(frame);
      }
    }
  }

  private waitForNextFrame(timeoutMs: number): Promise<ParsedZkFrame> {
    const queued = this.frameQueue.shift();
    if (queued) {
      return Promise.resolve(queued);
    }

    return new Promise((resolve, reject) => {
      const entry: {
        resolve: (frame: ParsedZkFrame) => void;
        reject: (err: Error) => void;
        timer: NodeJS.Timeout;
      } = {
        resolve,
        reject,
        timer: setTimeout(() => {
          const idx = this.waitingResolvers.indexOf(entry);
          if (idx !== -1) this.waitingResolvers.splice(idx, 1);
          reject(new Error(`Timed out after ${timeoutMs}ms waiting for ZK TCP response.`));
        }, timeoutMs),
      };

      this.waitingResolvers.push(entry);
    });
  }

  private rejectWaiters(err: Error): void {
    while (this.waitingResolvers.length > 0) {
      const waiter = this.waitingResolvers.shift()!;
      clearTimeout(waiter.timer);
      waiter.reject(err);
    }
  }
}
