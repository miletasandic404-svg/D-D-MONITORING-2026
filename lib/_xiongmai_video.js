'use strict';
/**
 * Xiongmai DVRIP Video Protocol Implementation
 *
 * Implements OPMonitor video streaming protocol for Xiongmai cameras.
 * Based on DVRIP V5.00 protocol with 20-byte header + JSON/binary payload.
 *
 * Protocol Sequence:
 * 1. Login (msg 1000/1001) - handled by _xiongmai_dvrip.js
 * 2. Keepalive (msg 1006/1007) - handled by _xiongmai_dvrip.js
 * 3. OPMonitor Claim (msg 1413/1414) - NEW
 * 4. OPMonitor Start (msg 1410/1411) - NEW
 * 5. Video Data (msg 1412) - NEW (continuous stream)
 *
 * Video Payload:
 * - Binary H.264/H.265 frames
 * - Markers: 0x1fc (I-frame), 0x1fd (P-frame)
 * - Channel/profile parameters control stream type
 */

const net = require('net');

// OPMonitor Message IDs (V5.00 protocol - decimal values)
const MSG_MONITOR_CLAIM = 1413;
const MSG_MONITOR_CLAIM_RESPONSE = 1414;
const MSG_MONITOR_START = 1410;
const MSG_MONITOR_START_RESPONSE = 1411;
const MSG_MONITOR_DATA = 1412;

// Video payload markers
const VIDEO_MARKER_I_FRAME = 0x000001fc;
const VIDEO_MARKER_P_FRAME = 0x000001fd;

// ---- Media stream (1412) frame signatures and headers ---------------------

const SIG = {
  I: 0x000001fc, // I-frame (H.264/H.265) — 16-byte frame header
  P: 0x000001fd, // P-frame — 8-byte frame header
  AUDIO: 0x000001fa, // audio (G.711 A-law) — 8-byte frame header
  INFO: 0x000001f9, // info — 8-byte frame header
  I_ALT: 0x000001fe, // alternate I (media==0 → jpeg)
  JPEG_A: 0xffd8ffe0, // JPEG snapshot (whole packet)
  JPEG_B: 0xffd8ffdb, // JPEG snapshot (whole packet)
};

const CODEC_NAMES = { 1: 'mpeg4', 2: 'h264', 3: 'h265' };

/**
 * Reassembles 1412 media payload chunks into complete frames.
 * A single DVRIP packet carries a frame header (with the total remaining
 * payload length) plus a chunk of that frame; a frame can span several
 * packets, and a packet can end one frame and start the next.
 * Continuation payloads carry raw frame bytes (no frame header) and are
 * appended to the pending frame until the declared length is reached.
 *
 * push(chunk) -> Frame[]  (Frame: { kind, data, ...metadata })
 */
class MediaReassembler {
  constructor(onFrame, { maxFrameBytes = 16 * 1024 * 1024 } = {}) {
    this.onFrame = onFrame || (() => {});
    this.maxFrameBytes = maxFrameBytes;
    this._buf = Buffer.alloc(0);
    this._pending = null; // { kind, codec?, width?, height?, fps?, frameType?, remain, parts }
  }

