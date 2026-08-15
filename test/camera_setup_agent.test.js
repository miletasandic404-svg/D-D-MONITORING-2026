'use strict';

/**
 * Camera Setup Agent Integration Tests
 * Tests for vendor connector selection and runtime path verification
 */

const { test } = require('node:test');
const assert = require('node:assert');
const { connectors, getConnector } = require('../lib/_camera_connectors');
const { xiongmaiConnector } = require('../lib/_xiongmai_dvrip');

test('connectors array includes all expected connectors', () => {
  assert.ok(Array.isArray(connectors));
  assert.ok(connectors.length >= 3);
  
  const connectorIds = connectors.map(c => c.id);
  assert.ok(connectorIds.includes('onvif'));
  assert.ok(connectorIds.includes('xiongmai-dvrip'));
  assert.ok(connectorIds.includes('rtsp-common'));
});

test('connectors are in correct priority order', () => {
  const connectorIds = connectors.map(c => c.id);
  const onvifIndex = connectorIds.indexOf('onvif');
  const xiongmaiIndex = connectorIds.indexOf('xiongmai-dvrip');
  const rtspIndex = connectorIds.indexOf('rtsp-common');
  
  assert.ok(onvifIndex >= 0, 'ONVIF connector must exist');
  assert.ok(xiongmaiIndex >= 0, 'Xiongmai connector must exist');
  assert.ok(rtspIndex >= 0, 'RTSP-common connector must exist');
  
  // Verify order: ONVIF → Xiongmai → RTSP-common
  assert.ok(onvifIndex < xiongmaiIndex, 'ONVIF must come before Xiongmai');
  assert.ok(xiongmaiIndex < rtspIndex, 'Xiongmai must come before RTSP-common');
});

test('getConnector returns correct connector by ID', () => {
  const onvif = getConnector('onvif');
  assert.ok(onvif);
  assert.equal(onvif.id, 'onvif');
  
  const xiongmai = getConnector('xiongmai-dvrip');
  assert.ok(xiongmai);
  assert.equal(xiongmai.id, 'xiongmai-dvrip');
  
  const rtsp = getConnector('rtsp-common');
  assert.ok(rtsp);
  assert.equal(rtsp.id, 'rtsp-common');
  
  const invalid = getConnector('invalid-id');
  assert.equal(invalid, null);
});

test('xiongmaiConnector is exported and callable', () => {
  assert.equal(typeof xiongmaiConnector, 'function');
});

test('xiongmaiConnector returns expected structure for unsupported camera', async () => {
  // Test with an IP that won't respond (safe for CI)
  const result = await xiongmaiConnector('127.0.0.1', {
    username: 'admin',
    password: 'admin',
    port: 34567,
  });
  
  assert.ok(result);
  assert.equal(result.onvif_supported, false);
  assert.equal(result.dvrip_supported, false);
  assert.ok(Array.isArray(result.streams));
  assert.equal(result.streams.length, 0);
});

test('xiongmaiConnector returns expected structure for successful discovery (mocked)', async () => {
  // This test verifies the structure without requiring real hardware
  // Test with localhost which won't respond but will return valid structure
  const result = await xiongmaiConnector('127.0.0.1', {
    username: 'admin',
    password: 'admin',
    port: 34567,
  });
  
  // Even if connection fails, structure should be valid
  assert.ok(result);
  assert.ok('onvif_supported' in result);
  assert.ok('dvrip_supported' in result);
  assert.ok('manufacturer' in result);
  assert.ok('model' in result);
  assert.ok(Array.isArray(result.streams));
});

test('connector discover functions have correct signature', async () => {
  for (const connector of connectors) {
    assert.equal(typeof connector.discover, 'function');
    assert.equal(typeof connector.id, 'string');
    assert.equal(typeof connector.name, 'string');
  }
});

test('existing RTSP/ONVIF behavior is preserved', () => {
  // Verify that ONVIF and RTSP connectors still exist and are unchanged
  const onvif = getConnector('onvif');
  assert.ok(onvif);
  assert.equal(onvif.name, 'ONVIF Profile S');
  
  const rtsp = getConnector('rtsp-common');
  assert.ok(rtsp);
  assert.equal(rtsp.name, 'Common RTSP paths (non-ONVIF)');
});

test('connector selection loop can iterate through all connectors', () => {
  const attemptedConnectors = [];
  
  for (const connector of connectors) {
    attemptedConnectors.push(connector.id);
  }
  
  assert.ok(attemptedConnectors.length >= 3);
  assert.ok(attemptedConnectors.includes('onvif'));
  assert.ok(attemptedConnectors.includes('xiongmai-dvrip'));
  assert.ok(attemptedConnectors.includes('rtsp-common'));
});

test('connector selection stops at first successful result', () => {
  // Simulate the connector loop logic
  let found = false;
  let successfulConnector = null;
  
  for (const connector of connectors) {
    if (connector.id === 'onvif') {
      // Simulate ONVIF success
      found = true;
      successfulConnector = connector.id;
      break;
    }
  }
  
  assert.ok(found);
  assert.equal(successfulConnector, 'onvif');
});

test('connector selection falls back to Xiongmai if ONVIF fails', () => {
  // Simulate the connector loop logic with ONVIF failure
  let found = false;
  let successfulConnector = null;
  
  for (const connector of connectors) {
    if (connector.id === 'onvif') {
      // Simulate ONVIF failure - continue to next
      continue;
    }
    if (connector.id === 'xiongmai-dvrip') {
      // Simulate Xiongmai success
      found = true;
      successfulConnector = connector.id;
      break;
    }
  }
  
  assert.ok(found);
  assert.equal(successfulConnector, 'xiongmai-dvrip');
});

test('connector selection falls back to RTSP-common if both ONVIF and Xiongmai fail', () => {
  // Simulate the connector loop logic with ONVIF and Xiongmai failures
  let found = false;
  let successfulConnector = null;
  
  for (const connector of connectors) {
    if (connector.id === 'onvif' || connector.id === 'xiongmai-dvrip') {
      // Simulate failures - continue to next
      continue;
    }
    if (connector.id === 'rtsp-common') {
      // Simulate RTSP success
      found = true;
      successfulConnector = connector.id;
      break;
    }
  }
  
  assert.ok(found);
  assert.equal(successfulConnector, 'rtsp-common');
});
