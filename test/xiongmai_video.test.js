'use strict';

/**
 * Unit tests for lib/_xiongmai_video.js
 *
 * Tests MediaReassembler frame reassembly across TCP chunk boundaries,
 * DvrIpFramer message extraction, and XiongmaiVideoStream callback delivery.
 * No hardware required — uses synthetic DVRIP video payloads.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('events');

const {
  MediaReassembler,
  DvrIpFramer,
  XiongmaiVideoStream,
  parseVideoData,
  MSG_MONITOR_DATA,
  VIDEO_MARKER_I_FRAME,
  VIDEO_MARKER_P_FRAME,
  SIG,
  CODEC_NAMES,
} = require('../lib/_xiongmai_video');

describe('DvrIpFramer', () => {
  test('buffers incomplete 20-byte header across chunks', () => {
    const framer = new DvrIpFramer();
    const results = [];

    // Split header into two chunks
    const msg = buildTestDvrIpMessage(0x0400, Buffer.alloc(10, 0xAA));
    framer.feed(msg.subarray(0, 10), (msgId) => { results.push(msgId); });
    assert.equal(results.length, 0);
    framer.feed(msg.subarray(10), (msgId) => { results.push(msgId); });
    assert.equal(results.length, 1);
    assert.equal(results[0], 0x0400);
  });

  test('extracts multiple messages from single chunk', () => {
    const framer = new DvrIpFramer();
    const results = [];

    const msg1 = buildTestDvrIpMessage(0x0584, Buffer.alloc(10, 0xBB));
    const msg2 = buildTestDvrIpMessage(0x0584, Buffer.alloc(20, 0xCC));
    const combined = Buffer.concat([msg1, msg2]);

    framer.feed(combined, (msgId) => { results.push(msgId); });
    assert.equal(results.length, 2);
    assert.equal(results[0], 0x0584);
    assert.equal(results[1], 0x0584);
  });

  test('retains leftover bytes after last complete message', () => {
    const framer = new DvrIpFramer();
    const results = [];

    const msg = buildTestDvrIpMessage(0x0400, Buffer.alloc(10, 0xAA));
    const incomplete = msg.subarray(0, msg.length - 4); // last 4 bytes missing
    framer.feed(incomplete, (msgId) => { results.push(msgId); });
    assert.equal(results.length, 0);

    // Feed remaining bytes
    framer.feed(msg.subarray(msg.length - 4), (msgId) => { results.push(msgId); });
    assert.equal(results.length, 1);
  });

  test('handles empty chunk gracefully', () => {
    const framer = new DvrIpFramer();
    const results = [];
    framer.feed(Buffer.alloc(0), (msgId) => { results.push(msgId); });
    assert.equal(results.length, 0);
  });

  test('reset clears internal buffer', () => {
    const framer = new DvrIpFramer();
    const partial = Buffer.alloc(10);
    framer.feed(partial, () => {});
    assert.equal(framer._buf.length, 10);
    framer.reset();
    assert.equal(framer._buf.length, 0);
  });

  test('extracts payload correctly', () => {
    const framer = new DvrIpFramer();
    const payload = Buffer.from('hello-payload-data');
    const msg = buildTestDvrIpMessage(0x0400, payload);
    let extractedPayload = null;
    let extractedMsgId = null;

    framer.feed(msg, (msgId, pl) => {
      extractedMsgId = msgId;
      extractedPayload = pl;
    });

    assert.equal(extractedMsgId, 0x0400);
    // The framer extracts the full body including the 2-byte \n\0 terminator
    assert.equal(extractedPayload.length, payload.length + 2);
    assert.deepEqual(extractedPayload.subarray(0, payload.length), payload);
  });
});

describe('MediaReassembler', () => {
  test('emits complete I-frame from single chunk', () => {
    const frames = [];
    const r = new MediaReassembler((f) => frames.push(f));

    const frameData = buildH265IFrame(100);
    r.push(frameData);

    assert.equal(frames.length, 1);
    assert.equal(frames[0].kind, 'video');
    assert.equal(frames[0].frameType, 'I');
    assert.equal(frames[0].codec, 'h265');
    assert.equal(frames[0].data.length, frameData.length - 16); // minus 16-byte header
  });

  test('reassembles I-frame split across multiple chunks', () => {
    const frames = [];
    const r = new MediaReassembler((f) => frames.push(f));

    const frameData = buildH265IFrame(500);
    r.push(frameData.subarray(0, 100));
    assert.equal(frames.length, 0);
    r.push(frameData.subarray(100, 300));
    assert.equal(frames.length, 0);
    r.push(frameData.subarray(300));
    assert.equal(frames.length, 1);

    assert.equal(frames[0].kind, 'video');
    assert.equal(frames[0].frameType, 'I');
    assert.equal(frames[0].codec, 'h265');
    assert.equal(frames[0].data.length, 500);
  });

  test('handles P-frame emission', () => {
    const frames = [];
    const r = new MediaReassembler((f) => frames.push(f));

    const frameData = buildH265PFrame(200);
    r.push(frameData);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].kind, 'video');
    assert.equal(frames[0].frameType, 'P');
    assert.equal(frames[0].data.length, 200);
  });

  test('processes multiple frames in single chunk', () => {
    const frames = [];
    const r = new MediaReassembler((f) => frames.push(f));

    const iframe1 = buildH265IFrame(100);
    const pframe = buildH265PFrame(100);
    const iframe2 = buildH265IFrame(100);
    const combined = Buffer.concat([iframe1, pframe, iframe2]);

    r.push(combined);
    assert.equal(frames.length, 3);
    assert.equal(frames[0].frameType, 'I');
    assert.equal(frames[1].frameType, 'P');
    assert.equal(frames[2].frameType, 'I');
  });

  test('does not lose trailing frame data', () => {
    const frames = [];
    const r = new MediaReassembler((f) => frames.push(f));

    const iframe1 = buildH265IFrame(100);
    const partialIframe2 = buildH265IFrame(100).subarray(0, 20);

    r.push(Buffer.concat([iframe1, partialIframe2]));
    assert.equal(frames.length, 1); // only first frame complete
    assert.equal(frames[0].frameType, 'I');
    // After consuming the first frame (116 bytes) and the 16-byte header of
    // the second frame + 4 bytes of its payload, the remaining 96 bytes are
    // still expected. The 4 trailing bytes are preserved in _pending.parts.
    assert.ok(r._pending !== null); // second frame in progress
    assert.equal(r._pending.remain, 96); // 100 declared - 4 consumed
    assert.equal(r._pending.parts.length, 1);
    assert.equal(r._pending.parts[0].length, 4); // trailing bytes preserved
    assert.equal(r._buf.length, 0);
  });

  test('emits jpeg for JPEG signature', () => {
    const frames = [];
    const r = new MediaReassembler((f) => frames.push(f));

    const jpegData = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
    r.push(jpegData);
    assert.equal(frames.length, 1);
    assert.equal(frames[0].kind, 'jpeg');
    assert.equal(frames[0].data.length, jpegData.length);
  });

  test('frame has data property, not frameData', () => {
    const frames = [];
    const r = new MediaReassembler((f) => frames.push(f));
    r.push(buildH265IFrame(100));
    assert.ok(Buffer.isBuffer(frames[0].data));
    assert.equal(frames[0].frameData, undefined);
  });
});

describe('XiongmaiVideoStream integration with MediaReassembler', () => {
  test('startStreaming accepts socket, sessionId, options, callbacks', () => {
    const stream = new XiongmaiVideoStream('192.168.1.1', 34567);
    assert.equal(stream.ip, '192.168.1.1');
    assert.equal(stream.port, 34567);
    assert.equal(stream.isStreaming, false);
    assert.equal(stream.socket, null);
  });

  test('stopStreaming clears state and stops reassembler', () => {
    const stream = new XiongmaiVideoStream('192.168.1.1');
    stream._reassembler = new MediaReassembler(() => {});
    stream._framer = new DvrIpFramer();
    stream._framer._buf = Buffer.from('test');
    stream.stopStreaming();
    assert.equal(stream.isStreaming, false);
    assert.equal(stream._reassembler, null);
    assert.equal(stream._framer, null);
  });

  test('exports DvrIpFramer and MediaReassembler', () => {
    assert.ok(typeof DvrIpFramer === 'function');
    assert.ok(typeof MediaReassembler === 'function');
  });
});

describe('parseVideoData (legacy helper)', () => {
  test('parses H.265 I-frame payload', () => {
    const videoPayload = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x01, 0xfc]),
      Buffer.from([0x40, 0x01, 0x00, 0x00]),
      Buffer.alloc(50, 0xAB),
    ]);
    // parseVideoData expects a full DVRIP 1412 message (20-byte header + payload)
    const msg = buildTestDvrIpMessage(MSG_MONITOR_DATA, videoPayload);
    const frame = parseVideoData(msg);
    assert.equal(frame.marker, 0x000001fc);
    assert.equal(frame.frameType, 'I-frame');
    assert.equal(frame.codec, 'H.265');
    // parseVideoData returns frameData = subarray(20) which includes \n\0
    assert.equal(frame.size, videoPayload.length + 2);
    assert.ok(Buffer.isBuffer(frame.frameData));
  });

  test('parses H.265 P-frame payload', () => {
    const videoPayload = Buffer.concat([
      Buffer.from([0x00, 0x00, 0x01, 0xfd]), // P-frame marker
      Buffer.from([0x40, 0x01, 0x00, 0x00]),  // H.265 NAL header byte (0x40: (0x40 & 0x7E) === 0x40)
      Buffer.alloc(50, 0xCD),
    ]);
    const msg = buildTestDvrIpMessage(MSG_MONITOR_DATA, videoPayload);
    const frame = parseVideoData(msg);
    assert.equal(frame.marker, 0x000001fd);
    assert.equal(frame.frameType, 'P-frame');
    assert.equal(frame.codec, 'H.265');
  });
});

// ── helpers ────────────────────────────────────────────────────────────

/** Build a test DVRIP V5.00 message: 20-byte header + payload + \n\0 */
function buildTestDvrIpMessage(msgId, body) {
  const h = Buffer.alloc(20);
  h[0] = 0xFF;
  h[1] = 0x00;
  h.writeUInt16LE(msgId, 14);
  h.writeUInt32LE(body.length + 2, 16);
  return Buffer.concat([h, body, Buffer.from([0x0A, 0x00])]);
}

/** Build a synthetic H.265 I-frame payload with SIG.I marker + 16-byte header */
function buildH265IFrame(payloadLen) {
  const header = Buffer.alloc(16);
  header.writeUInt32BE(SIG.I, 0); // 0x000001fc
  header[4] = 3;                    // media=3 → h265
  header.writeUInt32LE(payloadLen, 12); // declared length (LE)
  const payload = Buffer.alloc(payloadLen, 0xAB);
  return Buffer.concat([header, payload]);
}

/** Build a synthetic H.265 P-frame payload with SIG.P marker + 8-byte header */
function buildH265PFrame(payloadLen) {
  const header = Buffer.alloc(8);
  header.writeUInt32BE(SIG.P, 0); // 0x000001fd
  header.writeUInt32LE(payloadLen, 4); // declared length (LE)
  const payload = Buffer.alloc(payloadLen, 0xCD);
  return Buffer.concat([header, payload]);
}