  push(chunk) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    const emitted = [];
    while (this._buf.length > 0) {
      if (this._pending === null) {
        const ok = this._startFrame();
        if (!ok) break; // need more bytes for the frame header
      }
      if (this._pending === null) continue; // header consumed the buffer (e.g. jpeg/unknown)
      const take = Math.min(this._pending.remain, this._buf.length);
      this._pending.parts.push(this._buf.subarray(0, take));
      this._pending.remain -= take;
      this._buf = this._buf.subarray(take);
      if (this._pending.remain === 0) {
        const frame = { kind: this._pending.kind, data: Buffer.concat(this._pending.parts) };
        for (const k of ['codec', 'width', 'height', 'fps', 'frameType', 'sampleRate']) {
          if (this._pending[k] !== undefined) frame[k] = this._pending[k];
        }
        this._pending = null;
        emitted.push(frame);
        this.onFrame(frame);
      } else if (this._pending.remain > this.maxFrameBytes) {
        const frame = { kind: 'oversized', data: Buffer.alloc(0), declared: this._pending.declared };
        this._pending = null;
        emitted.push(frame);
        this.onFrame(frame);
      }
    }
    return emitted;
  }

  _startFrame() {
    const buf = this._buf;
    if (buf.length < 4) return false;
    const sig = buf.readUInt32BE(0);

    // JPEG snapshots come as a whole packet — no length field.
    if (sig === SIG.JPEG_A || sig === SIG.JPEG_B) {
      const frame = { kind: 'jpeg', data: buf };
      this._buf = Buffer.alloc(0);
      this.onFrame(frame);
      return true;
    }

    if (sig === SIG.I || sig === SIG.I_ALT) {
      if (buf.length < 16) return false;
      const media = buf[4];
      const length = buf.readUInt32LE(12); // LE on wire (hardware-confirmed)
      if (sig === SIG.I_ALT && media === 0) {
        // python-dvr treats 0x1FE/media==0 as a JPEG-ish I-frame
        this._pending = { kind: 'jpeg', declared: length, remain: length, parts: [] };
      } else {
        this._pending = {
          kind: 'video',
          codec: CODEC_NAMES[media] || 'codec-' + media,
          width: buf[6] * 8,
          height: buf[7] * 8,
          fps: buf[5],
          frameType: 'I',
          declared: length,
          remain: length,
          parts: [],
        };
      }
      this._buf = buf.subarray(16);
      return true;
    }

    if (sig === SIG.P) {
      if (buf.length < 8) return false;
      const length = buf.readUInt32LE(4); // LE on wire
      this._pending = { kind: 'video', frameType: 'P', declared: length, remain: length, parts: [] };
      this._buf = buf.subarray(8);
      return true;
    }

    if (sig === SIG.AUDIO) {
      if (buf.length < 8) return false;
      const media = buf[4];
      const length = buf.readUInt16LE(6); // LE on wire (python-dvr "BBH" native)
      this._pending = {
        kind: 'audio',
        codec: media === 0x0e ? 'g711a' : 'g711-' + media.toString(16),
        sampleRate: buf[5],
        declared: length,
        remain: length,
        parts: [],
      };
      this._buf = buf.subarray(8);
      return true;
    }

    if (sig === SIG.INFO) {
      if (buf.length < 8) return false;
      const length = buf.readUInt16LE(6); // LE on wire
      this._pending = { kind: 'info', declared: length, remain: length, parts: [] };
      this._buf = buf.subarray(8);
      return true;
    }

    // Unknown signature at a frame boundary → protocol drift guard.
    const frame = { kind: 'unknown', sig: '0x' + sig.toString(16).padStart(8, '0'), data: buf };
    this._buf = Buffer.alloc(0);
    this.onFrame(frame);
    return true;
  }
}

/**
 * Build OPMonitor claim message (msg 1413) - V5.00 JSON protocol.
 *
 * @param {number} sessionId - Session ID from login
 * @param {object} options - Stream options { channel, streamType, transMode }
 * @returns {Buffer} OPMonitor claim message
 */
function buildMonitorClaimMessage(sessionId, { channel = 0, streamType = 'Main', transMode = 'TCP' } = {}) {
  const jsonObj = {
    Name: 'OPMonitor',
    SessionID: `0x${sessionId.toString(16).padStart(8, '0')}`,
    OPMonitor: {
      Action: 'Claim',
      Parameter: {
        Channel: channel,
        CombinMode: 'NONE',
        StreamType: streamType,
        TransMode: transMode,
      },
    },
  };
  return buildFrame(MSG_MONITOR_CLAIM, jsonObj, sessionId, 0);
}

/**
 * Build OPMonitor start message (msg 1410) - V5.00 JSON protocol.
 *
 * @param {number} sessionId - Session ID from login
 * @param {object} options - Stream options { channel, streamType, transMode }
 * @returns {Buffer} OPMonitor start message
 */
function buildMonitorStartMessage(sessionId, { channel = 0, streamType = 'Main', transMode = 'TCP' } = {}) {
  const jsonObj = {
    Name: 'OPMonitor',
    SessionID: `0x${sessionId.toString(16).padStart(8, '0')}`,
    OPMonitor: {
      Action: 'Start',
      Parameter: {
        Channel: channel,
        CombinMode: 'NONE',
        StreamType: streamType,
        TransMode: transMode,
      },
    },
  };
  return buildFrame(MSG_MONITOR_START, jsonObj, sessionId, 0);
}

