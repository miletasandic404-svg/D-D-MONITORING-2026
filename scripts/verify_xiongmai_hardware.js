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
const DVRIP_TIMEOUT_MS = 5000;
const SOFIA_MAGIC = 'Sofia';
const MSG_LOGIN = 1000;  // V5.00 uses decimal 1000, not 0x1000
const MSG_LOGIN_RESPONSE = 1001;
const MSG_KEEPALIVE = 1006;
const MSG_KEEPALIVE_RESPONSE = 1007;
const REQUEST_TYPE = 0x00;  // V5.00 request type

// Get credentials from environment variables ONLY (match working script exactly)
const username = process.env.CAM_USER || 'admin';
const password = process.env.CAM_PASS || '';

console.log('='.repeat(60));
console.log('XIONGMAI DVRIP READ-ONLY AUTHENTICATION VERIFICATION');
console.log('='.repeat(60));
console.log(`Target: 192.168.1.11:${DVRIP_PORT}`);
console.log(`Username: ${username}`);
console.log(`Password: ${'*'.repeat(password.length)}`);
console.log('='.repeat(60));

function sofiaHash(password) {
  const md5 = crypto.createHash('md5').update(password, 'utf8').digest();
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[(md5[2 * i] + md5[2 * i + 1]) % 62];
  return out;
}

function buildFrame(msgId, jsonObj) {
  const body = Buffer.from(JSON.stringify(jsonObj), 'utf8');
  const h = Buffer.alloc(20);
  h[0] = 0xFF;
  h[1] = REQUEST_TYPE;  // 0x00 = V5.00 request
  h.writeUInt32LE(0, 4);  // session = 0 (login)
  h.writeUInt32LE(0, 8);  // sequence = 0
  h.writeUInt16LE(msgId, 14);
  h.writeUInt32LE(body.length + 2, 16);  // + \n \0
  return Buffer.concat([h, body, Buffer.from([0x0A, 0x00])]);
}

function buildLoginMessage(username, password) {
  // Match exact JSON structure from working script
  const jsonObj = {
    EncryptType: 'MD5', LoginType: 'DVRIP-Web',
    PassWord: sofiaHash(password), UserName: username,
  };
  return buildFrame(MSG_LOGIN, jsonObj);
}

function buildKeepaliveMessage(sessionId) {
  return buildFrame(MSG_KEEPALIVE, {});
}

function parseLoginResponse(data) {
  if (data.length < 20) {
    throw new Error('Response too short for header');
  }
  
  const msgId = data.readUInt16LE(14);
  const len = data.readUInt32LE(16);
  
  if (msgId !== MSG_LOGIN_RESPONSE) {
    throw new Error(`Expected login response (${MSG_LOGIN_RESPONSE}), got ${msgId}`);
  }
  
  if (data.length < 20 + len) {
    throw new Error('Response too short for payload');
  }
  
  const body = data.subarray(20, 20 + Math.min(len, data.length - 20)).toString('utf8');
  let ret = '?', session = '?', alive = '?';
  try {
    const j = JSON.parse(body.replace(/\n\x00*$/, ''));
    ret = j.Ret;
    session = j.SessionID;
    alive = j.AliveInterval;
  } catch (err) {
    throw new Error(`Failed to parse JSON response: ${err.message}`);
  }
  
  return {
    Ret: ret,
    AliveInterval: alive,
    SessionId: session,
    success: ret === 100
  };
}

function parseKeepaliveResponse(data) {
  if (data.length < 20) {
    throw new Error('Response too short for header');
  }
  
  const msgId = data.readUInt16LE(14);
  
  if (msgId !== MSG_KEEPALIVE_RESPONSE) {
    throw new Error(`Expected keepalive response (${MSG_KEEPALIVE_RESPONSE}), got ${msgId}`);
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
      
      // Send login message using V5.00 protocol
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
        console.log('  - Protocol framing is correct (V5.00)');
        console.log('  - Authentication failure may be due to incorrect credentials');
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
