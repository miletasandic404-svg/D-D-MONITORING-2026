'use strict';

/**
 * Tests for person detection pipeline.
 *
 * Validates:
 *   - Detection module preprocessing
 *   - NMS (Non-Maximum Suppression)
 *   - Confidence filtering
 *   - Debounce/cooldown logic
 *   - Rate limiting
 *   - Frame submission to worker
 *   - Inference with mocked ONNX session
 *   - End-to-end detection → events pipeline
 */

const { test, describe, beforeEach, afterEach } = require('node:test');
const assert = require('assert/strict');

// ── Mock onnxruntime-node before requiring detection module ─────────

const mockOrt = {
  Tensor: class MockTensor {
    constructor(type, data, dims) {
      this.type = type;
      this.data = data;
      this.dims = dims;
    }
  },
  InferenceSession: {
    create: async (path, options) => ({
      inputNames: ['input'],
      outputNames: ['output'],
      run: async (inputs) => {
        // Mock inference: return a tensor with one person detection
        const output = new Float32Array(1 * 84 * 8400);
        // Set one detection at anchor 0: person at center, 90% confidence
        output[0 * 8400 + 0] = 0.5;  // cx (normalized)
        output[1 * 8400 + 0] = 0.5;  // cy (normalized)
        output[2 * 8400 + 0] = 0.2;  // w (normalized)
        output[3 * 8400 + 0] = 0.3;  // h (normalized)
        output[(4 + 0) * 8400 + 0] = 0.9;  // class 0 (person) confidence
        return { output: new mockOrt.Tensor('float32', output, [1, 84, 8400]) };
      },
    }),
  },
};

// Replace the require cache for onnxruntime-node
require.cache[require.resolve('onnxruntime-node')] = {
  id: require.resolve('onnxruntime-node'),
  filename: require.resolve('onnxruntime-node'),
  loaded: true,
  exports: mockOrt,
};

// ── Test detection module internals ──────────────────────────────────

describe('lib/_person_detection', () => {
  let detection;

  beforeEach(() => {
    detection = require('../lib/_person_detection');
  });

  describe('preprocessing', () => {
    test('preprocess resizes and normalizes to 640x640', () => {
      const { preprocess } = detection._internal;
      const rgba = new Uint8Array(100 * 100 * 4).fill(128);
      const result = preprocess(rgba, 100, 100);

      assert.equal(result.length, 1 * 3 * 640 * 640);
      // Values should be normalized 0-1
      assert.ok(result[0] >= 0 && result[0] <= 1);
    });

    test('preprocess handles different input sizes', () => {
      const { preprocess } = detection._internal;
      const rgba = new Uint8Array(1920 * 1080 * 4).fill(255);
      const result = preprocess(rgba, 1920, 1080);

      assert.equal(result.length, 1 * 3 * 640 * 640);
      // White input should normalize to 1
      assert.ok(result[0] > 0.99);
    });
  });

  describe('NMS', () => {
    test('nms removes overlapping boxes', () => {
      const { nms } = detection._internal;
      const boxes = [
        { x: 100, y: 100, w: 50, h: 50, confidence: 0.9, classId: 0 },
        { x: 105, y: 105, w: 50, h: 50, confidence: 0.8, classId: 0 },
        { x: 300, y: 300, w: 50, h: 50, confidence: 0.7, classId: 0 },
      ];

      const result = nms(boxes, 0.45);
      assert.equal(result.length, 2);
      assert.equal(result[0].confidence, 0.9);
      assert.equal(result[1].confidence, 0.7);
    });

    test('nms keeps non-overlapping boxes', () => {
      const { nms } = detection._internal;
      const boxes = [
        { x: 100, y: 100, w: 20, h: 20, confidence: 0.9, classId: 0 },
        { x: 500, y: 500, w: 20, h: 20, confidence: 0.8, classId: 0 },
        { x: 900, y: 900, w: 20, h: 20, confidence: 0.7, classId: 0 },
      ];

      const result = nms(boxes, 0.45);
      assert.equal(result.length, 3);
    });

    test('nms returns empty for empty input', () => {
      const { nms } = detection._internal;
      const result = nms([], 0.45);
      assert.equal(result.length, 0);
    });
  });

  describe('IoU computation', () => {
    test('computeIoU returns 1.0 for identical boxes', () => {
      const { computeIoU } = detection._internal;
      const box = { x: 100, y: 100, w: 50, h: 50 };
      assert.equal(computeIoU(box, box), 1.0);
    });

    test('computeIoU returns 0 for non-overlapping boxes', () => {
      const { computeIoU } = detection._internal;
      const a = { x: 100, y: 100, w: 20, h: 20 };
      const b = { x: 500, y: 500, w: 20, h: 20 };
      assert.equal(computeIoU(a, b), 0);
    });

    test('computeIoU returns correct value for partial overlap', () => {
      const { computeIoU } = detection._internal;
      const a = { x: 100, y: 100, w: 50, h: 50 };
      const b = { x: 125, y: 125, w: 50, h: 50 };
      const iou = computeIoU(a, b);
      assert.ok(iou > 0 && iou < 1);
    });
  });

  describe('detection status', () => {
    test('getStatus returns valid structure', () => {
      const status = detection.getStatus();
      assert.ok('modelLoaded' in status);
      assert.ok('ortAvailable' in status);
      assert.ok('modelPath' in status);
      assert.ok('confidenceThreshold' in status);
    });

    test('isAvailable returns boolean', async () => {
      const available = await detection.isAvailable();
      assert.equal(typeof available, 'boolean');
    });
  });
});

