#!/usr/bin/env node
'use strict';

/**
 * HARDWARE E2E TEST — OPTalk Two-Way Audio
 * 
 * Tests the Xiongmai DVRIP adapter with real hardware 192.168.1.11:34567
 * 
 * TEST SEQUENCE:
 * 1. Authenticate (msg 1000/1001)
 * 2. Keepalive (msg 1006/1007)
 * 3. OPTalk Claim (msg 1434/1435)
 * 4. OPTalk Start (msg 1430/1431)
 * 5. Send deterministic test audio (msg 1432/1433)
 * 6. OPTalk Stop (msg 1430/1431)
 * 7. Cleanup
 * 
 * SAFETY:
 * - No microphone input
 * - Deterministic 1-2 second test signal
 * - No recording
 * - No secrets in logs
 * - Immediate cleanup on any failure
 */

const net = require('net');
const crypto = require('crypto');

// DVRIP constants (V5.00 protocol - proven to work with this camera)
const DVRIP_PORT = 34567;
const DVRIP_TIMEOUT_MS = 5000;
const REQUEST_TYPE = 0x00; // V5.00 request type
const MSG_LOGIN = 1000; // V5.00 uses decimal 1000
const MSG_LOGIN_RESPONSE = 1001;
const MSG_KEEPALIVE = 1006;
const MSG_KEEPALIVE_RESPONSE = 1007;
const MSG_OPTALK_CLAIM = 1434;
const MSG_OPTALK_CLAIM_RESPONSE = 1435;
const MSG_OPTALK_START = 1430;
const MSG_OPTALK_START_RESPONSE = 1431;
const MSG_OPTALK_AUDIO = 1432;
const MSG_OPTALK_AUDIO_RESPONSE = 1433;

// Test configuration
const CAMERA_IP = '192.168.1.11';
const TEST_DURATION_MS = 2000; // 2 seconds max
const FRAME_SIZE_MS = 40; // 40ms per frame (8 kHz, 320 bytes)
const SAMPLE_RATE = 8000; // 8 kHz
const BYTES_PER_FRAME = 320; // G.711 A-law frame size

// Get credentials from environment
const USERNAME = process.env.CAM_USER || 'admin';
const PASSWORD = process.env.CAM_PASS || '';

console.log('='.repeat(70));
console.log('HARDWARE E2E TEST — OPTalk Two-Way Audio');
console.log('='.repeat(70));
console.log(`Target: ${CAMERA_IP}:${DVRIP_PORT}`);
console.log(`Username: ${USERNAME}`);
console.log(`Password: ${'*'.repeat(PASSWORD.length)}`);
console.log(`Test duration: ${TEST_DURATION_MS}ms`);
console.log(`Frame size: ${BYTES_PER_FRAME} bytes (${FRAME_SIZE_MS}ms)`);
console.log('='.repeat(70));

// Sofia hash (V5.00 base62 encoding - proven to work with this camera)
function sofiaHash(password) {
  const md5 = crypto.createHash('md5').update(password, 'utf8').digest();
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[(md5[2 * i] + md5[2 * i + 1]) % 62];
  return out;
}

// DVRIP V5.00 frame builder (20-byte header + JSON + \n\0)
function buildFrame(msgId, jsonObj) {
  const body = Buffer.from(JSON.stringify(jsonObj), 'utf8');
  const h = Buffer.alloc(20);
  h[0] = 0xFF;
  h[1] = REQUEST_TYPE; // 0x00 = V5.00 request
  h.writeUInt32LE(0, 4); // session = 0 (login)
  h.writeUInt32LE(0, 8); // sequence = 0
  h.writeUInt16LE(msgId, 14);
  h.writeUInt32LE(body.length + 2, 16); // + \n \0
  return Buffer.concat([h, body, Buffer.from([0x0A, 0x00])]);
}

// Login message builder (V5.00 JSON protocol)
function buildLoginMessage(username, password) {
  const jsonObj = {
    EncryptType: 'MD5',
    LoginType: 'DVRIP-Web',
    PassWord: sofiaHash(password),
    UserName: username,
  };
  return buildFrame(MSG_LOGIN, jsonObj);
}

// Keepalive message builder (V5.00 protocol)
function buildKeepaliveMessage(sessionId) {
  return buildFrame(MSG_KEEPALIVE, {});
}

