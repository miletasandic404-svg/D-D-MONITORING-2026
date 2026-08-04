'use strict';
/**
 * Tests for lib/_logger.js (Phase 9 structured logging).
 *
 * Verifies:
 *   - entries are structured (ts, component, level, event + fields)
 *   - secret values are redacted (keys + standalone tokens + RTSP userinfo)
 *   - LOG_LEVEL filtering works
 *   - error severity routes to console.error
 */

const { test } = require('node:test');
const assert = require('node:assert');

const { makeLogger, redactSecrets } = require('../lib/_logger');

function capture(fn) {
  const logs = [];
  const origLog = console.log;
  const origWarn = console.warn;
  const origError = console.error;
  console.log = (...a) => logs.push(['log', ...a]);
  console.warn = (...a) => logs.push(['warn', ...a]);
  console.error = (...a) => logs.push(['error', ...a]);
  try {
    fn();
  } finally {
    console.log = origLog;
    console.warn = origWarn;
    console.error = origError;
  }
  return logs;
}

test('logger emits structured entries with ts/component/level/event', () => {
  process.env.LOG_FORMAT = 'json';
  const logs = capture(() => makeLogger('camera-setup').info('task.claimed', {
    task_id: 't-1',
    camera_id: 'CAM-ABC',
  }));
  const parsed = JSON.parse(logs[0][1]);
  assert.ok(parsed.ts, 'missing timestamp');
  assert.strictEqual(parsed.component, 'camera-setup');
  assert.strictEqual(parsed.level, 'info');
  assert.strictEqual(parsed.event, 'task.claimed');
  assert.strictEqual(parsed.task_id, 't-1');
  assert.strictEqual(parsed.camera_id, 'CAM-ABC');
});

test('redactSecrets scrubs password/token/secret keys', () => {
  const out = redactSecrets({
    task_id: 't-1',
    username: 'admin',
    password: 's3cretPassword!',
    access_token: 'abc123def456ghi789jkl',
    heartbeat_secret: 'super-secret-heartbeat',
    camera_id: 'CAM-1',
  });
  assert.strictEqual(out.password, '<redacted>');
  assert.strictEqual(out.access_token, '<redacted>');
  assert.strictEqual(out.heartbeat_secret, '<redacted>');
  assert.strictEqual(out.username, 'admin');
  assert.strictEqual(out.camera_id, 'CAM-1');
  assert.ok(!JSON.stringify(out).includes('s3cretPassword'));
});

test('redactSecrets redacts long hex tokens (stream tokens) by value', () => {
  const out = redactSecrets({ token: '3e131ec98e20eba7ba601e7675f5b1f99191bc90108f0e2e9a71b3a65d3a0f0c' });
  assert.strictEqual(out.token, '<redacted>');
  const bare = redactSecrets({ detail: '3e131ec98e20eba7ba601e7675f5b1f99191bc90108f0e2e9a71b3a65d3a0f0c' });
  assert.strictEqual(bare.detail, '<redacted>');
});

test('redactSecrets never redacts timestamps, event names or camera ids', () => {
  const out = redactSecrets({
    ts: '2026-08-04T21:41:22.123Z',
    event: 'sync.adding_path',
    camera_id: 'CAM-1',
    source: 'rtsp://192.168.1.17:554/Streaming/Channels/101',
  });
  assert.ok(out.ts.startsWith('2026-'), 'timestamp must not be redacted');
  assert.strictEqual(out.event, 'sync.adding_path');
  assert.strictEqual(out.camera_id, 'CAM-1');
  assert.ok(out.source.includes('192.168.1.17'));
});

test('redactSecrets strips RTSP userinfo from URLs', () => {
  const out = redactSecrets({
    camera_id: 'CAM-1',
    source: 'rtsp://admin:pass123@192.168.1.17:554/Streaming/Channels/101',
  });
  assert.ok(!out.source.includes('admin:pass123'), 'userinfo leaked');
  assert.ok(out.source.includes('<redacted>'));
  assert.ok(out.source.includes('192.168.1.17'));
});

test('logger respects LOG_LEVEL filtering', () => {
  const prev = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = 'error';
  try {
    const silent = capture(() => makeLogger('t').info('suppressed', {}));
    assert.strictEqual(silent.length, 0, 'info must be suppressed at error level');
    const visible = capture(() => makeLogger('t').error('visible.error', { error: 'x' }));
    assert.strictEqual(visible.length, 1);
  } finally {
    process.env.LOG_LEVEL = prev;
  }
});

test('error severity routes to console.error', () => {
  const logs = capture(() => makeLogger('t').error('worker.fatal', { error: 'boom' }));
  assert.strictEqual(logs[0][0], 'error');
});

test('pretty format includes timestamp and component', () => {
  const prev = process.env.LOG_FORMAT;
  process.env.LOG_FORMAT = 'pretty';
  try {
    const logs = capture(() => makeLogger('heartbeat').info('heartbeat.ok'));
    const line = logs[0][1];
    assert.ok(line.includes('[heartbeat]'), 'missing component prefix');
    assert.ok(/\[[\dT:.Z-]+\]/.test(line), 'missing ISO timestamp');
    assert.ok(line.includes('heartbeat.ok'), 'missing event');
  } finally {
    process.env.LOG_FORMAT = prev;
  }
});