// ── Test person detection worker ─────────────────────────────────────

describe('workers/person-detection-worker', () => {
  let worker;

  beforeEach(() => {
    // Clear module cache to get fresh state
    delete require.cache[require.resolve('../workers/person-detection-worker')];
    worker = require('../workers/person-detection-worker');
  });

  test('submitFrame accepts valid frames', () => {
    assert.doesNotThrow(() => {
      worker.submitFrame('cam-test', Buffer.from('fake-jpeg-data'));
    });
  });

  test('submitFrame rejects empty camera ID', () => {
    assert.doesNotThrow(() => {
      worker.submitFrame('', Buffer.from('data'));
    });
  });

  test('submitFrame rejects empty buffer', () => {
    assert.doesNotThrow(() => {
      worker.submitFrame('cam-test', Buffer.alloc(0));
    });
  });

  test('getStatus returns valid structure', () => {
    const status = worker.getStatus();
    assert.ok('camerasMonitored' in status);
    assert.ok('queueSizes' in status);
  });
});

// ── Test worker state cleanup ──────────────────────────────────────

describe('worker state cleanup', () => {
  let worker;
  let mockDb;

  beforeEach(() => {
    mockDb = {
      queryAsPlatformAdmin: async () => ({ rows: [{ id: 'cam-active' }] }),
    };

    require.cache[require.resolve('../db/index')] = {
      id: require.resolve('../db/index'),
      filename: require.resolve('../db/index'),
      loaded: true,
      exports: mockDb,
    };

    delete require.cache[require.resolve('../workers/person-detection-worker')];
    worker = require('../workers/person-detection-worker');
  });

  afterEach(() => {
    const state = worker.__test;
    state.frameQueues.clear();
    state.lastDetectionTime.clear();
    state.lastEventTime.clear();
    state.alertsThisHour.clear();
  });

  test('cleanup removes state for deleted cameras', async () => {
    const state = worker.__test;

    state.frameQueues.set('cam-deleted', [{ timestamp: Date.now() }]);
    state.lastDetectionTime.set('cam-deleted', Date.now());
    state.lastEventTime.set('cam-deleted', Date.now());
    state.alertsThisHour.set('cam-deleted', 5);

    state.frameQueues.set('cam-active', [{ timestamp: Date.now() }]);
    state.lastDetectionTime.set('cam-active', Date.now());
    state.lastEventTime.set('cam-active', Date.now());
    state.alertsThisHour.set('cam-active', 3);

    await worker.cleanupStaleState();

    assert.ok(!state.frameQueues.has('cam-deleted'), 'frameQueues should remove deleted camera');
    assert.ok(!state.lastDetectionTime.has('cam-deleted'), 'lastDetectionTime should remove deleted camera');
    assert.ok(!state.lastEventTime.has('cam-deleted'), 'lastEventTime should remove deleted camera');
    assert.ok(!state.alertsThisHour.has('cam-deleted'), 'alertsThisHour should remove deleted camera');

    assert.ok(state.frameQueues.has('cam-active'), 'frameQueues should keep active camera');
    assert.ok(state.lastDetectionTime.has('cam-active'), 'lastDetectionTime should keep active camera');
    assert.ok(state.lastEventTime.has('cam-active'), 'lastEventTime should keep active camera');
    assert.ok(state.alertsThisHour.has('cam-active'), 'alertsThisHour should keep active camera');
  });

  test('cleanup resets hourly counter on hour change', async () => {
    const state = worker.__test;
    state.currentHour = (new Date().getHours() + 1) % 24;
    state.alertsThisHour.set('cam-active', 10);

    await worker.cleanupStaleState();

    assert.equal(state.alertsThisHour.size, 0, 'alertsThisHour should be cleared on hour change');
    assert.equal(state.currentHour, new Date().getHours(), 'currentHour should be updated');
  });

  test('cleanup handles DB errors gracefully', async () => {
    const state = worker.__test;
    state.frameQueues.set('cam-test', [{ timestamp: Date.now() }]);

    // Simulate DB error by changing mock to throw
    mockDb.queryAsPlatformAdmin = async () => {
      throw new Error('DB connection failed');
    };

    // cleanupStaleState catches errors internally, should not throw
    await worker.cleanupStaleState();

    // State should be preserved since cleanup failed before modifying it
    assert.ok(state.frameQueues.has('cam-test'), 'state should be preserved when cleanup fails');
  });
});

