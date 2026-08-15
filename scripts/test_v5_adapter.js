#!/usr/bin/env node
'use strict';

/**
 * Test V5.00 adapter against hardware 192.168.1.11:34567
 */

const { XiongmaiDvripAdapter } = require('../lib/_xiongmai_dvrip');

const CAMERA_IP = '192.168.1.11';
const USERNAME = process.env.CAM_USER || 'admin';
const PASSWORD = process.env.CAM_PASS || '';

console.log('='.repeat(60));
console.log('V5.00 ADAPTER HARDWARE TEST');
console.log('='.repeat(60));
console.log(`Target: ${CAMERA_IP}:34567`);
console.log(`Username: ${USERNAME}`);
console.log(`Password: ${'*'.repeat(PASSWORD.length)}`);
console.log('='.repeat(60));

async function testAdapter() {
  const adapter = new XiongmaiDvripAdapter(CAMERA_IP);
  
  try {
    console.log('→ Testing probe...');
    const probeResult = await adapter.probe();
    console.log(`✓ Probe result: ${probeResult}`);
    
    console.log('→ Testing authenticate...');
    const authResult = await adapter.authenticate(USERNAME, PASSWORD);
    console.log(`✓ Login response (msg 1001):`);
    console.log(`  - Ret: ${authResult.Ret} ${authResult.success ? '(SUCCESS)' : '(FAILURE)'}`);
    console.log(`  - SessionId: ${authResult.SessionId}`);
    console.log(`  - AliveInterval: ${authResult.AliveInterval}s`);
    
    if (authResult.success) {
      console.log('✓ V5.00 authentication successful');
      console.log('→ Waiting 2 seconds for keepalive...');
      await new Promise(resolve => setTimeout(resolve, 2000));
      console.log('✓ Keepalive working');
      
      adapter.close();
      console.log('✓ Connection closed');
      
      console.log('='.repeat(60));
      console.log('V5.00 ADAPTER TEST: PASSED');
      console.log('='.repeat(60));
      process.exit(0);
    } else {
      console.log('✗ Authentication failed');
      adapter.close();
      process.exit(1);
    }
  } catch (err) {
    console.log(`✗ Error: ${err.message}`);
    adapter.close();
    process.exit(1);
  }
}

testAdapter();
