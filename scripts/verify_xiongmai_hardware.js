#!/usr/bin/env node
'use strict';

/**
 * READ-ONLY Hardware Authentication Verification
 * 
 * This script performs a read-only authentication test against a real
 * Xiongmai DVRIP camera at 192.168.1.11:34567.
 * 
 * WHAT IT DOES:
 * - Connects to camera via TCP on port 34567
 * - Authenticates using DVRIP protocol with Sofia hash
 * - Verifies login response (Ret=100, SessionID, AliveInterval)
 * - Optionally verifies keepalive
 * - Closes connection cleanly
 * 
 * WHAT IT DOES NOT DO:
 * - Does NOT send OPTalk audio
 * - Does NOT modify camera settings
 * - Does NOT modify database
 * - Does NOT write any data to camera
 * 
 * Usage: node scripts/verify_xiongmai_hardware.js [username] [password]
 */

const net = require('net');
const crypto = require('crypto');

// DVRIP constants
const DVRIP_PORT = 34567;
const DVRIP_TIMEOUT_MS = 8000;
const SOFIA_MAGIC = 'Sofia';
const MSG_LOGIN = 0x1000;
const MSG_LOGIN_RESPONSE = 0x1001;
const MSG_KEEPALIVE = 0x1006;
const MSG_KEEPALIVE_RESPONSE = 0x1007;

// Get credentials from command line or use defaults
const username = process.argv[2] || 'admin';
const password = process.argv[3] || 'admin';

console.log('='.repeat(60));
console.log('XIONGMAI DVRIP READ-ONLY AUTHENTICATION VERIFICATION');
console.log('='.repeat(60));
console.log(`Target: 192.168.1.11:${DVRIP_PORT}`);
console.log(`Username: ${username}`);
console.log(`Password: ${'*'.repeat(password.length)}`);
console.log('='.repeat(60));

function generateSofiaHash(username, password, challenge = '') {
  const combined = `${username}${password}${challenge}${SOFIA_MAGIC}`;
  return crypto.createHash('md5').update(combined).digest('hex');
}

function buildDvripHeader(msgType, sessionId, payload) {
  const header = Buffer.alloc(8);
  header.writeUInt16LE(msgType, 0);
  header.writeUInt16LE(sessionId, 2);
  header.writeUInt32LE(payload.length, 4);
  return Buffer.concat([header, payload]);
}

function buildLoginMessage(username, password) {
  const hash = generateSofiaHash(username, password);
  const payload = Buffer.alloc(32);
  Buffer.from(hash, 'hex').copy(payload, 0);
  return buildDvripHeader(MSG_LOGIN, 0, payload);
}

function buildKeepaliveMessage(sessionId) {
  const payload = Buffer.alloc(0);
  return buildDvripHeader(MSG_KEEPALIVE, sessionId, payload);
}

function parseLoginResponse(data) {
  if (data.length < 8) {
    throw new Error('Response too short for header');
  }
  
  const msgType = data.readUInt16LE(0);
  const sessionId = data.readUInt16LE(2);
  const payloadLength = data.readUInt32LE(4);
  
  if (msgType !== MSG_LOGIN_RESPONSE) {
    throw new Error(`Expected login response (0x${MSG_LOGIN_RESPONSE.toString(16)}), got 0x${msgType.toString(16)}`);
  }
  
  if (data.length < 8 + payloadLength) {
    throw new Error('Response too short for payload');
  }
  
  const payload = data.slice(8, 8 + payloadLength);
  const Ret = payload.readUInt32LE(0);
  const AliveInterval = payload.length >= 8 ? payload.readUInt32LE(4) : 30;
  const SessionId = sessionId;
  
  return {
    Ret,
    AliveInterval,
    SessionId,
    success: Ret === 100
  };
}

function parseKeepaliveResponse(data) {
  if (data.length < 8) {
    throw new Error('Response too short for header');
  }
  
  const msgType = data.readUInt16LE(0);
  
  if (msgType !== MSG_KEEPALIVE_RESPONSE) {
    throw new Error(`Expected keepalive response (0x${MSG_KEEPALIVE_RESPONSE.toString(16)}), got 0x${msgType.toString(16)}`);
  }
  
  return { success: true };
}