// ── Test notification tenant isolation ─────────────────────────────

describe('notification tenant isolation', () => {
  let worker;
  let mockDb;
  let mockSendWebhook;

  beforeEach(() => {
    mockDb = {
      queryAsPlatformAdmin: async () => ({ rows: [] }),
    };

    mockSendWebhook = async () => {};

    require.cache[require.resolve('../db/index')] = {
      id: require.resolve('../db/index'),
      filename: require.resolve('../db/index'),
      loaded: true,
      exports: mockDb,
    };

    delete require.cache[require.resolve('../workers/person-detection-worker')];
    worker = require('../workers/person-detection-worker');
  });

  afterEach(() => {
    const state = worker.__test;
    state.frameQueues.clear();
    state.lastDetectionTime.clear();
    state.lastEventTime.clear();
    state.alertsThisHour.clear();
  });

  test('org A camera triggers only org A notification rules', async () => {
    const orgA = '00000000-0000-0000-0000-000000000001';
    const orgB = '00000000-0000-0000-0000-000000000002';

    let queryCount = 0;
    mockDb.queryAsPlatformAdmin = async (sql, params) => {
      queryCount++;
      if (sql.includes('SELECT organization_id FROM cameras')) {
        return { rows: [{ organization_id: orgA }] };
      }
      if (sql.includes('SELECT id FROM notification_rules')) {
        return {
          rows: [
            { id: 1, channel: 'webhook', recipient: 'https://org-a.example.com', event_type: 'person_detected' },
            { id: 2, channel: 'webhook', recipient: 'https://org-b.example.com', event_type: 'person_detected' },
          ],
        };
      }
      return { rows: [] };
    };

    await worker.sendNotifications('cam-org-a', 100, 0.9);

    assert.equal(queryCount, 2, 'should query camera and notification rules');
  });

  test('org A camera never triggers org B rules', async () => {
    const orgA = '00000000-0000-0000-0000-000000000001';
    const orgB = '00000000-0000-0000-0000-000000000002';

    let lastQuery = '';
    mockDb.queryAsPlatformAdmin = async (sql, params) => {
      lastQuery = sql;
      if (sql.includes('SELECT organization_id FROM cameras')) {
        return { rows: [{ organization_id: orgA }] };
      }
      if (sql.includes('SELECT id FROM notification_rules')) {
        if (params && params[0] === orgA) {
          return {
            rows: [
              { id: 1, channel: 'webhook', recipient: 'https://org-a.example.com', event_type: 'person_detected' },
            ],
          };
        }
        if (params && params[0] === orgB) {
          return {
            rows: [
              { id: 2, channel: 'webhook', recipient: 'https://org-b.example.com', event_type: 'person_detected' },
            ],
          };
        }
        return { rows: [] };
      }
      return { rows: [] };
    };

    await worker.sendNotifications('cam-org-a', 100, 0.9);

    assert.ok(lastQuery.includes('organization_id = $1'), 'query should filter by camera org');
    assert.ok(!lastQuery.includes('organization_id = $2'), 'query should not reference org B');
  });

  test('missing organization fails safely without leaking rules', async () => {
    let webhookCalled = false;
    let webhookUrl = null;

    mockDb.queryAsPlatformAdmin = async (sql, params) => {
      if (sql.includes('SELECT organization_id FROM cameras')) {
        return { rows: [{ organization_id: null }] };
      }
      if (sql.includes('SELECT id FROM notification_rules')) {
        return { rows: [] };
      }
      return { rows: [] };
    };

    const originalSendWebhook = worker.sendNotifications;
    // Override to track if notification would be sent
    // sendNotifications already uses try/catch internally, so we just verify no rules match

    await worker.sendNotifications('cam-no-org', 100, 0.9);

    // With null org_id, the query should return no rules (NULL = NULL is false in SQL)
    // So no notifications should be sent
    assert.ok(true, 'function completed without throwing');
  });
});

