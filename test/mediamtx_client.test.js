'use strict';

const { test, describe, beforeEach, afterEach, before, after } = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');

let server;
let serverPort;
let receivedRequests = [];
let requestHandler = null;

before(() => {
  return new Promise((resolve) => {
    server = http.createServer((req, res) => {
      if (requestHandler) {
        requestHandler(req, res);
        return;
      }
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsedBody = null;
        try { parsedBody = body ? JSON.parse(body) : null; } catch { parsedBody = body; }
        receivedRequests.push({ method: req.method, url: req.url, body: parsedBody });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
      });
    });
    server.listen(0, () => {
      serverPort = server.address().port;
      resolve();
    });
  });
});

after(() => {
  return new Promise((resolve) => server.close(() => resolve()));
});

const MODULE_PATH = require.resolve('../lib/_mediamtx_client');

beforeEach(() => {
  receivedRequests = [];
  requestHandler = null;
  process.env.MEDIAMTX_API_URL = `http://127.0.0.1:${serverPort}`;
  delete require.cache[MODULE_PATH];
});

afterEach(() => {
  delete require.cache[MODULE_PATH];
});

describe('lib/_mediamtx_client — addOrUpdateCameraPath', () => {
  test('publisher source does NOT send sourceOnDemand', async () => {
    const mediamtxClient = require('../lib/_mediamtx_client');
    await mediamtxClient.addOrUpdateCameraPath('cam-1', 'publisher');

    assert.equal(receivedRequests.length, 1);
    const req = receivedRequests[0];
    assert.equal(req.method, 'POST');
    assert.match(req.url, /\/v3\/config\/paths\/add\/cam-1/);
    assert.equal(req.body.source, 'publisher');
    assert.equal(req.body.sourceOnDemand, undefined,
      'publisher source must NOT include sourceOnDemand (MediaMTX rejects it)');
  });

  test('URL source includes sourceOnDemand: true', async () => {
    const mediamtxClient = require('../lib/_mediamtx_client');
    const rtspUrl = 'rtsp://192.168.1.50:554/stream1';
    await mediamtxClient.addOrUpdateCameraPath('cam-2', rtspUrl);

    assert.equal(receivedRequests.length, 1);
    const req = receivedRequests[0];
    assert.equal(req.method, 'POST');
    assert.equal(req.body.source, rtspUrl);
    assert.equal(req.body.sourceOnDemand, true,
      'URL source should include sourceOnDemand: true (existing behavior)');
  });

  test('publisher source still sends source field', async () => {
    const mediamtxClient = require('../lib/_mediamtx_client');
    await mediamtxClient.addOrUpdateCameraPath('cam-3', 'publisher');
    assert.equal(receivedRequests[0].body.source, 'publisher');
  });

  test('rejects empty cameraId', async () => {
    const mediamtxClient = require('../lib/_mediamtx_client');
    await assert.rejects(
      () => mediamtxClient.addOrUpdateCameraPath('', 'publisher'),
      /obavezni/
    );
  });

  test('rejects empty rtspUrl', async () => {
    const mediamtxClient = require('../lib/_mediamtx_client');
    await assert.rejects(
      () => mediamtxClient.addOrUpdateCameraPath('cam-4', ''),
      /obavezni/
    );
  });

  test('path already exists -> deletes and re-adds', async () => {
    let postCount = 0;
    requestHandler = (req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        let parsedBody = null;
        try { parsedBody = body ? JSON.parse(body) : null; } catch { parsedBody = body; }
        receivedRequests.push({ method: req.method, url: req.url, body: parsedBody });
        if (req.method === 'POST') {
          postCount++;
          if (postCount === 1) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'error', error: 'path already exists' }));
          } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'ok' }));
          }
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ status: 'ok' }));
        }
      });
    };

    const mediamtxClient = require('../lib/_mediamtx_client');
    await mediamtxClient.addOrUpdateCameraPath('cam-5', 'publisher');

    assert.equal(receivedRequests.length, 3);
    assert.equal(receivedRequests[0].method, 'POST');
    assert.match(receivedRequests[0].url, /\/add\/cam-5/);
    assert.equal(receivedRequests[1].method, 'DELETE');
    assert.match(receivedRequests[1].url, /\/delete\/cam-5/);
    assert.equal(receivedRequests[2].method, 'POST');
    assert.match(receivedRequests[2].url, /\/add\/cam-5/);
    assert.equal(receivedRequests[2].body.source, 'publisher');
  });

  test('unrelated 400 error is re-thrown, DELETE not called', async () => {
    requestHandler = (req, res) => {
      receivedRequests.push({ method: req.method, url: req.url });
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'error', error: 'some other error' }));
    };

    const mediamtxClient = require('../lib/_mediamtx_client');
    await assert.rejects(
      () => mediamtxClient.addOrUpdateCameraPath('cam-6', 'publisher'),
      /MediaMTX API POST.*HTTP 400/
    );

    assert.equal(receivedRequests.length, 1);
    assert.equal(receivedRequests[0].method, 'POST');
  });
});
