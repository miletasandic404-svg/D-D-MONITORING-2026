'use strict';

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  detectTwoWayAudioCapability,
  createTwoWayAudioAdapter,
  SAMPLE_RATE,
  FRAME_SIZE_SAMPLES,
} = require('../lib/_two_way_audio');

describe('Two-Way Audio — capability detection', () => {
  test('DVRIP camera (connection_type=dvrip) is supported via OPTalk', () => {
    const caps = detectTwoWayAudioCapability({
      id: 'cam_dvrip_1',
      connection_type: 'dvrip',
    });
    assert.equal(caps.supported, true);
    assert.equal(caps.protocol, 'optalk');
    assert.equal(caps.audio_format, 'G.711 A-law');
    assert.equal(caps.audio_sample_rate, 8000);
    assert.equal(caps.audio_frame_size, 320);
    assert.equal(caps.reason, null);
  });

  test('ONVIF camera is not supported (probing not implemented)', () => {
    const caps = detectTwoWayAudioCapability({
      id: 'cam_onvif_1',
      connection_type: 'onvif',
      rtsp_url: 'rtsp://192.168.1.100:554/Streaming/Channels/1011',
    });
    assert.equal(caps.supported, false);
    assert.equal(caps.protocol, 'onvif');
    assert.ok(caps.reason.includes('not yet implemented'));
  });

  test('RTSP-only camera (null connection_type) is not supported', () => {
    const caps = detectTwoWayAudioCapability({
      id: 'cam_rtsp_1',
      connection_type: null,
      rtsp_url: 'rtsp://192.168.1.200:554/ch1/live',
    });
    assert.equal(caps.supported, false);
    assert.equal(caps.protocol, 'rtsp');
    assert.ok(caps.reason.includes('not yet implemented'));
  });

  test('camera with no connection_type and no rtsp_url is not supported', () => {
    const caps = detectTwoWayAudioCapability({
      id: 'cam_unknown',
    });
    assert.equal(caps.supported, false);
    assert.equal(caps.protocol, null);
    assert.ok(caps.reason.includes('No speaker'));
  });

  test('null/undefined camera returns not supported', () => {
    const caps = detectTwoWayAudioCapability(null);
    assert.equal(caps.supported, false);
    assert.equal(caps.reason, 'camera not found');
  });

  test('undefined camera returns not supported', () => {
    const caps = detectTwoWayAudioCapability(undefined);
    assert.equal(caps.supported, false);
    assert.equal(caps.reason, 'camera not found');
  });

  test('DVRIP camera with custom port still has OPTalk capability', () => {
    const caps = detectTwoWayAudioCapability({
      id: 'cam_dvrip_2',
      connection_type: 'dvrip',
      ip: '192.168.1.50',
      port: 34567,
    });
    assert.equal(caps.supported, true);
    assert.equal(caps.protocol, 'optalk');
  });
});

describe('Two-Way Audio — constants', () => {
  test('SAMPLE_RATE is 8000 (G.7.11 standard)', () => {
    assert.equal(SAMPLE_RATE, 8000);
  });

  test('FRAME_SIZE_SAMPLES is 320 (40 ms at 8 kHz)', () => {
    assert.equal(FRAME_SIZE_SAMPLES, 320);
  });
});

describe('Two-Way Audio — adapter factory', () => {
  test('createTwoWayAudioAdapter rejects unsupported camera types', async () => {
    const camera = {
      id: 'cam_unknown',
      connection_type: null,
    };
    await assert.rejects(
      () => createTwoWayAudioAdapter(camera),
      /Two-Way Audio not supported/,
    );
  });

  test('createTwoWayAudioAdapter rejects ONVIF cameras', async () => {
    const camera = {
      id: 'cam_onvif',
      connection_type: 'onvif',
      rtsp_url: 'rtsp://192.168.1.100:554/stream',
    };
    await assert.rejects(
      () => createTwoWayAudioAdapter(camera),
      /Two-Way Audio not supported/,
    );
  });

  test('createTwoWayAudioAdapter rejects RTSP-only cameras', async () => {
    const camera = {
      id: 'cam_rtsp',
      connection_type: null,
      rtsp_url: 'rtsp://192.168.1.200:554/ch1/live',
    };
    await assert.rejects(
      () => createTwoWayAudioAdapter(camera),
      /Two-Way Audio not supported/,
    );
  });
});