/**
 * Build DVRIP V5.00 frame (20-byte header + JSON + \n\0 terminator).
 * Reused from _xiongmai_dvrip.js for consistency.
 *
 * @param {number} msgId - Message ID (decimal)
 * @param {object} jsonObj - JSON payload object
 * @param {number} session - Session ID for header
 * @param {number} sequence - Sequence number for header
 * @returns {Buffer} Complete V5.00 message
 */
function buildFrame(msgId, jsonObj, session = 0, sequence = 0) {
  const body = Buffer.from(JSON.stringify(jsonObj), 'utf8');
  const h = Buffer.alloc(20);
  h[0] = 0xFF;
  h[1] = 0x00; // V5.00 request type
  h.writeUInt32LE(session >>> 0, 4); // session ID in header
  h.writeUInt32LE(sequence >>> 0, 8); // sequence number
  h.writeUInt16LE(msgId, 14);
  h.writeUInt32LE(body.length + 2, 16); // + \n \0
  return Buffer.concat([h, body, Buffer.from([0x0A, 0x00])]);
}

/**
 * Parse DVRIP V5.00 response (20-byte header + JSON).
 * Reused from _xiongmai_dvrip.js for consistency.
 *
 * @param {Buffer} data - Raw response data
 * @param {number} expectedMsgId - Expected message ID
 * @returns {object} Parsed response { Ret, SessionId, success }
 */
function parseV5Response(data, expectedMsgId) {
  if (data.length < 20) {
    throw new Error('Response too short for V5.00 header');
  }

  const msgId = data.readUInt16LE(14);
  const len = data.readUInt32LE(16);

  if (msgId !== expectedMsgId) {
    throw new Error(`Expected msg ${expectedMsgId}, got ${msgId}`);
  }

  if (data.length < 20 + len) {
    throw new Error('Response too short for payload');
  }

  const body = data.subarray(20, 20 + Math.min(len, data.length - 20)).toString('utf8');
  let ret = '?';
  try {
    const j = JSON.parse(body.replace(/\n\x00*$/, ''));
    ret = j.Ret;
  } catch (err) {
    // If JSON parsing fails, try to parse as binary Ret value
    if (data.length >= 24) {
      ret = data.readUInt32LE(20);
    }
  }

  return { Ret: ret, success: ret === 100 };
}

/**
 * Parse OPMonitor claim response (msg 1414) - V5.00 JSON protocol.
 *
 * @param {Buffer} data - Response data
 * @returns {object} Parsed response { Ret, success }
 */
function parseMonitorClaimResponse(data) {
  return parseV5Response(data, MSG_MONITOR_CLAIM_RESPONSE);
}

/**
 * Parse OPMonitor start response (msg 1411) - V5.00 JSON protocol.
 *
 * @param {Buffer} data - Response data
 * @returns {object} Parsed response { Ret, success }
 */
function parseMonitorStartResponse(data) {
  return parseV5Response(data, MSG_MONITOR_START_RESPONSE);
}

/**
 * Parse DVRIP video data (msg 1412) - Binary protocol.
 *
 * Video payload structure:
 * - 20-byte DVRIP header
 * - Binary video data (H.264/H.265 frames)
 * - Frame markers: 0x1fc (I-frame), 0x1fd (P-frame)
 *
 * @param {Buffer} data - Raw video data
 * @returns {object} Parsed video frame { marker, codec, frameData, size }
 */
