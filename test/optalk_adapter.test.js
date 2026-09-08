#!/usr/bin/env node
'use strict';

/**
 * Focused tests for OptalkAudioAdapter
 * Tests OPTalk protocol sequence: Login → Claim → Start → Audio → Stop
 */

const { 
  OptalkAudioAdapter,
  buildJsonFrame,
  buildBinaryFrame,
  pcmToAlaw,
  MSG_OPTALK_START,
  MSG_OPTALK_CLAIM,
  MSG_OPTALK_AUDIO
} = require('../lib/_optalk_audio');

const CAMERA_IP = '192.168.1.3';
const CAMERA_PORT = 34567;
const PASSWORD = 'd23061988';

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    console.log(`  ✅ ${message}`);
    passed++;
  } else {
    console.log(`  ❌ ${message}`);
    failed++;
  }
}

// ============================================================
// TEST 1: Payload structure verification
// ============================================================
async function testPayloadStructure() {
  console.log('\n=== TEST 1: OPTalk Start Payload Structure ===');
  
  const sessionId = 12345;
  
  // Build the Start message
  const startPayload = {
    Name: 'OPTalk',
    OPTalk: {
      Action: 'Start',
      Parameter: {
        Channel: 0,
        TransMode: 'TCP'
      }
    }
  };
  
  const msg = buildJsonFrame(MSG_OPTALK_START, startPayload, sessionId);
  
  // Parse the payload
  const msgLen = msg.readUInt32LE(16);
  const payloadStr = msg.subarray(20, 20 + msgLen - 2).toString('utf8');
  let payload;
  try {
    payload = JSON.parse(payloadStr);
  } catch (e) {
    payload = null;
  }
  
  // Verify structure
  assert(payload !== null, 'Payload is valid JSON');
  assert(payload.Name === 'OPTalk', `Name = 'OPTalk' (got: ${payload?.Name})`);
  assert(payload.OPTalk !== undefined, 'OPTalk object exists');
  assert(payload.OPTalk.Action === 'Start', `OPTalk.Action = 'Start' (got: ${payload?.OPTalk?.Action})`);
  assert(payload.OPTalk.Parameter !== undefined, 'OPTalk.Parameter exists');
  assert(payload.OPTalk.Parameter.Channel === 0, `Channel = 0 (got: ${payload?.OPTalk?.Parameter?.Channel})`);
  assert(payload.OPTalk.Parameter.TransMode === 'TCP', `TransMode = 'TCP' (got: ${payload?.OPTalk?.Parameter?.TransMode})`);
  
  // Verify header
  const headerSessionId = msg.readUInt32LE(4);
  const headerMsgId = msg.readUInt16LE(14);
  
  assert(headerSessionId === sessionId, `SessionID in header = ${sessionId} (got: ${headerSessionId})`);
  assert(headerMsgId === MSG_OPTALK_START, `MsgID = ${MSG_OPTALK_START} (got: ${headerMsgId})`);
  
  console.log(`\n  Payload: ${JSON.stringify(payload, null, 2).replace(/\n/g, '\n  ')}`);
}

// ============================================================
// TEST 2: SessionID in DVRIP header
// ============================================================
async function testSessionIdInHeader() {
  console.log('\n=== TEST 2: SessionID in DVRIP Header ===');
  
  const sessionIds = [0, 1, 100, 12345, 65535, 100000, 13917];
  
  for (const sessionId of sessionIds) {
    const msg = buildJsonFrame(MSG_OPTALK_START, {Name: 'OPTalk'}, sessionId);
    const headerSessionId = msg.readUInt32LE(4);
    assert(headerSessionId === sessionId, `SessionID ${sessionId} correctly in header (got: ${headerSessionId})`);
  }
}

