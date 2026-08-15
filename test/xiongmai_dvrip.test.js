'use strict';

/**
 * Unit tests for Xiongmai/XMEye DVRIP adapter.
 *
 * Tests DVRIP protocol implementation without requiring real hardware.
 * Covers Sofia hash generation, DVRIP header construction, login/response parsing,
 * keepalive, OPTalk, G.711 A-law framing, error handling, and security.
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');

const xiongmaiModule = require('../lib/_xiongmai_dvrip');

const {
  generateSofiaHash,
  buildDvripHeader,
  parseDvripHeader,
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

describe('Xiongmai DVRIP — Sofia hash generation', () => {
  test('generates consistent hash for same inputs', () => {
    const hash1 = generateSofiaHash('admin', 'admin123', '');
    const hash2 = generateSofiaHash('admin', 'admin123', '');
    assert.equal(hash1, hash2);
  });

  test('generates different hashes for different inputs', () => {
    const hash1 = generateSofiaHash('admin', 'admin123', '');
    const hash2 = generateSofiaHash('admin', 'password', '');
    assert.notEqual(hash1, hash2);
  });

  test('generates different hashes for different challenges', () => {
    const hash1 = generateSofiaHash('admin', 'admin123', 'challenge1');
    const hash2 = generateSofiaHash('admin', 'admin123', 'challenge2');
    assert.notEqual(hash1, hash2);
  });

  test('hash is 32-character hex string', () => {
    const hash = generateSofiaHash('admin', 'admin123', '');
    assert.equal(hash.length, 32);
    assert.match(hash, /^[0-9a-f]{32}$/);
  });

  test('empty password produces valid hash', () => {
    const hash = generateSofiaHash('admin', '', '');
    assert.equal(hash.length, 32);
    assert.match(hash, /^[0-9a-f]{32}$/);
  });

  test('special characters in password are handled', () => {
    const hash = generateSofiaHash('admin', 'p@ssw0rd!#$%', '');
    assert.equal(hash.length, 32);
    assert.match(hash, /^[0-9a-f]{32}$/);
  });
});

describe('Xiongmai DVRIP — DVRIP header construction', () => {
  test('builds header with correct message type', () => {
    const payload = Buffer.from('test');
    const header = buildDvripHeader(MSG_LOGIN, 0, payload);
    assert.equal(header.readUInt16LE(0), MSG_LOGIN);
  });

  test('builds header with correct session ID', () => {
    const payload = Buffer.from('test');
    const sessionId = 12345;
    const header = buildDvripHeader(MSG_LOGIN, sessionId, payload);
    assert.equal(header.readUInt16LE(2), sessionId);
  });

  test('builds header with correct payload length', () => {
    const payload = Buffer.from('test payload');
    const header = buildDvripHeader(MSG_LOGIN, 0, payload);
    assert.equal(header.readUInt32LE(4), payload.length);
  });

  test('header is 8 bytes + payload', () => {
    const payload = Buffer.from('test');
    const header = buildDvripHeader(MSG_LOGIN, 0, payload);
    assert.equal(header.length, 8 + payload.length);
  });

  test('handles empty payload', () => {
    const payload = Buffer.alloc(0);
    const header = buildDvripHeader(MSG_KEEPALIVE, 0, payload);
    assert.equal(header.length, 8);
    assert.equal(header.readUInt32LE(4), 0);
  });

  test('handles large payload', () => {
    const payload = Buffer.alloc(1000);
    const header = buildDvripHeader(MSG_LOGIN, 0, payload);
    assert.equal(header.length, 8 + 1000);
    assert.equal(header.readUInt32LE(4), 1000);
  });
});

describe('Xiongmai DVRIP — header parsing', () => {
  test('parses header with correct message type', () => {
    const payload = Buffer.from('test');
    const header = buildDvripHeader(MSG_LOGIN, 0, payload);
    const parsed = parseDvripHeader(header);
    assert.equal(parsed.msgType, MSG_LOGIN);
  });

  test('parses header with correct session ID', () => {
    const payload = Buffer.from('test');
    const sessionId = 54321;
    const header = buildDvripHeader(MSG_LOGIN, sessionId, payload);
    const parsed = parseDvripHeader(header);
    assert.equal(parsed.sessionId, sessionId);
  });

  test('parses header with correct payload length', () => {
    const payload = Buffer.from('test payload');
    const header = buildDvripHeader(MSG_LOGIN, 0, payload);
    const parsed = parseDvripHeader(header);
    assert.equal(parsed.payloadLength, payload.length);
  });

  test('throws error for header too short', () => {
    const shortData = Buffer.alloc(4);
    assert.throws(() => parseDvripHeader(shortData), /DVRIP response too short/);
  });

  test('handles zero payload length', () => {
    const header = buildDvripHeader(MSG_KEEPALIVE, 0, Buffer.alloc(0));
    const parsed = parseDvripHeader(header);
    assert.equal(parsed.payloadLength, 0);
  });
});

describe('Xiongmai DVRIP — login message construction', () => {
  test('builds login message with correct message type', () => {
    const msg = buildLoginMessage('admin', 'admin123', '');
    assert.equal(msg.readUInt16LE(0), MSG_LOGIN);
  });

  test('builds login message with 32-byte payload', () => {
    const msg = buildLoginMessage('admin', 'admin123', '');
    assert.equal(msg.readUInt32LE(4), 32);
    assert.equal(msg.length, 8 + 32);
  });

  test('login payload contains Sofia hash', () => {
    const username = 'admin';
    const password = 'admin123';
    const expectedHash = generateSofiaHash(username, password, '');
    const msg = buildLoginMessage(username, password, '');
    const payload = msg.slice(8);
    const hash = payload.slice(0, 16).toString('hex'); // MD5 hash is 16 bytes
    assert.equal(hash, expectedHash);
  });

  test('different credentials produce different login messages', () => {
    const msg1 = buildLoginMessage('admin', 'password1', '');
    const msg2 = buildLoginMessage('admin', 'password2', '');
    assert.notEqual(msg1, msg2);
  });
});

describe('Xiongmai DVRIP — login response parsing', () => {
  test('parses successful login response (Ret=100)', () => {
    const payload = Buffer.alloc(8);
    payload.writeUInt32LE(100, 0); // Ret = 100 (success)
    payload.writeUInt32LE(30, 4);  // AliveInterval = 30
    const header = buildDvripHeader(MSG_LOGIN_RESPONSE, 12345, payload);
    const response = parseLoginResponse(header);
    assert.equal(response.success, true);
    assert.equal(response.Ret, 100);
    assert.equal(response.AliveInterval, 30);
    assert.equal(response.SessionId, 12345);
  });

  test('parses failed login response (Ret≠100)', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(101, 0); // Ret = 101 (failure)
    const header = buildDvripHeader(MSG_LOGIN_RESPONSE, 0, payload);
    const response = parseLoginResponse(header);
    assert.equal(response.success, false);
    assert.equal(response.Ret, 101);
  });

  test('throws error for wrong message type', () => {
    const payload = Buffer.alloc(4);
    const header = buildDvripHeader(MSG_KEEPALIVE, 0, payload);

    assert.throws(
      () => parseLoginResponse(header),
      /Expected login response/
    );
  });

  test('throws error for payload too short', () => {
    const payload = Buffer.alloc(2); // Too short for Ret field
    const header = buildDvripHeader(MSG_LOGIN_RESPONSE, 0, payload);
    assert.throws(() => parseLoginResponse(header), /payload too short/);
  });

  test('handles missing AliveInterval (uses default)', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(100, 0); // Ret = 100
    const header = buildDvripHeader(MSG_LOGIN_RESPONSE, 0, payload);
    const response = parseLoginResponse(header);
    assert.equal(response.AliveInterval, 30); // Default
  });
});

describe('Xiongmai DVRIP — keepalive messages', () => {
  test('builds keepalive message with correct type', () => {
    const msg = buildKeepaliveMessage(12345);
    assert.equal(msg.readUInt16LE(0), MSG_KEEPALIVE);
  });

  test('builds keepalive message with session ID', () => {
    const sessionId = 54321;
    const msg = buildKeepaliveMessage(sessionId);
    assert.equal(msg.readUInt16LE(2), sessionId);
  });

  test('keepalive message has empty payload', () => {
    const msg = buildKeepaliveMessage(12345);
    assert.equal(msg.readUInt32LE(4), 0);
    assert.equal(msg.length, 8);
  });
});

describe('Xiongmai DVRIP — OPTalk messages', () => {
  test('builds OPTalk claim message with correct type', () => {
    const msg = buildOptalkClaimMessage(12345);
    assert.equal(msg.readUInt16LE(0), MSG_OPTALK_CLAIM);
  });

  test('builds OPTalk start message with correct type', () => {
    const msg = buildOptalkStartMessage(12345);
    assert.equal(msg.readUInt16LE(0), MSG_OPTALK_START);
  });

  test('builds OPTalk audio message with correct type', () => {
    const audioData = Buffer.alloc(320);
    const msg = buildOptalkAudioMessage(12345, audioData);
    assert.equal(msg.readUInt16LE(0), MSG_OPTALK_AUDIO);
  });

  test('OPTalk audio message includes audio payload', () => {
    const audioData = Buffer.from('test audio data');
    const msg = buildOptalkAudioMessage(12345, audioData);
    assert.equal(msg.readUInt32LE(4), audioData.length);
    assert.equal(msg.length, 8 + audioData.length);
  });

  test('OPTalk messages include session ID', () => {
    const sessionId = 54321; // Must be <= 65535 for UInt16
    const claimMsg = buildOptalkClaimMessage(sessionId);
    const startMsg = buildOptalkStartMessage(sessionId);
    assert.equal(claimMsg.readUInt16LE(2), sessionId);
    assert.equal(startMsg.readUInt16LE(2), sessionId);
  });

  test('parse OPTalk claim response (msg 1435)', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(100, 0); // Ret = 100 (success)
    const header = Buffer.alloc(8);
    header.writeUInt16LE(MSG_OPTALK_CLAIM_RESPONSE, 0);
    header.writeUInt16LE(12345, 2);
    header.writeUInt32LE(4, 4);
    const response = Buffer.concat([header, payload]);
    
    const parsed = parseOptalkClaimResponse(response);
    assert.equal(parsed.Ret, 100);
    assert.equal(parsed.success, true);
  });

  test('parse OPTalk start response (msg 1431)', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(100, 0); // Ret = 100 (success)
    const header = Buffer.alloc(8);
    header.writeUInt16LE(MSG_OPTALK_START_RESPONSE, 0);
    header.writeUInt16LE(12345, 2);
    header.writeUInt32LE(4, 4);
    const response = Buffer.concat([header, payload]);
    
    const parsed = parseOptalkStartResponse(response);
    assert.equal(parsed.Ret, 100);
    assert.equal(parsed.success, true);
  });

  test('parse OPTalk audio response (msg 1433)', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(100, 0); // Ret = 100 (success)
    const header = Buffer.alloc(8);
    header.writeUInt16LE(MSG_OPTALK_AUDIO_RESPONSE, 0);
    header.writeUInt16LE(12345, 2);
    header.writeUInt32LE(4, 4);
    const response = Buffer.concat([header, payload]);
    
    const parsed = parseOptalkAudioResponse(response);
    assert.equal(parsed.Ret, 100);
    assert.equal(parsed.success, true);
  });

  test('OPTalk claim response throws for wrong message type', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(100, 0);
    const header = Buffer.alloc(8);
    header.writeUInt16LE(MSG_OPTALK_START_RESPONSE, 0); // Wrong type
    header.writeUInt16LE(12345, 2);
    header.writeUInt32LE(4, 4);
    const response = Buffer.concat([header, payload]);
    
    assert.throws(() => parseOptalkClaimResponse(response), /Expected OPTalk claim response/);
  });

  test('OPTalk start response throws for wrong message type', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(100, 0);
    const header = Buffer.alloc(8);
    header.writeUInt16LE(MSG_OPTALK_CLAIM_RESPONSE, 0); // Wrong type
    header.writeUInt16LE(12345, 2);
    header.writeUInt32LE(4, 4);
    const response = Buffer.concat([header, payload]);
    
    assert.throws(() => parseOptalkStartResponse(response), /Expected OPTalk start response/);
  });

  test('OPTalk audio response throws for wrong message type', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(100, 0);
    const header = Buffer.alloc(8);
    header.writeUInt16LE(MSG_OPTALK_START_RESPONSE, 0); // Wrong type
    header.writeUInt16LE(12345, 2);
    header.writeUInt32LE(4, 4);
    const response = Buffer.concat([header, payload]);
    
    assert.throws(() => parseOptalkAudioResponse(response), /Expected OPTalk audio response/);
  });

  test('OPTalk claim response throws for short payload', () => {
    const payload = Buffer.alloc(2); // Too short
    const header = Buffer.alloc(8);
    header.writeUInt16LE(MSG_OPTALK_CLAIM_RESPONSE, 0);
    header.writeUInt16LE(12345, 2);
    header.writeUInt32LE(2, 4);
    const response = Buffer.concat([header, payload]);
    
    assert.throws(() => parseOptalkClaimResponse(response), /payload too short/);
  });

  test('OPTalk claim response handles failure (Ret != 100)', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(1, 0); // Ret = 1 (failure)
    const header = Buffer.alloc(8);
    header.writeUInt16LE(MSG_OPTALK_CLAIM_RESPONSE, 0);
    header.writeUInt16LE(12345, 2);
    header.writeUInt32LE(4, 4);
    const response = Buffer.concat([header, payload]);
    
    const parsed = parseOptalkClaimResponse(response);
    assert.equal(parsed.Ret, 1);
    assert.equal(parsed.success, false);
  });
});

describe('Xiongmai DVRIP — G.711 A-law framing', () => {
  test('builds G.711 A-law frame from PCM data', () => {
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

  test('G.711 frame size matches input (16-bit PCM to 8-bit A-law)', () => {
    const pcmData = Buffer.alloc(640); // 320 samples of 16-bit PCM
    const alawFrame = buildG711AlawFrame(pcmData);
    assert.equal(alawFrame.length, 320); // 320 bytes of 8-bit A-law
  });

  test('G.711 A-law encoding is deterministic', () => {
    const result1 = linearToAlaw(1000);
    const result2 = linearToAlaw(1000);
    assert.equal(result1, result2);
  });

  test('G.711 A-law encoding handles symmetric values', () => {
    const pos = linearToAlaw(1000);
    const neg = linearToAlaw(-1000);
    // A-law encoding should be different for positive/negative
    assert.notEqual(pos, neg);
  });

  test('G.711 A-law frame handles 320-byte input (standard frame size)', () => {
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
    assert.equal(MSG_LOGIN, 0x1000);
    assert.equal(MSG_LOGIN_RESPONSE, 0x1001);
    assert.equal(MSG_KEEPALIVE, 0x1006);
    assert.equal(MSG_KEEPALIVE_RESPONSE, 0x1007);
    assert.equal(MSG_OPTALK_CLAIM, 0x1434);
    assert.equal(MSG_OPTALK_CLAIM_RESPONSE, 0x1435);
    assert.equal(MSG_OPTALK_START, 0x1430);
    assert.equal(MSG_OPTALK_START_RESPONSE, 0x1431);
    assert.equal(MSG_OPTALK_AUDIO, 0x1432);
    assert.equal(MSG_OPTALK_AUDIO_RESPONSE, 0x1433);
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
    // This test ensures the hash function doesn't log sensitive data
    const originalLog = console.log;
    let loggedData = '';
    console.log = (...args) => { loggedData += args.join(' '); };
    
    try {
      generateSofiaHash('secret_user', 'secret_password', 'secret_challenge');
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
    const payload = msg.slice(8);
    const hash = payload.toString('hex');
    assert.ok(!hash.includes('my_password'));
    assert.equal(payload.length, 32); // 32-byte payload
    assert.equal(hash.length, 64); // 32 bytes = 64 hex characters
  });

  test('different passwords produce different hashes (no collision in basic test)', () => {
    const hash1 = generateSofiaHash('admin', 'password1', '');
    const hash2 = generateSofiaHash('admin', 'password2', '');
    assert.notEqual(hash1, hash2);
  });
});

describe('Xiongmai DVRIP — error handling', () => {
  test('parseLoginResponse handles malformed data gracefully', () => {
    const shortData = Buffer.alloc(4); // Too short for header
    assert.throws(() => parseLoginResponse(shortData), /too short/);
  });

  test('parseDvripHeader throws on invalid data', () => {
    const shortData = Buffer.alloc(4); // Too short for header
    assert.throws(() => parseDvripHeader(shortData), /too short/);
  });

  test('buildDvripHeader handles large payload', () => {
    const largePayload = Buffer.alloc(100000);
    const msg = buildDvripHeader(MSG_LOGIN, 12345, largePayload);
    assert.equal(msg.readUInt32LE(4), 100000);
    assert.equal(msg.length, 8 + 100000);
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
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(100, 0);
    const header = Buffer.alloc(8);
    header.writeUInt16LE(MSG_KEEPALIVE, 0); // Wrong type
    header.writeUInt16LE(12345, 2);
    header.writeUInt32LE(4, 4);
    const response = Buffer.concat([header, payload]);
    
    assert.throws(() => parseLoginResponse(response), /Expected login response/);
  });

  test('parseLoginResponse handles login failure (Ret != 100)', () => {
    const payload = Buffer.alloc(4);
    payload.writeUInt32LE(1, 0); // Ret = 1 (failure)
    const header = Buffer.alloc(8);
    header.writeUInt16LE(MSG_LOGIN_RESPONSE, 0);
    header.writeUInt16LE(12345, 2);
    header.writeUInt32LE(4, 4);
    const response = Buffer.concat([header, payload]);
    
    const parsed = parseLoginResponse(response);
    assert.equal(parsed.Ret, 1);
    assert.equal(parsed.success, false);
  });

  test('parseLoginResponse handles missing AliveInterval', () => {
    const payload = Buffer.alloc(4); // Only Ret, no AliveInterval
    payload.writeUInt32LE(100, 0);
    const header = Buffer.alloc(8);
    header.writeUInt16LE(MSG_LOGIN_RESPONSE, 0);
    header.writeUInt16LE(12345, 2);
    header.writeUInt32LE(4, 4);
    const response = Buffer.concat([header, payload]);
    
    const parsed = parseLoginResponse(response);
    assert.equal(parsed.AliveInterval, 30); // Default value
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