function parseVideoData(data) {
  if (data.length < 20) {
    throw new Error('Video data too short for DVRIP header');
  }

  const msgId = data.readUInt16LE(14);
  if (msgId !== MSG_MONITOR_DATA) {
    throw new Error(`Expected video data msg ${MSG_MONITOR_DATA}, got ${msgId}`);
  }

  // Extract video payload (after 20-byte header)
  const videoPayload = data.subarray(20);

  if (videoPayload.length < 4) {
    throw new Error('Video payload too short');
  }

  // Detect frame marker (first 4 bytes)
  const marker = videoPayload.readUInt32BE(0);

  let frameType = 'unknown';
  if (marker === VIDEO_MARKER_I_FRAME) {
    frameType = 'I-frame';
  } else if (marker === VIDEO_MARKER_P_FRAME) {
    frameType = 'P-frame';
  }

  // Detect codec based on NAL unit header (H.264/H.265)
  let codec = 'unknown';
  if (videoPayload.length >= 5) {
    const nalHeader = videoPayload[4];
    // H.264 NAL units start with 0x67 (SPS), 0x68 (PPS), 0x65 (IDR)
    if (nalHeader === 0x67 || nalHeader === 0x68 || nalHeader === 0x65) {
      codec = 'H.264';
    }
    // H.265 NAL units have different structure
    else if ((nalHeader & 0x7E) === 0x40) {
      codec = 'H.265';
    }
  }

  return {
    marker,
    frameType,
    codec,
    frameData: videoPayload,
    size: videoPayload.length,
  };
}

/**
 * DVRIP message framer — extracts complete DVRIP V5.00 messages from a TCP
 * byte stream. Each message starts with a 20-byte header; the length field
 * at offset 16 declares the body size (including the trailing \n\0, so the
 * total on-wire message is 20 + len bytes). This framer correctly handles:
 *
 * - a single message split across multiple TCP chunks
 * - multiple messages arriving in one TCP chunk
 * - leftover bytes after the last complete message (retained in internal buffer)
 *
 * Usage:
 *   const framer = new DvrIpFramer();
 *   framer.feed(chunk, (msgId, payload) => { /* complete message *\/ });
 *   // remaining incomplete bytes stay in framer._buf until fed again
 */
class DvrIpFramer {
  constructor() {
    this._buf = Buffer.alloc(0);
  }

  /**
   * Feed a TCP chunk; invoke cb for every complete DVRIP message.
   * @param {Buffer} chunk - raw TCP data
   * @param {function(msgId: number, payload: Buffer, rawMsg: Buffer)} cb
   */
  feed(chunk, cb) {
    this._buf = this._buf.length ? Buffer.concat([this._buf, chunk]) : chunk;
    let consumed = 0;
    while (true) {
      const remaining = this._buf.length - consumed;
      if (remaining < 20) break; // need at least the header
      const len = this._buf.readUInt32LE(consumed + 16);
      const total = 20 + len;
      if (remaining < total) break; // incomplete message, wait for more data
      const msgId = this._buf.readUInt16LE(consumed + 14);
      const payload = this._buf.subarray(consumed + 20, consumed + 20 + len);
      const rawMsg = this._buf.subarray(consumed, consumed + total);
      consumed += total;
      cb(msgId, payload, rawMsg);
    }
    // Retain any leftover bytes (incomplete message or nothing left)
    this._buf = consumed > 0 ? this._buf.subarray(consumed) : this._buf;
  }

  reset() {
    this._buf = Buffer.alloc(0);
  }
}

/**
 * Xiongmai Video Stream Class
 *
 * Manages OPMonitor video streaming from Xiongmai cameras.
 *
 * TCP framing strategy:
 *   DVRIP TCP data is reassembled in two layers:
 *     1. DvrIpFramer splits the raw TCP stream into individual 1412 messages
 *        (each with a 20-byte V5.00 header + binary payload).
 *     2. MediaReassembler (from this same file) reassembles the binary
 *        video payloads into complete H.264/H.265 frames, correctly handling
 *        frames that span multiple 1412 messages and multiple frames that
 *        arrive in a single 1412 payload.
 *
 * The frameCallback receives a Frame object from MediaReassembler:
 *   { kind: 'video'|'jpeg'|'audio'|'info'|'unknown',
 *     data: Buffer,          // complete reassembled frame bytes
 *     codec?: string,        // e.g. 'h264', 'h265', 'g711a'
 *     frameType?: 'I'|'P',   // for video frames
 *     width?, height?, fps?, sampleRate? }
 */
class XiongmaiVideoStream {
  constructor(ip, port = 34567) {
    this.ip = ip;
    this.port = port;
    this.socket = null;
    this.sessionId = 0;
    this.isStreaming = false;
    this.frameCallback = null;
    this.errorCallback = null;
    this._framer = null;
    this._reassembler = null;
  }

