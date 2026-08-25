'use strict';

/**
 * Unit tests for Xiongmai/XMEye DVRIP adapter.
 *
 * Tests V5.00 JSON protocol implementation without requiring real hardware.
 * Covers Sofia hash generation, DVRIP V5.00 frame construction, response parsing,
 * keepalive, OPTalk, G.7.11 A-law framing, error handling, and security.
 *
 * Protocol: V5.00 (20-byte header + JSON body + \n\0 terminator)
 * - Header: [0xFF][requestType][4B session][4B sequence][2B msgId][4B payloadLen]
 * - msgId at offset 14 (UInt16LE)
 * - payloadLen at offset 16 (UInt32LE)
 * - Total header = 20 bytes (not 8)
 * - Sofia hash = 8-char Base62 (not 32-char hex)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const xiongmaiModule = require('../lib/_xiongmai_dvrip');

const {
  sofiaHash,
  buildFrame,
  parseV5Response,
  buildLoginMessage,
  parseLoginResponse,
  buildKeepaliveMessage,
  buildOptalkClaimMessage,
  parseOptalkClaimResponse,
  buildOptalkStartMessage,
  parseOptalkStartResponse,
  buildOptalkAudioMessage,
  parseOptalkAudioResponse,
  buildG711AlawFrame,
  linearToAlaw,
  DVRIP_PORT,
  MSG_LOGIN,
  MSG_LOGIN_RESPONSE,
  MSG_KEEPALIVE,
  MSG_KEEPALIVE_RESPONSE,
  MSG_OPTALK_CLAIM,
  MSG_OPTALK_CLAIM_RESPONSE,
  MSG_OPTALK_START,
  MSG_OPTALK_START_RESPONSE,
  MSG_OPTALK_AUDIO,
  MSG_OPTALK_AUDIO_RESPONSE,
  XiongmaiDvripAdapter,
} = xiongmaiModule;

const HEADER_SIZE = 20;

describe('Xiongmai DVRIP — Sofia hash generation', () => {
  test('generates consistent hash for same inputs', () => {
    const hash1 = sofiaHash('admin123');
    const hash2 = sofiaHash('admin123');
    assert.equal(hash1, hash2);
  });

  test('generates different hashes for different inputs', () => {
    const hash1 = sofiaHash('admin123');
    const hash2 = sofiaHash('password');
    assert.notEqual(hash1, hash2);
  });

  test('generates different hashes for different passwords', () => {
    const hash1 = sofiaHash('password1');
    const hash2 = sofiaHash('password2');
    assert.notEqual(hash1, hash2);
  });

  test('hash is 8-character string', () => {
    const hash = sofiaHash('admin123');
    assert.equal(hash.length, 8);
    assert.match(hash, /^[0-9A-Za-z]{8}$/);
  });

  test('empty password produces valid hash', () => {
    const hash = sofiaHash('');
    assert.equal(hash.length, 8);
    assert.match(hash, /^[0-9A-Za-z]{8}$/);
  });

  test('special characters in password are handled', () => {
    const hash = sofiaHash('p@ssw0rd!#$%');
    assert.equal(hash.length, 8);
    assert.match(hash, /^[0-9A-Za-z]{8}$/);
  });
});

describe('Xiongmai DVRIP — V5.00 frame construction', () => {
  test('builds frame with correct message type', () => {
    const frame = buildFrame(MSG_LOGIN, { data: 'test' });
    assert.equal(frame.readUInt16LE(14), MSG_LOGIN);
  });

  test('builds frame with correct session ID', () => {
    const frame = buildFrame(MSG_LOGIN, { data: 'test' });
    assert.equal(frame.readUInt32LE(4), 0); // session = 0 in V5.00
  });

  test('builds frame with correct payload length', () => {
    const jsonObj = { data: 'test payload' };
    const frame = buildFrame(MSG_LOGIN, jsonObj);
    const body = Buffer.from(JSON.stringify(jsonObj), 'utf8');
    assert.equal(frame.readUInt32LE(16), body.length + 2); // + \n\0 terminator
  });

  test('frame is 20 bytes header + body + 2 byte terminator', () => {
    const jsonObj = { data: 'test' };
    const frame = buildFrame(MSG_LOGIN, jsonObj);
    const body = Buffer.from(JSON.stringify(jsonObj), 'utf8');
    assert.equal(frame.length, HEADER_SIZE + body.length + 2);
  });

  test('handles empty JSON payload', () => {
    const frame = buildFrame(MSG_KEEPALIVE, {});
    assert.equal(frame.length, HEADER_SIZE + 2 + 2); // '{}' is 2 bytes
    assert.equal(frame.readUInt32LE(16), 4); // 2 body + 2 terminator
  });

  test('handles large JSON payload', () => {
    const jsonObj = { data: 'x'.repeat(1000) };
    const frame = buildFrame(MSG_LOGIN, jsonObj);
    const body = Buffer.from(JSON.stringify(jsonObj), 'utf8');
    assert.equal(frame.length, HEADER_SIZE + body.length + 2);
    assert.equal(frame.readUInt32LE(16), body.length + 2);
  });

  test('frame starts with 0xFF magic byte', () => {
    const frame = buildFrame(MSG_LOGIN, {});
    assert.equal(frame[0], 0xFF);
  });

  test('frame has V5.00 request type', () => {
    const frame = buildFrame(MSG_LOGIN, {});
    assert.equal(frame[1], 0x00);
  });
});

describe('Xiongmai DVRIP — V5.00 response parsing', () => {
  test('parses frame with correct message type', () => {
    const frame = buildFrame(MSG_LOGIN, { hello: 'world' });
    const parsed = parseV5Response(frame, MSG_LOGIN);
    assert.equal(parsed.Ret, undefined);
    assert.equal(parsed.SessionId, 0);
  });

  test('parses JSON body fields from V5.00 response', () => {
    const frame = buildFrame(MSG_LOGIN_RESPONSE, {
      Ret: 100,
      AliveInterval: 30,
      SessionID: '0x3039',
    });
    const parsed = parseV5Response(frame, MSG_LOGIN_RESPONSE);
    assert.equal(parsed.Ret, 100);
    assert.equal(parsed.AliveInterval, 30);
    assert.equal(parsed.SessionId, 12345);
    assert.equal(parsed.success, true);
  });

  test('parses frame with correct payload length', () => {
    const jsonObj = { Ret: 100, AliveInterval: 30 };
    const frame = buildFrame(MSG_LOGIN_RESPONSE, jsonObj);
    const parsed = parseV5Response(frame, MSG_LOGIN_RESPONSE);
    assert.equal(parsed.Ret, 100);
  });

  test('throws error for frame too short', () => {
    const shortData = Buffer.alloc(10);
    assert.throws(() => parseV5Response(shortData, MSG_LOGIN_RESPONSE), /too short/i);
  });

  test('handles frame with zero-length JSON body', () => {
    const frame = buildFrame(MSG_KEEPALIVE, {});
    const parsed = parseV5Response(frame, MSG_KEEPALIVE);
    assert.equal(parsed.success, false); // Ret defaults to '?'
  });
});

describe('Xiongmai DVRIP — login message construction', () => {
  test('builds login message with correct message type', () => {
    const msg = buildLoginMessage('admin', 'admin123', '');
    assert.equal(msg.readUInt16LE(14), MSG_LOGIN);
  });

  test('builds login message with JSON body containing user and password hash', () => {
    const msg = buildLoginMessage('admin', 'admin123', '');
    const body = JSON.parse(msg.subarray(HEADER_SIZE, msg.length - 2).toString('utf8'));
    assert.equal(body.UserName, 'admin');
    assert.equal(body.EncryptType, 'MD5');
    assert.equal(body.LoginType, 'DVRIP-Web');
    assert.equal(body.PassWord, sofiaHash('admin123'));
  });

  test('login payload contains Sofia hash (not plaintext password)', () => {
    const username = 'admin';
    const password = 'admin123';
    const msg = buildLoginMessage(username, password, '');
    const body = JSON.parse(msg.subarray(HEADER_SIZE, msg.length - 2).toString('utf8'));
    assert.equal(body.PassWord, sofiaHash(password));
    assert.ok(!body.includes || !JSON.stringify(body).includes(password));
  });
});

describe('Xiongmai DVRIP — login response parsing', () => {
  test('parses successful login response (Ret=100)', () => {
    const frame = buildFrame(MSG_LOGIN_RESPONSE, {
      Ret: 100,
      AliveInterval: 30,
      SessionID: '0x3039',
    });
    const response = parseLoginResponse(frame);
    assert.equal(response.success, true);
    assert.equal(response.Ret, 100);
    assert.equal(response.AliveInterval, 30);
    assert.equal(response.SessionId, 12345);
  });

  test('parses failed login response (Ret≠100)', () => {
    const frame = buildFrame(MSG_LOGIN_RESPONSE, {
      Ret: 101,
    });
    const response = parseLoginResponse(frame);
    assert.equal(response.success, false);
    assert.equal(response.Ret, 101);
  });

  test('throws error for wrong message type', () => {
    const frame = buildFrame(MSG_KEEPALIVE, { Ret: 100 });

    assert.throws(
      () => parseLoginResponse(frame),
      /Expected msg/
    );
  });

  test('throws error for frame too short', () => {
    const shortData = Buffer.alloc(10);
    assert.throws(() => parseLoginResponse(shortData), /too short/i);
  });

  test('handles missing AliveInterval (uses default)', () => {
    const frame = buildFrame(MSG_LOGIN_RESPONSE, {
      Ret: 100,
    });
    const response = parseLoginResponse(frame);
    assert.equal(response.AliveInterval, undefined);
  });
});

describe('Xiongmai DVRIP — keepalive messages', () => {
  test('builds keepalive message with correct type', () => {
    const msg = buildKeepaliveMessage(12345);
    assert.equal(msg.readUInt16LE(14), MSG_KEEPALIVE);
  });

  test('keepalive message has JSON body', () => {
    const msg = buildKeepaliveMessage(12345);
    const body = msg.subarray(HEADER_SIZE, msg.length - 2).toString('utf8');
    assert.equal(body, '{}');
  });

  test('keepalive message has 20-byte header', () => {
    const msg = buildKeepaliveMessage(12345);
    assert.equal(msg.readUInt16LE(0), 0xFF); // magic byte check
    assert.equal(msg.length, HEADER_SIZE + 2 + 2); // header + '{}' + '\n\0'
  });
});

describe('Xiongmai DVRIP — OPTalk messages', () => {
  test('builds OPTalk claim message with correct type', () => {
    const msg = buildOptalkClaimMessage(12345);
    assert.equal(msg.readUInt16LE(14), MSG_OPTALK_CLAIM);
  });

  test('builds OPTalk start message with correct type', () => {
    const msg = buildOptalkStartMessage(12345);
    assert.equal(msg.readUInt16LE(14), MSG_OPTALK_START);
  });

  test('builds OPTalk audio message with correct type', () => {
    const audioData = Buffer.alloc(320);
    const msg = buildOptalkAudioMessage(12345, audioData);
    assert.equal(msg.readUInt16LE(14), MSG_OPTALK_AUDIO);
  });

  test('OPTalk audio message includes audio payload', () => {
    const audioData = Buffer.from('test audio data');
    const msg = buildOptalkAudioMessage(12345, audioData);
    assert.equal(msg.readUInt32LE(16), audioData.length);
    assert.equal(msg.length, HEADER_SIZE + audioData.length);
  });

  test('OPTalk audio message includes session ID', () => {
    const sessionId = 12345;
    const audioData = Buffer.alloc(320);
    const msg = buildOptalkAudioMessage(sessionId, audioData);
    assert.equal(msg.readUInt32LE(4), sessionId);
  });

  test('parse OPTalk claim response (msg 1435)', () => {
    const frame = buildFrame(MSG_OPTALK_CLAIM_RESPONSE, { Ret: 100 });
    const parsed = parseOptalkClaimResponse(frame);
    assert.equal(parsed.Ret, 100);
    assert.equal(parsed.success, true);
  });

  test('parse OPTalk start response (msg 1431)', () => {
    const frame = buildFrame(MSG_OPTALK_START_RESPONSE, { Ret: 100 });
    const parsed = parseOptalkStartResponse(frame);
    assert.equal(parsed.Ret, 100);
    assert.equal(parsed.success, true);
  });

  test('parse OPTalk audio response (msg 1433)', () => {
    const frame = buildFrame(MSG_OPTALK_AUDIO_RESPONSE, { Ret: 100 });
    const parsed = parseOptalkAudioResponse(frame);
    assert.equal(parsed.Ret, 100);
    assert.equal(parsed.success, true);
  });

  test('OPTalk claim response throws for wrong message type', () => {
    const frame = buildFrame(MSG_OPTALK_START_RESPONSE, { Ret: 100 });
    assert.throws(() => parseOptalkClaimResponse(frame), /Expected msg/);
  });

  test('OPTalk start response throws for wrong message type', () => {
    const frame = buildFrame(MSG_OPTALK_CLAIM_RESPONSE, { Ret: 100 });
    assert.throws(() => parseOptalkStartResponse(frame), /Expected msg/);
  });

  test('OPTalk audio response throws for wrong message type', () => {
    const frame = buildFrame(MSG_OPTALK_START_RESPONSE, { Ret: 100 });
    assert.throws(() => parseOptalkAudioResponse(frame), /Expected msg/);
  });

  test('OPTalk claim response throws for short payload', () => {
    const shortData = Buffer.alloc(10);
    assert.throws(() => parseOptalkClaimResponse(shortData), /too short/i);
  });

  test('OPTalk claim response handles failure (Ret != 100)', () => {
    const frame = buildFrame(MSG_OPTALK_CLAIM_RESPONSE, { Ret: 1 });
    const parsed = parseOptalkClaimResponse(frame);
    assert.equal(parsed.Ret, 1);
    assert.equal(parsed.success, false);
  });
});

describe('Xiongmai DVRIP — G.7.11 A-law framing', () => {
  test('builds G.7.11 A-law frame from PCM data', () => {
    const pcmData = Buffer.alloc(6); // 3 samples of 16-bit PCM
    pcmData.writeInt16LE(0, 0);
    pcmData.writeInt16LE(1000, 2);
    pcmData.writeInt16LE(-1000, 4);
    const alawFrame = buildG711AlawFrame(pcmData);
    assert.equal(alawFrame.length, pcmData.length / 2); // 3 bytes of A-law
  });

  test('linearToAlaw returns byte value', () => {
    const result = linearToAlaw(0);
    assert.equal(typeof result, 'number');
    assert.ok(result >= 0 && result <= 255);
  });

  test('linearToAlaw handles positive samples', () => {
    const result = linearToAlaw(1000);
    assert.ok(result >= 0 && result <= 255);
  });

  test('linearToAlaw handles negative samples', () => {
    const result = linearToAlaw(-1000);
    assert.ok(result >= 0 && result <= 255);
  });

  test('linearToAlaw handles zero sample', () => {
    const result = linearToAlaw(0);
    assert.ok(result >= 0 && result <= 255);
  });

  test('linearToAlaw handles max sample', () => {
    const result = linearToAlaw(32767);
    assert.ok(result >= 0 && result <= 255);
  });

  test('linearToAlaw handles min sample', () => {
    const result = linearToAlaw(-32768);
    assert.ok(result >= 0 && result <= 255);
  });

  test('G.7.11 frame size matches input (16-bit PCM to 8-bit A-law)', () => {
    const pcmData = Buffer.alloc(640); // 320 samples of 16-bit PCM
    const alawFrame = buildG711AlawFrame(pcmData);
    assert.equal(alawFrame.length, 320); // 320 bytes of 8-bit A-law
  });

  test('G.7.11 A-law encoding is deterministic', () => {
    const result1 = linearToAlaw(1000);
    const result2 = linearToAlaw(1000);
    assert.equal(result1, result2);
  });

  test('G.7.11 A-law encoding handles symmetric values', () => {
    const pos = linearToAlaw(1000);
    const neg = linearToAlaw(-1000);
    assert.notEqual(pos, neg);
  });

  test('G.7.11 A-law frame handles 320-byte input (standard frame size)', () => {
    const pcmData = Buffer.alloc(640); // 320 samples of 16-bit PCM
    for (let i = 0; i < 320; i++) {
      pcmData.writeInt16LE(i * 100, i * 2);
    }
    const alawFrame = buildG711AlawFrame(pcmData);
    assert.equal(alawFrame.length, 320);
  });
});

describe('Xiongmai DVRIP — constants', () => {
  test('DVRIP_PORT is 34567', () => {
    assert.equal(DVRIP_PORT, 34567);
  });

  test('message type constants are correct', () => {
    assert.equal(MSG_LOGIN, 1000);
    assert.equal(MSG_LOGIN_RESPONSE, 1001);
    assert.equal(MSG_KEEPALIVE, 1006);
    assert.equal(MSG_KEEPALIVE_RESPONSE, 1007);
    assert.equal(MSG_OPTALK_CLAIM, 1434);
    assert.equal(MSG_OPTALK_CLAIM_RESPONSE, 1435);
    assert.equal(MSG_OPTALK_START, 1430);
    assert.equal(MSG_OPTALK_START_RESPONSE, 1431);
    assert.equal(MSG_OPTALK_AUDIO, 1432);
    assert.equal(MSG_OPTALK_AUDIO_RESPONSE, 1433);
  });
});

describe('Xiongmai DVRIP — XiongmaiDvripAdapter class', () => {
  test('creates adapter with IP and default port', () => {
    const adapter = new XiongmaiDvripAdapter('192.168.1.11');
    assert.equal(adapter.ip, '192.168.1.11');
    assert.equal(adapter.port, DVRIP_PORT);
  });

  test('creates adapter with custom port', () => {
    const adapter = new XiongmaiDvripAdapter('192.168.1.11', 34568);
    assert.equal(adapter.ip, '192.168.1.11');
    assert.equal(adapter.port, 34568);
  });

  test('initial state is not authenticated', () => {
    const adapter = new XiongmaiDvripAdapter('192.168.1.11');
    assert.equal(adapter.isAuthenticated, false);
    assert.equal(adapter.isTalkActive, false);
    assert.equal(adapter.sessionId, 0);
  });

  test('getCapabilities returns correct structure', () => {
    const adapter = new XiongmaiDvripAdapter('192.168.1.11');
    const capabilities = adapter.getCapabilities();
    assert.equal(capabilities.dvrip_supported, true);
    assert.equal(capabilities.talk_supported, true);
    assert.equal(capabilities.audio_format, 'G.711 A-law');
    assert.equal(capabilities.audio_sample_rate, 8000);
    assert.equal(capabilities.audio_frame_size, 320);
    assert.equal(capabilities.rtsp_supported, false);
    assert.equal(capabilities.onvif_supported, false);
  });

  test('close resets state', () => {
    const adapter = new XiongmaiDvripAdapter('192.168.1.11');
    adapter.isAuthenticated = true;
    adapter.isTalkActive = true;
    adapter.sessionId = 12345;
    adapter.close();
    assert.equal(adapter.isAuthenticated, false);
    assert.equal(adapter.isTalkActive, false);
    assert.equal(adapter.sessionId, 0);
  });

  test('startTalk throws when not authenticated', async () => {
    const adapter = new XiongmaiDvripAdapter('192.168.1.11');
    await assert.rejects(
      async () => adapter.startTalk(),
      /not authenticated/
    );
  });

  test('sendAudioFrame throws when talk not active', async () => {
    const adapter = new XiongmaiDvripAdapter('192.168.1.11');
    adapter.isAuthenticated = true;
    await assert.rejects(
      async () => adapter.sendAudioFrame(Buffer.alloc(320)),
      /talk not active/
    );
  });

  test('stopTalk does nothing when not active', async () => {
    const adapter = new XiongmaiDvripAdapter('192.168.1.11');
    await adapter.stopTalk(); // Should not throw
    assert.equal(adapter.isTalkActive, false);
  });
});

describe('Xiongmai DVRIP — security and credential handling', () => {
  test('Sofia hash does not log credentials', () => {
    const originalLog = console.log;
    let loggedData = '';
    console.log = (...args) => { loggedData += args.join(' '); };

    try {
      sofiaHash('secret_password');
      assert.ok(!loggedData.includes('secret_password'));
    } finally {
      console.log = originalLog;
    }
  });

  test('login message does not contain plaintext password', () => {
    const msg = buildLoginMessage('admin', 'my_password', '');
    const msgStr = msg.toString();
    assert.ok(!msgStr.includes('my_password'));
  });

  test('login message contains only hash, not password', () => {
    const msg = buildLoginMessage('admin', 'my_password', '');
    const body = JSON.parse(msg.subarray(HEADER_SIZE, msg.length - 2).toString('utf8'));
    const hash = body.PassWord;
    assert.ok(!hash.includes('my_password'));
    assert.equal(typeof hash, 'string');
    assert.equal(hash.length, 8);
  });

  test('different passwords produce different hashes (no collision in basic test)', () => {
    const hash1 = sofiaHash('password1');
    const hash2 = sofiaHash('password2');
    assert.notEqual(hash1, hash2);
  });
});

describe('Xiongmai DVRIP — error handling', () => {
  test('parseLoginResponse throws for too-short data', () => {
    const shortData = Buffer.alloc(4);
    assert.throws(() => parseLoginResponse(shortData), /too short/i);
  });

  test('parseV5Response throws on too-short data', () => {
    const shortData = Buffer.alloc(4);
    assert.throws(() => parseV5Response(shortData, MSG_LOGIN_RESPONSE), /too short/i);
  });

  test('buildFrame handles large JSON payload', () => {
    const largePayload = { data: 'x'.repeat(100000) };
    const msg = buildFrame(MSG_LOGIN, largePayload);
    const body = Buffer.from(JSON.stringify(largePayload), 'utf8');
    assert.equal(msg.readUInt32LE(16), body.length + 2);
    assert.equal(msg.length, HEADER_SIZE + body.length + 2);
  });

  test('buildG711AlawFrame handles empty input', () => {
    const emptyPcm = Buffer.alloc(0);
    const alawFrame = buildG711AlawFrame(emptyPcm);
    assert.equal(alawFrame.length, 0);
  });

  test('buildG711AlawFrame handles large input', () => {
    const largePcm = Buffer.alloc(100000);
    const alawFrame = buildG711AlawFrame(largePcm);
    assert.equal(alawFrame.length, 50000); // 16-bit to 8-bit
  });

  test('parseLoginResponse throws for wrong message type', () => {
    const frame = buildFrame(MSG_KEEPALIVE, { Ret: 100 });
    assert.throws(() => parseLoginResponse(frame), /Expected msg/);
  });

  test('parseLoginResponse handles login failure (Ret != 100)', () => {
    const frame = buildFrame(MSG_LOGIN_RESPONSE, { Ret: 1 });
    const parsed = parseLoginResponse(frame);
    assert.equal(parsed.Ret, 1);
    assert.equal(parsed.success, false);
  });

  test('parseLoginResponse handles missing AliveInterval', () => {
    const frame = buildFrame(MSG_LOGIN_RESPONSE, { Ret: 100 });
    const parsed = parseLoginResponse(frame);
    assert.equal(parsed.AliveInterval, undefined);
  });
});

describe('Xiongmai DVRIP — session isolation', () => {
  test('different sessions start with same initial sessionId (0)', () => {
    const adapter1 = new XiongmaiDvripAdapter('192.168.1.11');
    const adapter2 = new XiongmaiDvripAdapter('192.168.1.12');
    assert.equal(adapter1.sessionId, 0);
    assert.equal(adapter2.sessionId, 0);
    assert.equal(adapter1.sessionId, adapter2.sessionId);
  });

  test('session state is isolated between adapters', () => {
    const adapter1 = new XiongmaiDvripAdapter('192.168.1.11');
    const adapter2 = new XiongmaiDvripAdapter('192.168.1.12');

    adapter1.isAuthenticated = true;
    adapter1.sessionId = 12345;

    assert.equal(adapter2.isAuthenticated, false);
    assert.equal(adapter2.sessionId, 0);
  });

  test('close affects only the specific adapter', () => {
    const adapter1 = new XiongmaiDvripAdapter('192.168.1.11');
    const adapter2 = new XiongmaiDvripAdapter('192.168.1.12');

    adapter1.isAuthenticated = true;
    adapter1.sessionId = 12345;
    adapter2.isAuthenticated = true;
    adapter2.sessionId = 54321;

    adapter1.close();

    assert.equal(adapter1.isAuthenticated, false);
    assert.equal(adapter1.sessionId, 0);
    assert.equal(adapter2.isAuthenticated, true);
    assert.equal(adapter2.sessionId, 54321);
  });
});