// OPTalk claim message builder (V5.00 protocol)
function buildOptalkClaimMessage(sessionId) {
  return buildFrame(MSG_OPTALK_CLAIM, {});
}

// OPTalk start message builder (V5.00 protocol)
function buildOptalkStartMessage(sessionId) {
  return buildFrame(MSG_OPTALK_START, {});
}

// OPTalk audio message builder (V5.00 protocol)
function buildOptalkAudioMessage(sessionId, audioData) {
  // For audio messages, we send binary data instead of JSON, no terminator
  const h = Buffer.alloc(20);
  h[0] = 0xFF;
  h[1] = REQUEST_TYPE;
  h.writeUInt32LE(sessionId, 4); // session ID
  h.writeUInt32LE(0, 8); // sequence = 0
  h.writeUInt16LE(MSG_OPTALK_AUDIO, 14);
  h.writeUInt32LE(audioData.length, 16); // no terminator for audio
  return Buffer.concat([h, audioData]);
}

// G.711 A-law linear to A-law conversion (matching committed adapter)
function linearToAlaw(sample) {
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32768;
  
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) {
    sample = -sample;
  }
  
  let exp = 0;
  let mag = sample;
  
  if (mag > 0) {
    while (mag > 15 && exp < 7) {
      mag >>= 1;
      exp++;
    }
  }
  
  const mantissa = mag & 0x0F;
  const compressed = ((exp << 4) | mantissa) ^ 0x55;
  
  return (sign === 0) ? (compressed | 0x80) : compressed;
}

// G.711 A-law frame builder (matching committed adapter)
function buildG711AlawFrame(pcmData) {
  const alawData = Buffer.alloc(pcmData.length / 2);
  for (let i = 0; i < pcmData.length; i += 2) {
    const sample = pcmData.readInt16LE(i);
    alawData[i / 2] = linearToAlaw(sample);
  }
  return alawData;
}

// Generate deterministic test signal (1 kHz sine wave, 2 seconds)
function generateTestSignal(durationMs) {
  const samplesPerFrame = SAMPLE_RATE * (FRAME_SIZE_MS / 1000);
  const totalFrames = Math.ceil(durationMs / FRAME_SIZE_MS);
  const frames = [];
  
  for (let frame = 0; frame < totalFrames; frame++) {
    const pcmData = Buffer.alloc(samplesPerFrame * 2); // 16-bit samples
    
    for (let i = 0; i < samplesPerFrame; i++) {
      const t = (frame * FRAME_SIZE_MS + i * (1000 / SAMPLE_RATE)) / 1000;
      // 1 kHz sine wave at 50% amplitude
      const sample = Math.floor(16384 * Math.sin(2 * Math.PI * 1000 * t));
      pcmData.writeInt16LE(sample, i * 2);
    }
    
    const alawData = buildG711AlawFrame(pcmData);
    frames.push(alawData);
  }
  
  return frames;
}

// Response parser (V5.00 protocol - 20-byte header + JSON)
function parseResponse(data, expectedMsgType) {
  if (data.length < 20) {
    throw new Error('Response too short for V5.00 header');
  }
  
  const msgId = data.readUInt16LE(14);
  const len = data.readUInt32LE(16);
  
  if (msgId !== expectedMsgType) {
    throw new Error(`Expected msg ${expectedMsgType}, got ${msgId}`);
  }
  
  if (data.length < 20 + len) {
    throw new Error('Response too short for payload');
  }
  
  const body = data.subarray(20, 20 + Math.min(len, data.length - 20)).toString('utf8');
  let ret = '?', session = 0;
  try {
    const j = JSON.parse(body.replace(/\n\x00*$/, ''));
    ret = j.Ret;
    // Parse SessionID from hex string like "0x00000001"
    if (j.SessionID) {
      session = parseInt(j.SessionID, 16);
    }
  } catch (err) {
    // If JSON parsing fails, try to parse as binary Ret value
    if (data.length >= 24) {
      ret = data.readUInt32LE(20);
    }
  }
  
  return { Ret: ret, sessionId: session, success: ret === 100 };
}