  /**
   * Start video streaming using an existing authenticated socket.
   *
   * @param {net.Socket} socket - Existing authenticated socket (from XiongmaiDvripAdapter)
   * @param {number} sessionId - Session ID from login
   * @param {object} options - Stream options { channel, streamType, transMode }
   * @param {function} frameCallback - Callback for reassembled video frames
   * @param {function} errorCallback - Callback for errors
   */
  async startStreaming(socket, sessionId, options = {}, frameCallback = null, errorCallback = null) {
    this.sessionId = sessionId;
    this.frameCallback = frameCallback;
    this.errorCallback = errorCallback;
    this.socket = socket;

    // Create frame reassembler — onFrame emits complete H.265/H.264 frames
    this._reassembler = new MediaReassembler((frame) => {
      if (this.frameCallback) {
        this.frameCallback(frame);
      }
    });

    return new Promise((resolve, reject) => {
      let step = 'claim';
      let responseData = Buffer.alloc(0);
      const framer = new DvrIpFramer();
      this._framer = framer;

      const timeout = setTimeout(() => {
        this.socket.destroy();
        reject(new Error(`Video stream ${step} timeout`));
      }, 10000);

      // Send OPMonitor claim immediately
      const claimMsg = buildMonitorClaimMessage(sessionId, options);
      this.socket.write(claimMsg);

      const dataHandler = (data) => {
        if (step === 'streaming') {
          // During streaming: frame TCP data into DVRIP messages, then
          // feed 1412 payloads to the MediaReassembler.
          framer.feed(data, (msgId, payload) => {
            if (msgId === MSG_MONITOR_DATA) {
              // Feed the raw video payload to the reassembler
              this._reassembler.push(payload);
            }
            // Other msgIds during streaming are ignored (keepalive responses, etc.)
          });
        } else {
          // During claim/start handshake: accumulate data and parse responses
          responseData = Buffer.concat([responseData, data]);

          try {
            if (step === 'claim') {
              const response = parseMonitorClaimResponse(responseData);
              if (response.success) {
                step = 'start';
                responseData = Buffer.alloc(0);
                framer.reset();
                const startMsg = buildMonitorStartMessage(sessionId, options);
                this.socket.write(startMsg);
                // Fire-and-forget: don't wait for 1411 response
                // Media arrival (1412) proves start succeeded
                clearTimeout(timeout);
                this.isStreaming = true;
                step = 'streaming';
                resolve({ success: true, sessionId });
              } else {
                clearTimeout(timeout);
                this.socket.destroy();
                reject(new Error(`Monitor claim failed: Ret=${response.Ret}`));
              }
            }
          } catch (err) {
            // Need more data or parse error
            if (!err.message.includes('too short')) {
              if (this.errorCallback) {
                this.errorCallback(err);
              }
            }
          }
        }
      };

      this.socket.on('data', dataHandler);

      this.socket.on('error', (err) => {
        clearTimeout(timeout);
        if (this.errorCallback) {
          this.errorCallback(err);
        }
        reject(err);
      });

      this.socket.on('timeout', () => {
        clearTimeout(timeout);
        this.socket.destroy();
        reject(new Error('Video stream timeout'));
      });
    });
  }

  /**
   * Stop video streaming.
   */
  stopStreaming() {
    this.isStreaming = false;
    if (this._reassembler) {
      this._reassembler = null;
    }
    if (this._framer) {
      this._framer.reset();
      this._framer = null;
    }
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
  }
}

module.exports = {
  XiongmaiVideoStream,
  MediaReassembler,
  DvrIpFramer,
  buildMonitorClaimMessage,
  buildMonitorStartMessage,
  parseMonitorClaimResponse,
  parseMonitorStartResponse,
  parseVideoData,
  MSG_MONITOR_CLAIM,
  MSG_MONITOR_CLAIM_RESPONSE,
  MSG_MONITOR_START,
  MSG_MONITOR_START_RESPONSE,
  MSG_MONITOR_DATA,
  VIDEO_MARKER_I_FRAME,
  VIDEO_MARKER_P_FRAME,
  SIG,
  CODEC_NAMES,
};