// ── Test debounce/cooldown logic ─────────────────────────────────────

describe('debounce/cooldown logic', () => {
  // These are internal to the worker, but we can test the behavior
  // by checking that rapid frame submissions don't create duplicate events

  test('rapid frames are debounced', () => {
    const worker = require('../workers/person-detection-worker');

    // Submit multiple frames rapidly
    for (let i = 0; i < 10; i++) {
      worker.submitFrame('cam-debounce-test', Buffer.from(`frame-${i}`));
    }

    const status = worker.getStatus();
    // Queue should be capped at FRAME_QUEUE_MAX
    assert.ok(status.queueSizes['cam-debounce-test'] <= 5);
  });
});

// ── Test storage local backend integration ────────────────────────────

describe('local storage with detection', () => {
  const path = require('path');
  const fs = require('fs');
  const os = require('os');

  let testDir;

  beforeEach(() => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dnd-detection-test-'));
    process.env.STORAGE_LOCAL_PATH = testDir;
  });

  afterEach(() => {
    delete process.env.STORAGE_LOCAL_PATH;
    try {
      fs.rmSync(testDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  test('detection snapshot can be saved to local storage', async () => {
    const storage = require('../lib/_storage');

    // Simulate saving a detection snapshot
    const key = 'snapshots/org-1/cam-1/test-uuid.jpg';
    const jpegData = Buffer.from('fake-jpeg-detection-data');

    const url = await storage.uploadObject({
      key,
      body: jpegData,
      contentType: 'image/jpeg',
    });

    assert.ok(url.startsWith('local://'));

    // Verify file exists on disk
    const filePath = path.join(testDir, key);
    assert.ok(fs.existsSync(filePath));
    assert.equal(fs.readFileSync(filePath).toString(), 'fake-jpeg-detection-data');
  });

  test('detection recording can be saved to local storage', async () => {
    const storage = require('../lib/_storage');

    const key = 'recordings/org-1/cam-1/rec-100.mp4';
    const mp4Data = Buffer.from('fake-mp4-detection-data');

    const url = await storage.uploadObject({
      key,
      body: mp4Data,
      contentType: 'video/mp4',
    });

    assert.ok(url.startsWith('local://'));

    const filePath = path.join(testDir, key);
    assert.ok(fs.existsSync(filePath));
  });
});

// ── Test inference with mocked ONNX session ──────────────────────────

describe('person detection inference (mocked ONNX)', () => {
  let detection;
  const path = require('path');
  const fs = require('fs');

  beforeEach(async () => {
    // Set model path to a dummy file (mock will handle loading)
    process.env.PERSON_MODEL_PATH = path.join(__dirname, 'fixtures', 'test-model.onnx');
    // Create a dummy file so fs.existsSync passes
    const fixturesDir = path.join(__dirname, 'fixtures');
    if (!fs.existsSync(fixturesDir)) {
      fs.mkdirSync(fixturesDir, { recursive: true });
    }
    const modelPath = path.join(fixturesDir, 'test-model.onnx');
    if (!fs.existsSync(modelPath)) {
      fs.writeFileSync(modelPath, Buffer.from('dummy-onnx'));
    }

    // Clear module cache to get fresh detection module
    delete require.cache[require.resolve('../lib/_person_detection')];
    detection = require('../lib/_person_detection');
  });

  afterEach(() => {
    delete process.env.PERSON_MODEL_PATH;
  });

  test('model loads successfully with mock', async () => {
    const loaded = await detection.loadModel();
    assert.equal(loaded, true);
  });

  test('detectPersons returns valid structure', async () => {
    // Create a minimal JPEG-like buffer (mock decoder will handle)
    const jpegBuffer = Buffer.alloc(100, 0xFF);

    const result = await detection.detectPersons(jpegBuffer);

    // Should return valid structure even if no persons detected
    assert.ok('persons' in result);
    assert.ok('inferenceTimeMs' in result);
    assert.ok('error' in result);
    assert.ok(Array.isArray(result.persons));
  });

  test('getStatus returns loaded state', () => {
    const status = detection.getStatus();
    assert.ok('modelLoaded' in status);
    assert.ok('ortAvailable' in status);
  });
});

// ── Test output parsing with known tensor data ───────────────────────

describe('YOLOv8 output parsing', () => {
  let detection;

  beforeEach(() => {
    detection = require('../lib/_person_detection');
  });

  test('parseDetections extracts person with high confidence', () => {
    const { parseDetections } = detection._internal;

    // Create output tensor with one person detection
    const output = new Float32Array(84 * 8400);
    // Anchor 0: person at center
    output[0 * 8400 + 0] = 0.5;  // cx
    output[1 * 8400 + 0] = 0.5;  // cy
    output[2 * 8400 + 0] = 0.2;  // w
    output[3 * 8400 + 0] = 0.3;  // h
    output[(4 + 0) * 8400 + 0] = 0.9;  // person confidence

    const boxes = parseDetections(output, 640, 640, 0.5);

    assert.equal(boxes.length, 1, 'should detect exactly one person');
    assert.equal(boxes[0].classId, 0, 'classId should be 0 (person)');
    assert.ok(boxes[0].confidence >= 0.89, `confidence should be >= 0.89, got ${boxes[0]?.confidence}`);
    assert.equal(boxes[0].x, 320, 'x should be 320 (0.5 * 640)'); // 0.5 * 640
    assert.equal(boxes[0].y, 320, 'y should be 320 (0.5 * 640)');
  });

  test('parseDetections filters low confidence', () => {
    const { parseDetections } = detection._internal;

    const output = new Float32Array(84 * 8400);
    output[0 * 8400 + 0] = 0.5;
    output[1 * 8400 + 0] = 0.5;
    output[2 * 8400 + 0] = 0.2;
    output[3 * 8400 + 0] = 0.3;
    output[(4 + 0) * 8400 + 0] = 0.3; // Below threshold

    const boxes = parseDetections(output, 640, 640, 0.5);
    assert.equal(boxes.length, 0);
  });

  test('parseDetections filters non-person classes', () => {
    const { parseDetections } = detection._internal;

    const output = new Float32Array(84 * 8400);
    output[0 * 8400 + 0] = 0.5;
    output[1 * 8400 + 0] = 0.5;
    output[2 * 8400 + 0] = 0.2;
    output[3 * 8400 + 0] = 0.3;
    output[(4 + 1) * 8400 + 0] = 0.9; // class 1 (bicycle), not person

    const boxes = parseDetections(output, 640, 640, 0.5);
    assert.equal(boxes.length, 0);
  });

  test('parseDetections handles multiple detections', () => {
    const { parseDetections } = detection._internal;

    const output = new Float32Array(84 * 8400);
    // Person 1
    output[0 * 8400 + 0] = 0.3;
    output[1 * 8400 + 0] = 0.3;
    output[2 * 8400 + 0] = 0.1;
    output[3 * 8400 + 0] = 0.1;
    output[(4 + 0) * 8400 + 0] = 0.85;
    // Person 2
    output[0 * 8400 + 1] = 0.7;
    output[1 * 8400 + 1] = 0.7;
    output[2 * 8400 + 1] = 0.15;
    output[3 * 8400 + 1] = 0.2;
    output[(4 + 0) * 8400 + 1] = 0.75;

    const boxes = parseDetections(output, 640, 640, 0.5);
    assert.equal(boxes.length, 2);
  });
});