// Main test function
async function runTest() {
  const socket = new net.Socket();
  socket.setTimeout(DVRIP_TIMEOUT_MS);
  
  let sessionId = 0;
  let responseData = Buffer.alloc(0);
  let testResults = {
    authenticate: null,
    keepalive: null,
    optalkClaim: null,
    optalkStart: null,
    audioSent: 0,
    optalkStop: null
  };
  
  return new Promise((resolve) => {
    socket.on('connect', () => {
      console.log('✓ STEP 1: Connected to camera');
      
      // Authenticate
      console.log('→ STEP 2: Sending login (msg 1000)...');
      const loginMsg = buildLoginMessage(USERNAME, PASSWORD);
      socket.write(loginMsg);
    });
    
    socket.on('data', (data) => {
      responseData = Buffer.concat([responseData, data]);
      
      try {
        if (!testResults.authenticate) {
          // Parse login response
          const result = parseResponse(responseData, MSG_LOGIN_RESPONSE);
          testResults.authenticate = result;
          sessionId = result.sessionId;
          
          console.log(`✓ Login response (msg 1001): Ret=${result.Ret} ${result.success ? '(SUCCESS)' : '(FAILURE)'}`);
          console.log(`  SessionID: ${sessionId}`);
          
          if (!result.success) {
            console.log('✗ Authentication failed, stopping test');
            socket.destroy();
            resolve({ success: false, testResults, step: 'authenticate' });
            return;
          }
          
          responseData = Buffer.alloc(0);
          
          // Send keepalive
          console.log('→ STEP 3: Sending keepalive (msg 1006)...');
          const keepaliveMsg = buildKeepaliveMessage(sessionId);
          socket.write(keepaliveMsg);
          
        } else if (!testResults.keepalive) {
          // Parse keepalive response
          const result = parseResponse(responseData, MSG_KEEPALIVE_RESPONSE);
          testResults.keepalive = result;
          
          console.log(`✓ Keepalive response (msg 1007): Ret=${result.Ret} ${result.success ? '(SUCCESS)' : '(FAILURE)'}`);
          
          if (!result.success) {
            console.log('✗ Keepalive failed, stopping test');
            socket.destroy();
            resolve({ success: false, testResults, step: 'keepalive' });
            return;
          }
          
          responseData = Buffer.alloc(0);
          
          // OPTalk Claim
          console.log('→ STEP 4: OPTalk Claim (msg 1434)...');
          const claimMsg = buildOptalkClaimMessage(sessionId);
          socket.write(claimMsg);
          
        } else if (!testResults.optalkClaim) {
          // Parse OPTalk claim response
          const result = parseResponse(responseData, MSG_OPTALK_CLAIM_RESPONSE);
          testResults.optalkClaim = result;
          
          console.log(`✓ OPTalk Claim response (msg 1435): Ret=${result.Ret} ${result.success ? '(SUCCESS)' : '(FAILURE)'}`);
          
          if (!result.success) {
            console.log('✗ OPTalk Claim failed, stopping test');
            socket.destroy();
            resolve({ success: false, testResults, step: 'optalkClaim' });
            return;
          }
          
          responseData = Buffer.alloc(0);
          
          // OPTalk Start
          console.log('→ STEP 5: OPTalk Start (msg 1430)...');
          const startMsg = buildOptalkStartMessage(sessionId);
          socket.write(startMsg);
          
        } else if (!testResults.optalkStart) {
          // Parse OPTalk start response
          const result = parseResponse(responseData, MSG_OPTALK_START_RESPONSE);
          testResults.optalkStart = result;
          
          console.log(`✓ OPTalk Start response (msg 1431): Ret=${result.Ret} ${result.success ? '(SUCCESS)' : '(FAILURE)'}`);
          
          if (!result.success) {
            console.log('✗ OPTalk Start failed, stopping test');
            socket.destroy();
            resolve({ success: false, testResults, step: 'optalkStart' });
            return;
          }
          
          responseData = Buffer.alloc(0);
          
          // Send audio frames
          console.log('→ STEP 6: Sending test audio (msg 1432)...');
          const audioFrames = generateTestSignal(TEST_DURATION_MS);
          console.log(`  Generated ${audioFrames.length} frames (${TEST_DURATION_MS}ms)`);
          
          let frameIndex = 0;
          const sendNextFrame = () => {
            if (frameIndex >= audioFrames.length) {
              // All frames sent, stop OPTalk
              console.log(`✓ Sent ${testResults.audioSent} audio frames`);
              responseData = Buffer.alloc(0);
              
              console.log('→ STEP 7: OPTalk Stop (msg 1430)...');
              const stopMsg = buildOptalkStartMessage(sessionId);
              socket.write(stopMsg);
              return;
            }
            
            const audioMsg = buildOptalkAudioMessage(sessionId, audioFrames[frameIndex]);
            socket.write(audioMsg);
            testResults.audioSent++;
            frameIndex++;
            
            setTimeout(sendNextFrame, FRAME_SIZE_MS);
          };
          
          sendNextFrame();
          
        } else if (!testResults.optalkStop) {
          // Parse OPTalk stop response
          const result = parseResponse(responseData, MSG_OPTALK_START_RESPONSE);
          testResults.optalkStop = result;
          
          console.log(`✓ OPTalk Stop response (msg 1431): Ret=${result.Ret} ${result.success ? '(SUCCESS)' : '(FAILURE)'}`);
          
          // Test complete
          socket.destroy();
          resolve({ success: result.success, testResults, step: 'complete' });
          
        } else {
          // Audio responses (optional, not critical)
          responseData = Buffer.alloc(0);
        }
        
      } catch (err) {
        console.log(`✗ Error: ${err.message}`);
        socket.destroy();
        resolve({ success: false, testResults, step: 'error', error: err.message });
      }
    });
    
    socket.on('error', (err) => {
      console.log(`✗ Socket error: ${err.message}`);
      resolve({ success: false, testResults, step: 'socket_error', error: err.message });
    });
    
    socket.on('timeout', () => {
      console.log('✗ Socket timeout');
      socket.destroy();
      resolve({ success: false, testResults, step: 'timeout' });
    });
    
    socket.connect(DVRIP_PORT, CAMERA_IP);
  });
}

