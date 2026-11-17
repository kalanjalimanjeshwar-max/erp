import net from 'net';
import {
  BiometricVerifyType,
  DeviceAttendanceRecord,
  DeviceEnrolledUser,
  DeviceInfo,
  IBiometricProtocolAdapter,
  ProtocolConnectOptions,
  ProtocolDiagnosticEvent,
  PunchInOutMode,
  UserSyncOutcome,
} from '../types.js';

// ZKTeco Standalone Pull TCP Protocol Constants (Port 4370 / ZLM60_TFT compatible)
export const ZK_TCP_START_TAG = 0x5050827d; // Little-endian header bytes: 7d 82 50 50 -> wait: uint32BE 0x5050827d = bytes [0x50, 0x50, 0x82, 0x7d]
export const ZK_CMD = {
  CONNECT: 1000,
  EXIT: 1001,
  ENABLE_DEVICE: 1002,
  DISABLE_DEVICE: 1003,
  AUTH: 1102,
  DB_RRQ: 7,
  USERTEMP_RRQ: 9,
  OPTIONS_RRQ: 11,
  ATTLOG_RRQ: 13,
  GET_FREE_SIZES: 50,
  GET_VERSION: 1100,
  PREPARE_DATA: 1500,
  DATA: 1501,
  FREE_DATA: 1502,
  PREPARE_BUFFER: 1503,
  READ_BUFFER: 1504,
  ACK_OK: 2000,
  ACK_ERROR: 2001,
  ACK_DATA: 2002,
  ACK_RETRY: 2003,
  ACK_REPEAT: 2004,
  ACK_UNAUTH: 2005,
  ACK_UNKNOWN: 0xffff,
} as const;

export const ZK_FCT = {
  ATTLOG: 1,
  FINGERTMP: 2,
  OPLOG: 4,
  USER: 5,
  SMS: 6,
  UDATA: 7,
  WORKCODE: 8,
} as const;

export const DEFAULT_ZK_MAX_CHUNK_BYTES = 0xffc0; // 65,472 bytes (ZKTeco TCP read_with_buffer max chunk)

export function zkCmdName(cmd: number): string {
  for (const [name, code] of Object.entries(ZK_CMD)) {
    if (code === cmd) return `CMD_${name}`;
  }
  return `CMD_${cmd}`;
}

export class ZkProtocolError extends Error {
  readonly code: UserSyncOutcome;
  readonly commandId?: number;
  readonly replyCommand?: number;

  constructor(
    code: UserSyncOutcome,
    message: string,
    options?: { commandId?: number; replyCommand?: number }
  ) {
    super(message);
    this.name = 'ZkProtocolError';
    this.code = code;
    this.commandId = options?.commandId;
    this.replyCommand = options?.replyCommand;
  }
}

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

