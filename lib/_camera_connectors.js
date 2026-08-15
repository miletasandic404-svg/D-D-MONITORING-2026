'use strict';
/**
 * Camera connector registry — the extension point for vendor-specific camera
 * integrations.
 *
 * A connector turns a camera IP address (and optional credentials) into a list
 * of TESTED RTSP streams. Built-in connectors:
 *
 *   onvif        — full ONVIF Profile S discovery (lib/_onvif_client.js).
 *                  Works only when the camera exposes an ONVIF service.
 *                  Stays the PRIMARY connector — fallback never runs first.
 *   rtsp-common  — vendor-agnostic fallback for cameras WITHOUT ONVIF: probes
 *                  well-known RTSP path patterns (Hikvision, Dahua, Uniview,
 *                  Axis, generic) with a real handshake and reports which
 *                  ones actually stream.
 *
 * To add a vendor-specific integration (e.g. a proprietary camera API), add a
 * new connector object here with the same shape and it is picked up
 * automatically by workers/camera-setup-agent.js:
 *
 *   { id, name, async discover(ip, opts) -> { onvif_supported, manufacturer,
 *     model, firmware_version, streams: [{ url, label, reachable,
 *     authenticated, stream_available }] } }
 */

const { discoverCamera } = require('./_onvif_client');
const { probeBatch, guessRtspUrls } = require('./_rtsp_probe');
const { stripCredentialsFromUrl } = require('./_crypto');
const { xiongmaiConnector } = require('./_xiongmai_dvrip');

const RTSP_PORT = 554;
const MAX_STREAMS = 6;
const PROBE_CONCURRENCY = 4;

function rtspLabel(url, index) {
  const u = String(url || '').toLowerCase();
  if (u.includes('sub') || u.includes('102') || u.includes('subtype=1')) return 'Sub stream';
  if (u.includes('main') || u.includes('101') || u.includes('subtype=0') || u.includes('preview_01_main')) return 'Main stream';
  return `Stream ${index + 1}`;
}

async function onvifConnector(ip, { port = 80, username = '', password = '' } = {}) {
  const cam = await discoverCamera(ip, port, username || '', password || '');
  const urls = (cam.rtsp_urls || []).slice(0, MAX_STREAMS);
  const candidates = urls.map((url, i) => ({ url, label: rtspLabel(url, i) }));
  const streams = await probeBatch(candidates, { username, password, concurrency: PROBE_CONCURRENCY });
  return {
    onvif_supported: true,
    manufacturer: cam.manufacturer || 'Unknown',
    model: cam.model || 'Unknown',
    firmware_version: cam.firmware_version || null,
    serial_number: cam.serial_number || null,
    streams,
  };
}

async function rtspCommonConnector(ip, { username = '', password = '', rtspPort = RTSP_PORT } = {}) {
  const candidates = guessRtspUrls(ip, { username, password, port: rtspPort });
  const probed = await probeBatch(candidates, {
    username, password,
    concurrency: PROBE_CONCURRENCY,
    minAvailable: 2,
  });
  const streams = probed
    .filter((s) => s.stream_available)
    .map((s) => ({ ...s, url: stripCredentialsFromUrl(s.url) }));
  return {
    onvif_supported: false,
    manufacturer: 'Unknown',
    model: 'Unknown (RTSP-only)',
    streams,
  };
}

const connectors = [
  { id: 'onvif', name: 'ONVIF Profile S', discover: onvifConnector },
  { id: 'xiongmai-dvrip', name: 'Xiongmai/XMEye DVRIP', discover: xiongmaiConnector },
  { id: 'rtsp-common', name: 'Common RTSP paths (non-ONVIF)', discover: rtspCommonConnector },
];

function getConnector(id) {
  return connectors.find((c) => c.id === id) || null;
}

module.exports = { connectors, getConnector, onvifConnector, rtspCommonConnector, xiongmaiConnector };