// Run test
async function main() {
  try {
    const result = await runTest();
    
    console.log('='.repeat(70));
    console.log('TEST RESULTS');
    console.log('='.repeat(70));
    
    if (result.success) {
      console.log('✓ HARDWARE E2E TEST: PASS');
      console.log('');
      console.log('Protocol steps:');
      console.log(`  - Authenticate: Ret=${result.testResults.authenticate?.Ret} ✓`);
      console.log(`  - Keepalive: Ret=${result.testResults.keepalive?.Ret} ✓`);
      console.log(`  - OPTalk Claim: Ret=${result.testResults.optalkClaim?.Ret} ✓`);
      console.log(`  - OPTalk Start: Ret=${result.testResults.optalkStart?.Ret} ✓`);
      console.log(`  - Audio frames sent: ${result.testResults.audioSent} ✓`);
      console.log(`  - OPTalk Stop: Ret=${result.testResults.optalkStop?.Ret} ✓`);
      console.log('');
      console.log('✓ Physical speaker on 192.168.1.11 should have output test audio');
      console.log('✓ Test signal: 1 kHz sine wave, 2 seconds duration');
    } else {
      console.log('✗ HARDWARE E2E TEST: FAIL');
      console.log('');
      console.log(`Failed at step: ${result.step}`);
      if (result.error) {
        console.log(`Error: ${result.error}`);
      }
      console.log('');
      console.log('Protocol steps completed:');
      console.log(`  - Authenticate: Ret=${result.testResults.authenticate?.Ret} ${result.testResults.authenticate?.success ? '✓' : '✗'}`);
      console.log(`  - Keepalive: Ret=${result.testResults.keepalive?.Ret} ${result.testResults.keepalive?.success ? '✓' : '✗'}`);
      console.log(`  - OPTalk Claim: Ret=${result.testResults.optalkClaim?.Ret} ${result.testResults.optalkClaim?.success ? '✓' : '✗'}`);
      console.log(`  - OPTalk Start: Ret=${result.testResults.optalkStart?.Ret} ${result.testResults.optalkStart?.success ? '✓' : '✗'}`);
      console.log(`  - Audio frames sent: ${result.testResults.audioSent}`);
      console.log(`  - OPTalk Stop: Ret=${result.testResults.optalkStop?.Ret} ${result.testResults.optalkStop?.success ? '✓' : '✗'}`);
    }
    
    console.log('='.repeat(70));
    process.exit(result.success ? 0 : 1);
    
  } catch (err) {
    console.log('✗ Unexpected error:', err.message);
    process.exit(1);
  }
}

main();