// ============================================================
// TEST 3: Audio frame format
// ============================================================
async function testAudioFrameFormat() {
  console.log('\n=== TEST 3: G.711 A-law Audio Frame Format ===');
  
  // Generate test PCM data (320 samples = 40ms at 8kHz)
  const pcmBuffer = Buffer.alloc(640); // 320 samples * 2 bytes
  for (let i = 0; i < 320; i++) {
    const sample = Math.round(16000 * Math.sin(2 * Math.PI * 440 * i / 8000));
    pcmBuffer.writeInt16LE(sample, i * 2);
  }
  
  // Convert to A-law
  const alawBuffer = pcmToAlaw(pcmBuffer);
  
  // Verify
  assert(alawBuffer.length === 320, `A-law buffer size = 320 (got: ${alawBuffer.length})`);
  assert(alawBuffer.length === pcmBuffer.length / 2, 'A-law is half the size of PCM');
  
  // Build audio message
  const sessionId = 13917;
  const audioMsg = buildBinaryFrame(MSG_OPTALK_AUDIO, sessionId, alawBuffer);
  
  const headerMsgId = audioMsg.readUInt16LE(14);
  const headerSessionId = audioMsg.readUInt32LE(4);
  const headerDataLen = audioMsg.readUInt32LE(16);
  
  assert(headerMsgId === MSG_OPTALK_AUDIO, `Audio MsgID = ${MSG_OPTALK_AUDIO} (got: ${headerMsgId})`);
  assert(headerSessionId === sessionId, `Audio SessionID = ${sessionId} (got: ${headerSessionId})`);
  assert(headerDataLen === 320, `Audio data length = 320 (got: ${headerDataLen})`);
  assert(audioMsg.length === 20 + 320, `Total message length = 340 (got: ${audioMsg.length})`);
  
  console.log(`\n  PCM: ${pcmBuffer.length} bytes`);
  console.log(`  A-law: ${alawBuffer.length} bytes`);
  console.log(`  Total DVRIP packet: ${audioMsg.length} bytes`);
}

// ============================================================
// TEST 4: Login → Claim → Start (hardware test)
// ============================================================
async function testHardwareSequence() {
  console.log('\n=== TEST 4: Login → Claim → Start (Hardware) ===');
  
  const adapter = new OptalkAudioAdapter(CAMERA_IP, CAMERA_PORT);
  
  try {
    // Step 1: Login
    console.log('  Step 1: Login...');
    await adapter.login('admin', PASSWORD);
    
    assert(adapter.isAuthenticated === true, 'Login successful');
    assert(adapter.sessionId > 0, `SessionID > 0 (got: ${adapter.sessionId})`);
    console.log(`  SessionID: ${adapter.sessionId}`);
    
    // Step 2: Claim
    console.log('  Step 2: Claim...');
    try {
      await adapter.claimTalk();
      console.log('  ✅ Claim successful (Ret=100)');
    } catch (err) {
      if (err.message.includes('Ret=103')) {
        console.log('  ⚠️  Claim returned Ret=103 (already claimed or channel busy)');
        // Ret=103 might mean "already claimed" - let's try Start anyway
        console.log('  Attempting Start anyway...');
      } else {
        throw err;
      }
    }
    
    // Step 3: Start
    console.log('  Step 3: Start...');
    await adapter.startTalk();
    
    assert(adapter.isTalkActive === true, 'Talk session is active');
    console.log('  ✅ Full sequence: Login → Claim → Start = SUCCESS');
    
    // Send test audio
    console.log('  Sending test audio frame...');
    const pcmBuffer = Buffer.alloc(640);
    pcmBuffer.fill(0); // silence
    await adapter.sendAudio(pcmBuffer);
    console.log('  ✅ Audio sent successfully');
    
    // Stop
    await adapter.stopTalk();
    assert(adapter.isTalkActive === false, 'Talk session stopped');
    console.log('  ✅ Stop sequence executed');
    
  } catch (err) {
    console.log(`  ❌ Error: ${err.message}`);
    failed++;
  } finally {
    adapter.close();
  }
}