function readNullTerminatedUtf8(buf: Buffer): string {
  const nullIdx = buf.indexOf(0);
  const slice = nullIdx === -1 ? buf : buf.subarray(0, nullIdx);
  return slice.toString('utf8').replace(/[\x00-\x1f\x7f\ufffd]+/g, '').trim();
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

export interface DecodedUserTableResult {
  users: DeviceEnrolledUser[];
  recordSize: 72 | 28 | null;
  declaredSize: number | null;
  hasLengthPrefix: boolean;
}

/**
 * Decodes raw user table bytes with full structural metadata (record size, header presence).
 * Supports 72-byte (ZLM60_TFT / eSSL X2008) and 28-byte legacy ZK user records,
 * both with and without the 4-byte little-endian total-size header.
 */
export function decodeUserTablePayloadDetailed(rawPayload: Buffer): DecodedUserTableResult {
  if (!rawPayload || rawPayload.length === 0) {
    return { users: [], recordSize: null, declaredSize: 0, hasLengthPrefix: false };
  }

  if (rawPayload.length === 4) {
    const declaredSize = rawPayload.readUInt32LE(0);
    if (declaredSize === 0) {
      return { users: [], recordSize: null, declaredSize: 0, hasLengthPrefix: true };
    }
    throw new ZkProtocolError(
      'MALFORMED_RESPONSE',
      `Malformed ZK user table payload: 4-byte header declares ${declaredSize} bytes but 0 record bytes followed.`
    );
  }

  let recordBuffer = rawPayload;
  let declaredSize: number | null = null;
  let hasLengthPrefix = false;

  if (rawPayload.length > 4) {
    const candidateDeclared = rawPayload.readUInt32LE(0);
    const remaining = rawPayload.length - 4;
    const rawIsAligned = rawPayload.length % 72 === 0 || rawPayload.length % 28 === 0;
    const remIs72 = remaining % 72 === 0;
    const remIs28 = remaining % 28 === 0;

    if (
      candidateDeclared === remaining &&
      (remIs72 || (remIs28 && rawPayload.length % 72 !== 0))
    ) {
      hasLengthPrefix = true;
      declaredSize = candidateDeclared;
      recordBuffer = rawPayload.subarray(4);
    } else if (
      !rawIsAligned &&
      candidateDeclared > 0 &&
      remaining >= candidateDeclared &&
      (candidateDeclared % 72 === 0 || candidateDeclared % 28 === 0)
    ) {
      hasLengthPrefix = true;
      declaredSize = candidateDeclared;
      recordBuffer = rawPayload.subarray(4, 4 + candidateDeclared);
    } else if (!rawIsAligned && (remIs72 || remIs28)) {
      hasLengthPrefix = true;
      declaredSize = candidateDeclared;
      recordBuffer = rawPayload.subarray(4);
    }
  }

  if (recordBuffer.length === 0) {
    return { users: [], recordSize: null, declaredSize, hasLengthPrefix };
  }

  let recordSize: 72 | 28;
  if (recordBuffer.length % 72 === 0) {
    recordSize = 72;
  } else if (recordBuffer.length % 28 === 0) {
    recordSize = 28;
  } else {
    throw new ZkProtocolError(
      'MALFORMED_RESPONSE',
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
      const name = readNullTerminatedUtf8(rec.subarray(11, 35)) || null;
      const cardNum = rec.readUInt32LE(35);
      const rawUserId = readNullTerminatedUtf8(rec.subarray(48, 72));
      const userId = rawUserId || (uid > 0 ? String(uid) : '');
      if (userId) {
        users.push({
          uid,
          enrollmentId: userId,
          name,
          cardNo: cardNum > 0 && cardNum < 0xffffffff ? String(cardNum) : null,
        });
      }
    } else {
      const uid = rec.readUInt16LE(0);
      const name = readNullTerminatedUtf8(rec.subarray(8, 16)) || null;
      const cardNum = rec.readUInt32LE(16);
      const numericUserId = rec.readUInt32LE(24);
      const enrollmentId = numericUserId > 0 ? String(numericUserId) : uid > 0 ? String(uid) : '';
      if (enrollmentId) {
        users.push({
          uid,
          enrollmentId,
          name,
          cardNo: cardNum > 0 && cardNum < 0xffffffff ? String(cardNum) : null,
        });
      }
    }
  }

  return { users, recordSize, declaredSize, hasLengthPrefix };
}

/**
 * Decodes raw CMD_USERTEMP_RRQ / CMD_PREPARE_BUFFER (type=5) enrolled user records.
 * Supports 72-byte (ZLM60_TFT / eSSL X2008) and 28-byte legacy ZK user records.
 */
export function decodeUserTablePayload(rawPayload: Buffer): DeviceEnrolledUser[] {
  return decodeUserTablePayloadDetailed(rawPayload).users;
}

export interface ZKTecoTcpAdapterOptions {
  onDiagnostic?: (event: ProtocolDiagnosticEvent) => void;
  maxChunkBytes?: number;
}

export interface DeviceFreeSizes {
  enrolledUserCount: number | null;
  enrolledFingerCount: number | null;
  attendanceRecordCount: number | null;
}

/**
 * Pure Node.js ZKTeco Standalone Pull TCP Protocol Adapter (Port 4370).
 * Compatible with eSSL X2008 (Platform ZLM60_TFT, Firmware Ver 6.60, Fingerprint Algorithm VX10.0).
 * Strictly read-only: NEVER sends CMD_CLEAR_ATTLOG.
 */
export class ZKTecoTcpAdapter implements IBiometricProtocolAdapter {
  readonly protocolName = 'zkteco-standalone-tcp-4370';

  private readonly onDiagnostic?: (event: ProtocolDiagnosticEvent) => void;
  private readonly maxChunkBytes: number;
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

  constructor(options?: ZKTecoTcpAdapterOptions) {
    this.onDiagnostic = options?.onDiagnostic;
    this.maxChunkBytes = Math.max(256, options?.maxChunkBytes ?? DEFAULT_ZK_MAX_CHUNK_BYTES);
  }

  private emitDiagnostic(event: ProtocolDiagnosticEvent): void {
    if (!this.onDiagnostic) return;
    try {
      this.onDiagnostic(event);
    } catch {
      // Never allow diagnostic callbacks to break protocol operations
    }
  }

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
      const fullPayload = await this.receiveStreamedData(firstReply.payload, 'attendance logs');
      return decodeAttendancePayload(fullPayload);
    }

    if (firstReply.command === ZK_CMD.ACK_ERROR) {
      throw new ZkProtocolError('UNSUPPORTED_COMMAND', 'Device returned CMD_ACK_ERROR on CMD_ATTLOG_RRQ.', {
        commandId: ZK_CMD.ATTLOG_RRQ,
        replyCommand: firstReply.command,
      });
    }

    throw new ZkProtocolError(
      'MALFORMED_RESPONSE',
      `Unexpected response command ${firstReply.command} for CMD_ATTLOG_RRQ.`,
      { commandId: ZK_CMD.ATTLOG_RRQ, replyCommand: firstReply.command }
    );
  }

  /**
   * Queries CMD_GET_FREE_SIZES (50) for device-reported user, fingerprint, and log counts.
   * Returns null counts when firmware does not support CMD_GET_FREE_SIZES.
   */
  async getFreeSizes(): Promise<DeviceFreeSizes> {
    this.ensureConnected();
    try {
      const reply = await this.sendCommand(ZK_CMD.GET_FREE_SIZES);
      const isOk = reply.command === ZK_CMD.ACK_OK || reply.command === ZK_CMD.ACK_DATA;
      if (!isOk || reply.payload.length < 20) {
        this.emitDiagnostic({
          operation: 'get_free_sizes',
          commandId: ZK_CMD.GET_FREE_SIZES,
          commandName: zkCmdName(ZK_CMD.GET_FREE_SIZES),
          replyCommand: reply.command,
          replyCommandName: zkCmdName(reply.command),
          payloadBytes: reply.payload.length,
          reportedUserCount: null,
          message: isOk
            ? `CMD_GET_FREE_SIZES returned short payload (${reply.payload.length} bytes)`
            : `CMD_GET_FREE_SIZES returned ${zkCmdName(reply.command)}`,
        });
        return { enrolledUserCount: null, enrolledFingerCount: null, attendanceRecordCount: null };
      }

      const rawUsers = reply.payload.readInt32LE(16);
      const rawFingers = reply.payload.length >= 28 ? reply.payload.readInt32LE(24) : -1;
      const rawRecords = reply.payload.length >= 36 ? reply.payload.readInt32LE(32) : -1;
      const enrolledUserCount = rawUsers >= 0 ? rawUsers : null;
      const enrolledFingerCount = rawFingers >= 0 ? rawFingers : null;
      const attendanceRecordCount = rawRecords >= 0 ? rawRecords : null;

      this.emitDiagnostic({
        operation: 'get_free_sizes',
        commandId: ZK_CMD.GET_FREE_SIZES,
        commandName: zkCmdName(ZK_CMD.GET_FREE_SIZES),
        replyCommand: reply.command,
        replyCommandName: zkCmdName(reply.command),
        payloadBytes: reply.payload.length,
        reportedUserCount: enrolledUserCount,
      });

      return { enrolledUserCount, enrolledFingerCount, attendanceRecordCount };
    } catch (err: unknown) {
      this.emitDiagnostic({
        operation: 'get_free_sizes',
        commandId: ZK_CMD.GET_FREE_SIZES,
        commandName: zkCmdName(ZK_CMD.GET_FREE_SIZES),
        reportedUserCount: null,
        message: (err as Error)?.message || 'CMD_GET_FREE_SIZES failed',
      });
      return { enrolledUserCount: null, enrolledFingerCount: null, attendanceRecordCount: null };
    }
  }

  /**
   * Executes ZKTeco Ver 6.60 / ZLM60_TFT buffered read protocol:
   * CMD_PREPARE_BUFFER (1503) + paginated CMD_READ_BUFFER (1504) chunks + CMD_FREE_DATA (1502).
   * Also supports inline ACK_DATA (2002) and streamed PREPARE_DATA (1500) -> DATA (1501) responses.
   */
  async readWithBuffer(command: number, fct: number, ext = 0): Promise<Buffer> {
    this.ensureConnected();

    const req = Buffer.alloc(11, 0);
    req.writeInt8(1, 0);
    req.writeInt16LE(command & 0xffff, 1);
    req.writeInt32LE(fct, 3);
    req.writeInt32LE(ext, 7);

    const prepReply = await this.sendCommand(ZK_CMD.PREPARE_BUFFER, req);
    this.emitDiagnostic({
      operation: 'read_with_buffer',
      commandId: ZK_CMD.PREPARE_BUFFER,
      commandName: zkCmdName(ZK_CMD.PREPARE_BUFFER),
      replyCommand: prepReply.command,
      replyCommandName: zkCmdName(prepReply.command),
      payloadBytes: prepReply.payload.length,
    });

    if (
      prepReply.command === ZK_CMD.ACK_ERROR ||
      prepReply.command === ZK_CMD.ACK_UNKNOWN ||
      prepReply.command === ZK_CMD.ACK_UNAUTH
    ) {
      throw new ZkProtocolError(
        'UNSUPPORTED_COMMAND',
        `Device rejected CMD_PREPARE_BUFFER (${zkCmdName(prepReply.command)}) for command ${command} fct=${fct}.`,
        { commandId: ZK_CMD.PREPARE_BUFFER, replyCommand: prepReply.command }
      );
    }

    if (prepReply.command === ZK_CMD.PREPARE_DATA) {
      return this.receiveStreamedData(prepReply.payload, `buffered command ${command}`);
    }

    if (prepReply.command === ZK_CMD.ACK_DATA) {
      return prepReply.payload;
    }

    if (prepReply.command !== ZK_CMD.ACK_OK) {
      throw new ZkProtocolError(
        'MALFORMED_RESPONSE',
        `Unexpected response command ${prepReply.command} for CMD_PREPARE_BUFFER.`,
        { commandId: ZK_CMD.PREPARE_BUFFER, replyCommand: prepReply.command }
      );
    }

    // Standard ZKTeco Ver 6.60 ACK_OK payload: [statusFlag(1), totalSize(uint32LE at 1..4), ...]
    // Some firmwares return 4-byte [totalSize] directly or 0 bytes when empty.
    let totalSize = 0;
    if (prepReply.payload.length >= 5) {
      totalSize = prepReply.payload.readUInt32LE(1);
    } else if (prepReply.payload.length === 4) {
      totalSize = prepReply.payload.readUInt32LE(0);
    } else if (prepReply.payload.length === 0) {
      return Buffer.alloc(0);
    } else {
      throw new ZkProtocolError(
        'MALFORMED_RESPONSE',
        `Unexpected CMD_PREPARE_BUFFER ACK_OK payload length (${prepReply.payload.length} bytes).`,
        { commandId: ZK_CMD.PREPARE_BUFFER, replyCommand: prepReply.command }
      );
    }

    if (totalSize === 0) {
      return Buffer.alloc(0);
    }

    const chunks: Buffer[] = [];
    let offset = 0;

    try {
      while (offset < totalSize) {
        const remain = totalSize - offset;
        const requestSize = Math.min(remain, this.maxChunkBytes);
        const chunkReq = Buffer.alloc(8, 0);
        chunkReq.writeInt32LE(offset, 0);
        chunkReq.writeInt32LE(requestSize, 4);

        const chunkReply = await this.sendCommand(ZK_CMD.READ_BUFFER, chunkReq);
        let chunkBytes: Buffer;

        if (chunkReply.command === ZK_CMD.PREPARE_DATA) {
          chunkBytes = await this.receiveStreamedData(
            chunkReply.payload.length >= 4 ? chunkReply.payload : Buffer.alloc(0),
            `buffer chunk offset=${offset}`,
            requestSize,
            false
          );
        } else if (chunkReply.command === ZK_CMD.ACK_DATA || chunkReply.command === ZK_CMD.ACK_OK) {
          chunkBytes = chunkReply.payload;
        } else if (chunkReply.command === ZK_CMD.ACK_ERROR) {
          throw new ZkProtocolError(
            'COMMUNICATION_FAILURE',
            `Biometric device returned CMD_ACK_ERROR on CMD_READ_BUFFER at offset ${offset}/${totalSize}.`,
            { commandId: ZK_CMD.READ_BUFFER, replyCommand: chunkReply.command }
          );
        } else {
          throw new ZkProtocolError(
            'MALFORMED_RESPONSE',
            `Unexpected response command ${chunkReply.command} on CMD_READ_BUFFER at offset ${offset}/${totalSize}.`,
            { commandId: ZK_CMD.READ_BUFFER, replyCommand: chunkReply.command }
          );
        }

        this.emitDiagnostic({
          operation: 'read_chunk',
          commandId: ZK_CMD.READ_BUFFER,
          commandName: zkCmdName(ZK_CMD.READ_BUFFER),
          replyCommand: chunkReply.command,
          replyCommandName: zkCmdName(chunkReply.command),
          chunkOffset: offset,
          chunkLength: requestSize,
          payloadBytes: chunkBytes.length,
          expectedBytes: totalSize,
        });

        if (chunkBytes.length === 0) {
          throw new ZkProtocolError(
            'COMMUNICATION_FAILURE',
            `CMD_READ_BUFFER stalled with 0 bytes at offset ${offset}/${totalSize}.`,
            { commandId: ZK_CMD.READ_BUFFER, replyCommand: chunkReply.command }
          );
        }

        const usable = chunkBytes.length > remain ? chunkBytes.subarray(0, remain) : chunkBytes;
        chunks.push(usable);
        offset += usable.length;
      }
    } finally {
      try {
        await this.sendCommand(ZK_CMD.FREE_DATA);
      } catch {
        // Non-fatal buffer cleanup
      }
    }

    return Buffer.concat(chunks);
  }

  private async readUsersDirectCommand(command: number, payload: Buffer): Promise<Buffer> {
    const firstReply = await this.sendCommand(command, payload);
    this.emitDiagnostic({
      operation: 'get_users',
      commandId: command,
      commandName: zkCmdName(command),
      replyCommand: firstReply.command,
      replyCommandName: zkCmdName(firstReply.command),
      payloadBytes: firstReply.payload.length,
    });

    if (firstReply.command === ZK_CMD.ACK_OK || firstReply.command === ZK_CMD.ACK_DATA) {
      return firstReply.payload;
    }

    if (firstReply.command === ZK_CMD.PREPARE_DATA) {
      return this.receiveStreamedData(firstReply.payload, 'enrolled users');
    }

    if (firstReply.command === ZK_CMD.ACK_ERROR || firstReply.command === ZK_CMD.ACK_UNKNOWN) {
      throw new ZkProtocolError(
        'UNSUPPORTED_COMMAND',
        `Device returned ${zkCmdName(firstReply.command)} on ${zkCmdName(command)}.`,
        { commandId: command, replyCommand: firstReply.command }
      );
    }

    throw new ZkProtocolError(
      'MALFORMED_RESPONSE',
      `Unexpected response command ${firstReply.command} for ${zkCmdName(command)}.`,
      { commandId: command, replyCommand: firstReply.command }
    );
  }

  async getUsers(): Promise<DeviceEnrolledUser[]> {
    this.ensureConnected();

    const freeSizes = await this.getFreeSizes();
    const reportedUserCount = freeSizes.enrolledUserCount;

    let rawUserPayload: Buffer | null = null;
    let lastProtocolError: Error | null = null;
    let sawUnsupportedPrepareBuffer = false;

    // 1. Primary path for ZLM60_TFT / Ver 6.60: buffered read via CMD_PREPARE_BUFFER (1503) + CMD_READ_BUFFER (1504)
    try {
      rawUserPayload = await this.readWithBuffer(ZK_CMD.USERTEMP_RRQ, ZK_FCT.USER, 0);
    } catch (err: unknown) {
      if (err instanceof ZkProtocolError && err.code === 'UNSUPPORTED_COMMAND') {
        sawUnsupportedPrepareBuffer = true;
        lastProtocolError = err;
      } else {
        this.emitDiagnostic({
          operation: 'get_users',
          commandId: ZK_CMD.PREPARE_BUFFER,
          commandName: zkCmdName(ZK_CMD.PREPARE_BUFFER),
          reportedUserCount,
          outcome: err instanceof ZkProtocolError ? err.code : 'COMMUNICATION_FAILURE',
          message: (err as Error)?.message,
        });
        throw err;
      }
    }

    // 2. Legacy fallback for older firmware / simple mock servers that only support direct CMD_USERTEMP_RRQ (9)
    if (sawUnsupportedPrepareBuffer) {
      try {
        rawUserPayload = await this.readUsersDirectCommand(ZK_CMD.USERTEMP_RRQ, Buffer.from([ZK_FCT.USER]));
        lastProtocolError = null;
      } catch (err: unknown) {
        this.emitDiagnostic({
          operation: 'get_users',
          commandId: ZK_CMD.USERTEMP_RRQ,
          commandName: zkCmdName(ZK_CMD.USERTEMP_RRQ),
          reportedUserCount,
          outcome: err instanceof ZkProtocolError ? err.code : 'COMMUNICATION_FAILURE',
          message: (err as Error)?.message,
        });
        throw err;
      }
    }

    // 3. Cross-check: if primary 1503 returned empty bytes while CMD_GET_FREE_SIZES says users > 0,
    // probe CMD_DB_RRQ (7) buffered read and direct CMD_USERTEMP_RRQ before declaring a protocol mismatch.
    if (
      rawUserPayload !== null &&
      decodeUserTablePayloadDetailed(rawUserPayload).users.length === 0 &&
      reportedUserCount !== null &&
      reportedUserCount > 0
    ) {
      this.emitDiagnostic({
        operation: 'get_users',
        commandId: ZK_CMD.PREPARE_BUFFER,
        commandName: zkCmdName(ZK_CMD.PREPARE_BUFFER),
        payloadBytes: rawUserPayload.length,
        reportedUserCount,
        message: `Primary buffered USERTEMP_RRQ returned 0 users despite device reporting ${reportedUserCount} enrolled users; trying fallback reads.`,
      });

      const fallbackCandidates: Array<() => Promise<Buffer>> = [
        () => this.readWithBuffer(ZK_CMD.DB_RRQ, ZK_FCT.USER, 0),
        () => this.readUsersDirectCommand(ZK_CMD.USERTEMP_RRQ, Buffer.from([ZK_FCT.USER])),
      ];

      for (const tryFallback of fallbackCandidates) {
        try {
          const candidateBuf = await tryFallback();
          const candidateDecoded = decodeUserTablePayloadDetailed(candidateBuf);
          if (candidateDecoded.users.length > 0) {
            rawUserPayload = candidateBuf;
            break;
          }
        } catch (err: unknown) {
          lastProtocolError = err as Error;
        }
      }
    }

    if (rawUserPayload === null) {
      throw lastProtocolError || new ZkProtocolError('COMMUNICATION_FAILURE', 'Unable to retrieve user table from device.');
    }

    const decoded = decodeUserTablePayloadDetailed(rawUserPayload);

    if (decoded.users.length === 0 && reportedUserCount !== null && reportedUserCount > 0) {
      const msg = `Device reports ${reportedUserCount} enrolled user(s) via CMD_GET_FREE_SIZES, but user table read returned 0 decoded records (${rawUserPayload.length} payload bytes).`;
      this.emitDiagnostic({
        operation: 'decode_users',
        payloadBytes: rawUserPayload.length,
        reportedUserCount,
        recordSize: decoded.recordSize,
        recordCount: 0,
        outcome: 'MALFORMED_RESPONSE',
        message: msg,
      });
      throw new ZkProtocolError('MALFORMED_RESPONSE', msg);
    }

    if (decoded.users.length === 0) {
      this.emitDiagnostic({
        operation: 'decode_users',
        payloadBytes: rawUserPayload.length,
        reportedUserCount,
        recordSize: decoded.recordSize,
        recordCount: 0,
        outcome: 'EMPTY_DEVICE_USERS',
        message:
          reportedUserCount === 0
            ? 'Device confirmed 0 enrolled users.'
            : 'Device returned valid empty user table.',
      });
      return [];
    }

    this.emitDiagnostic({
      operation: 'decode_users',
      payloadBytes: rawUserPayload.length,
      reportedUserCount,
      recordSize: decoded.recordSize,
      recordCount: decoded.users.length,
      outcome: 'SUCCESS',
      message: `Decoded ${decoded.users.length} enrolled user(s) using ${decoded.recordSize}-byte layout.`,
    });

    return decoded.users;
  }

  private async receiveStreamedData(
    prepPayload: Buffer,
    label: string,
    fallbackExpectedBytes = 0,
    freeBufferAfterStream = true
  ): Promise<Buffer> {
    const expectedBytes = prepPayload.length >= 4 ? prepPayload.readUInt32LE(0) : fallbackExpectedBytes;
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
        throw new ZkProtocolError(
          'COMMUNICATION_FAILURE',
          `Biometric device returned CMD_ACK_ERROR while streaming ${label}.`,
          { replyCommand: frame.command }
        );
      } else {
        throw new ZkProtocolError(
          'MALFORMED_RESPONSE',
          `Unexpected response command ${frame.command} while streaming ${label}.`,
          { replyCommand: frame.command }
        );
      }
    }

    // Some ZLM60_TFT firmware emits a trailing CMD_ACK_OK after all CMD_DATA frames
    if (this.frameQueue.length > 0 && this.frameQueue[0].command === ZK_CMD.ACK_OK) {
      this.frameQueue.shift();
    }

    if (freeBufferAfterStream) {
      try {
        await this.sendCommand(ZK_CMD.FREE_DATA);
      } catch {
        // Non-fatal cleanup
      }
    }

    return Buffer.concat(chunks);
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
      throw new ZkProtocolError('COMMUNICATION_FAILURE', 'Not connected to biometric terminal.');
    }
  }

  private async sendCommand(command: number, data: Buffer = Buffer.alloc(0)): Promise<ParsedZkFrame> {
    this.ensureConnected();
    // Discard any orphaned trailing frames (e.g. delayed ACK_OK from a previous stream) before issuing a new command
    this.frameQueue.length = 0;

    this.replyId = command === ZK_CMD.CONNECT ? 0 : (this.replyId + 1) & 0xffff;
    const expectedReplyId = this.replyId;
    const frame = buildZkTcpFrame(command, this.sessionId, expectedReplyId, data);

    await new Promise<void>((resolve, reject) => {
      this.socket!.write(frame, (err) => {
        if (err) reject(new ZkProtocolError('COMMUNICATION_FAILURE', err.message, { commandId: command }));
        else resolve();
      });
    });

    const deadlineAt = Date.now() + this.timeoutMs;
    while (true) {
      const remainingMs = Math.max(50, deadlineAt - Date.now());
      const reply = await this.waitForNextFrame(remainingMs);
      // Match replyId when non-zero to prevent stale trailing ACK_OK frames from previous transfers from colliding
      if (expectedReplyId > 0 && reply.replyId !== 0 && reply.replyId !== expectedReplyId) {
        continue;
      }
      return reply;
    }
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
          reject(
            new ZkProtocolError(
              'COMMUNICATION_FAILURE',
              `Timed out after ${timeoutMs}ms waiting for ZK TCP response.`
            )
          );
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
