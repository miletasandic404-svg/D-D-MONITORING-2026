'use strict';

/**
 * Tests for lib/_network_security.js -- the centralized SSRF / network
 * policy used before ANY outbound connection to a user-influenced host.
 *
 * Two modes:
 *   allowPrivate: true  -- tenant media node (LAN cameras allowed)
 *   allowPrivate: false -- shared infrastructure (public only)
 */

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');

const {
  assertSafeTarget,
  classifyIp,
  checkHost,
  checkUrl,
} = require('../lib/_network_security');

describe('classifyIp', () => {
  test('classifies loopback', () => {
    assert.equal(classifyIp('127.0.0.1'), 'loopback');
    assert.equal(classifyIp('::1'), 'loopback');
  });
  test('classifies link-local and cloud metadata', () => {
    assert.equal(classifyIp('169.254.169.254'), 'metadata');
    assert.equal(classifyIp('169.254.10.10'), 'link-local');
    assert.equal(classifyIp('fe80::1'), 'link-local');
  });
  test('classifies private RFC1918', () => {
    assert.equal(classifyIp('10.0.0.1'), 'private');
    assert.equal(classifyIp('172.16.0.1'), 'private');
    assert.equal(classifyIp('192.168.1.16'), 'private');
    assert.equal(classifyIp('fd00::1'), 'private');
  });
  test('classifies unspecified, multicast, reserved', () => {
    assert.equal(classifyIp('0.0.0.0'), 'unspecified');
    assert.equal(classifyIp('224.0.0.1'), 'multicast');
    assert.equal(classifyIp('239.255.255.250'), 'multicast');
    assert.equal(classifyIp('240.0.0.1'), 'reserved');
  });
  test('classifies public', () => {
    assert.equal(classifyIp('8.8.8.8'), 'public');
    assert.equal(classifyIp('1.1.1.1'), 'public');
  });
  test('rejects invalid', () => {
    assert.equal(classifyIp('999.999.1.1'), 'invalid');
    assert.equal(classifyIp('not-an-ip'), 'invalid');
  });
});

describe('assertSafeTarget -- tenant node (allowPrivate: true)', () => {
  test('allows private LAN camera IPs', async () => {
    await assertSafeTarget('192.168.1.16', { allowPrivate: true });
    await assertSafeTarget('10.0.0.5', { allowPrivate: true });
    await assertSafeTarget('172.16.4.4', { allowPrivate: true });
  });
  test('allows public IPs', async () => {
    await assertSafeTarget('8.8.8.8', { allowPrivate: true });
  });
  test('rejects cloud metadata 169.254.169.254', async () => {
    await assert.rejects(() => assertSafeTarget('169.254.169.254', { allowPrivate: true }));
  });
  test('rejects loopback', async () => {
    await assert.rejects(() => assertSafeTarget('127.0.0.1', { allowPrivate: true }));
    await assert.rejects(() => assertSafeTarget('localhost', { allowPrivate: true }));
  });
  test('rejects link-local and multicast', async () => {
    await assert.rejects(() => assertSafeTarget('169.254.10.10', { allowPrivate: true }));
    await assert.rejects(() => assertSafeTarget('224.0.0.1', { allowPrivate: true }));
  });
  test('rejects RTSP URL to metadata host', async () => {
    await assert.rejects(() =>
      assertSafeTarget('rtsp://169.254.169.254:554/live', { allowPrivate: true }));
  });
  test('allows RTSP URL to private LAN camera', async () => {
    const res = await assertSafeTarget('rtsp://192.168.1.16:554/Streaming/Channels/101', { allowPrivate: true });
    assert.equal(res.host, '192.168.1.16');
  });
  test('rejects IPv4-in-IPv6 mapped private (::ffff:127.0.0.1)', async () => {
    await assert.rejects(() => assertSafeTarget('::ffff:127.0.0.1', { allowPrivate: true }));
  });
  test('rejects IPv4-in-IPv6 mapped metadata (::ffff:169.254.169.254)', async () => {
    await assert.rejects(() => assertSafeTarget('::ffff:169.254.169.254', { allowPrivate: true }));
  });
  test('rejects rtsps URL to loopback', async () => {
    await assert.rejects(() =>
      assertSafeTarget('rtsps://127.0.0.1/live', { allowPrivate: true }));
  });
  test('rejects unsupported protocol (file://)', async () => {
    await assert.rejects(() =>
      assertSafeTarget('file:///etc/passwd', { allowPrivate: true }));
  });
});

describe('assertSafeTarget -- shared infrastructure (allowPrivate: false)', () => {
  test('allows public IPs only', async () => {
    await assertSafeTarget('8.8.8.8', { allowPrivate: false });
    const res = await assertSafeTarget('rtsp://8.8.8.8:554/live', { allowPrivate: false });
    assert.equal(res.ok, true);
  });
  test('rejects private LAN IPs (shared infra must not touch tenant LAN)', async () => {
    await assert.rejects(() => assertSafeTarget('192.168.1.16', { allowPrivate: false }));
    await assert.rejects(() => assertSafeTarget('10.0.0.5', { allowPrivate: false }));
  });
  test('rejects metadata, loopback, link-local', async () => {
    await assert.rejects(() => assertSafeTarget('169.254.169.254', { allowPrivate: false }));
    await assert.rejects(() => assertSafeTarget('127.0.0.1', { allowPrivate: false }));
    await assert.rejects(() => assertSafeTarget('fe80::1', { allowPrivate: false }));
  });
  test('rejects private RTSP URL on shared infra', async () => {
    await assert.rejects(() =>
      assertSafeTarget('rtsp://192.168.1.16:554/Streaming/Channels/101', { allowPrivate: false }));
  });
});

describe('checkUrl', () => {
  test('rejects invalid URL', async () => {
    const res = await checkUrl('not a url', { allowPrivate: true });
    assert.equal(res.ok, false);
  });
  test('rejects unsupported scheme (ftp://)', async () => {
    const res = await checkUrl('ftp://8.8.8.8/x', { allowPrivate: false });
    assert.equal(res.ok, false);
  });
  test('rejects file:// scheme', async () => {
    const res = await checkUrl('file:///etc/passwd', { allowPrivate: false });
    assert.equal(res.ok, false);
  });
  test('accepts http scheme with public IP (no DNS dependency)', async () => {
    const res = await checkUrl('http://8.8.8.8/x', { allowPrivate: false });
    assert.equal(res.ok, true);
  });
});