// ============================================================
// TEST 5: Message ID verification
// ============================================================
async function testMessageIds() {
  console.log('\n=== TEST 5: DVRIP Message IDs ===');
  
  assert(MSG_OPTALK_CLAIM === 1434, `MSG_OPTALK_CLAIM = 1434 (got: ${MSG_OPTALK_CLAIM})`);
  assert(MSG_OPTALK_START === 1430, `MSG_OPTALK_START = 1430 (got: ${MSG_OPTALK_START})`);
  assert(MSG_OPTALK_AUDIO === 1432, `MSG_OPTALK_AUDIO = 1432 (got: ${MSG_OPTALK_AUDIO})`);
}

// ============================================================
// TEST 6: sendAudio backpressure + error handling (unit)
// ============================================================
async function testSendAudioBackpressure() {
  console.log('\n=== TEST 6: sendAudio backpressure + error handling ===');

  const { OptalkAudioAdapter } = require('../lib/_optalk_audio');
  const adapter = new OptalkAudioAdapter('1.2.3.4', 34567);

  adapter.isAuthenticated = true;
  adapter.isTalkActive = true;
  adapter.sessionId = 12345;

  const pcmBuffer = Buffer.alloc(640);
  pcmBuffer.fill(0);

  // Test 6a: write() returns false → await 'drain' → resolves
  {
    let resolveDrain = null;
    const mockSocket = {
      destroyed: false,
      write: () => false,
      once: (event, fn) => {
        if (event === 'drain') resolveDrain = fn;
      },
      removeListener: () => {},
    };

    adapter.socket = mockSocket;

    const sendPromise = adapter.sendAudio(pcmBuffer);
    await new Promise(r => setTimeout(r, 20));

    assert(resolveDrain !== null, 'registered drain listener when write() returns false');

    resolveDrain();
    await sendPromise;
    assert(true, 'sendAudio resolves after drain event');
  }

  // Test 6b: write() returns false → 'error' → rejects with Error
  {
    let errorHandler = null;
    const mockSocket = {
      destroyed: false,
      write: () => false,
      once: (event, fn) => {
        if (event === 'error') errorHandler = fn;
      },
      removeListener: () => {},
    };

    adapter.socket = mockSocket;

    let rejected = false;
    let errorMsg = '';
    const sendPromise = adapter.sendAudio(pcmBuffer).catch(err => {
      rejected = true;
      errorMsg = err.message;
    });

    await new Promise(r => setTimeout(r, 20));
    assert(errorHandler !== null, 'registered error listener when write() returns false');

    errorHandler(new Error('EPIPE'));
    await sendPromise;

    assert(rejected, 'sendAudio rejects on socket error');
    assert(errorMsg.includes('Socket error'), `Error message mentions socket error (got: ${errorMsg})`);
  }

  console.log('  ✅ Backpressure waits for drain');
  console.log('  ✅ Socket error is propagated to caller');
}

// ============================================================
// MAIN
// ============================================================
async function main() {
  console.log('='.repeat(60));
  console.log('OPTALK TWO-WAY AUDIO - FOCUSED TESTS');
  console.log('='.repeat(60));
  console.log(`Camera: ${CAMERA_IP}:${CAMERA_PORT}`);
  console.log('');
  
  await testMessageIds();
  await testPayloadStructure();
  await testSessionIdInHeader();
  await testAudioFrameFormat();
  await testSendAudioBackpressure();
  await testHardwareSequence();
  
  console.log('\n' + '='.repeat(60));
  console.log('TEST SUMMARY');
  console.log('='.repeat(60));
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed}`);
  console.log(`Total:  ${passed + failed}`);
  
  if (failed === 0) {
    console.log('\n🎉 ALL TESTS PASSED');
  } else {
    console.log('\n❌ SOME TESTS FAILED');
    process.exit(1);
  }
}

main().catch(console.error);