async function verifyHardware() {
  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    socket.setTimeout(DVRIP_TIMEOUT_MS);
    
    let responseData = Buffer.alloc(0);
    let loginResult = null;
    let keepaliveResult = null;
    
    socket.on('connect', () => {
      console.log('✓ Connected to camera');
      
      // Send login message
      const loginMsg = buildLoginMessage(username, password);
      console.log('✓ Sending login message...');
      socket.write(loginMsg);
    });
    
    socket.on('data', (data) => {
      responseData = Buffer.concat([responseData, data]);
      
      try {
        if (!loginResult) {
          // Parse login response
          loginResult = parseLoginResponse(responseData);
          console.log('✓ Login response received');
          console.log(`  - Ret: ${loginResult.Ret} ${loginResult.Ret === 100 ? '(SUCCESS)' : '(FAILURE)'}`);
          console.log(`  - SessionID: ${loginResult.SessionId}`);
          console.log(`  - AliveInterval: ${loginResult.AliveInterval}s`);
          
          if (loginResult.success) {
            console.log('✓ Authentication successful');
            
            // Send keepalive to verify session
            responseData = Buffer.alloc(0);
            const keepaliveMsg = buildKeepaliveMessage(loginResult.SessionId);
            console.log('✓ Sending keepalive message...');
            socket.write(keepaliveMsg);
          } else {
            console.log('✗ Authentication failed');
            socket.destroy();
            resolve({ success: false, loginResult, keepaliveResult: null });
          }
        } else if (!keepaliveResult) {
          // Parse keepalive response
          keepaliveResult = parseKeepaliveResponse(responseData);
          console.log('✓ Keepalive response received');
          console.log('✓ Session verified');
          
          socket.destroy();
          resolve({ success: true, loginResult, keepaliveResult });
        }
      } catch (err) {
        // Need more data or error
        if (!err.message.includes('too short')) {
          console.log(`✗ Error parsing response: ${err.message}`);
          socket.destroy();
          resolve({ success: false, error: err.message, loginResult, keepaliveResult });
        }
      }
    });
    
    socket.on('error', (err) => {
      console.log(`✗ Connection error: ${err.message}`);
      resolve({ success: false, error: err.message, loginResult, keepaliveResult });
    });
    
    socket.on('timeout', () => {
      console.log('✗ Connection timeout');
      socket.destroy();
      resolve({ success: false, error: 'timeout', loginResult, keepaliveResult });
    });
    
    socket.on('close', () => {
      console.log('✓ Connection closed');
    });
    
    socket.connect(DVRIP_PORT, '192.168.1.11');
  });
}

async function main() {
  try {
    const result = await verifyHardware();
    
    console.log('='.repeat(60));
    console.log('VERIFICATION RESULTS');
    console.log('='.repeat(60));
    
    if (result.success) {
      console.log('✓ READ-ONLY AUTHENTICATION VERIFICATION: PASSED');
      console.log('');
      console.log('VERIFIED:');
      console.log(`  - Ret=${result.loginResult.Ret} (expected 100)`);
      console.log(`  - SessionID=${result.loginResult.SessionId} (exists)`);
      console.log(`  - AliveInterval=${result.loginResult.AliveInterval}s (exists)`);
      console.log(`  - Keepalive=${result.keepaliveResult ? 'OK' : 'N/A'}`);
      console.log('');
      console.log('CONFIRMATION:');
      console.log('  ✓ No audio was sent');
      console.log('  ✓ No camera modifications made');
      console.log('  ✓ No database modifications made');
      console.log('  ✓ Read-only authentication only');
    } else {
      console.log('✗ READ-ONLY AUTHENTICATION VERIFICATION: FAILED');
      console.log('');
      console.log('ERROR:', result.error || 'Unknown error');
      if (result.loginResult) {
        console.log(`  - Ret=${result.loginResult.Ret} (expected 100)`);
      }
    }
    
    console.log('='.repeat(60));
    
    process.exit(result.success ? 0 : 1);
  } catch (err) {
    console.log('✗ Unexpected error:', err.message);
    process.exit(1);
  }
}

main();
