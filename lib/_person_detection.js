'use strict';

/**
 * Person detection module using YOLOv8n ONNX model.
 *
 * Provides:
 *   - Model loading with graceful fallback
 *   - JPEG → RGB 640×640 preprocessing
 *   - ONNX inference
 *   - Post-processing (NMS, confidence threshold, person class filter)
 *
 * Model requirements:
 *   - YOLOv8n exported to ONNX format
 *   - Input: 1×3×640×640 RGB float32 normalized 0-1
 *   - Output: 1×84×8400 (80 classes + 4 bbox coords)
 *   - COCO class 0 = "person"
 *
 * Environment variables:
 *   - PERSON_MODEL_PATH - path to yolov8n.onnx (default: models/yolov8n.onnx)
 *   - PERSON_CONFIDENCE_THRESHOLD - minimum confidence (default: 0.5)
 *   - PERSON_NMS_IOU_THRESHOLD - NMS IoU threshold (default: 0.45)
 *   - PERSON_DETECTION_ENABLED - set to "false" to disable (default: true)
 */

const fs = require('fs');
const path = require('path');
const { makeLogger } = require('./_logger');

const logger = makeLogger('person-detection');

// ── Configuration ───────────────────────────────────────────────────

const MODEL_PATH = process.env.PERSON_MODEL_PATH || path.join(__dirname, '..', 'models', 'yolov8n.onnx');
const CONFIDENCE_THRESHOLD = parseFloat(process.env.PERSON_CONFIDENCE_THRESHOLD || '0.5');
const NMS_IOU_THRESHOLD = parseFloat(process.env.PERSON_NMS_IOU_THRESHOLD || '0.45');
const PERSON_CLASS_ID = 0; // COCO "person"
const INPUT_SIZE = 640;
const MAX_DETECTIONS = 100;

// ── State ───────────────────────────────────────────────────────────

let ortSession = null;
let ortAvailable = false;
let modelLoaded = false;
let loadError = null;

// ── ONNX Runtime lazy load ──────────────────────────────────────────

function getOnnxRuntime() {
  try {
    // eslint-disable-next-line global-require
    const ort = require('onnxruntime-node');
    ortAvailable = true;
    return ort;
  } catch (err) {
    ortAvailable = false;
    logger.warn('onnxruntime-node not installed. Person detection disabled. Install with: npm install onnxruntime-node');
    return null;
  }
}

// ── Model loading ───────────────────────────────────────────────────

async function loadModel() {
  if (modelLoaded) return true;
  if (loadError) return false;

  try {
    if (process.env.PERSON_DETECTION_ENABLED === 'false') {
      loadError = 'Person detection disabled via PERSON_DETECTION_ENABLED=false';
      logger.info(loadError);
      return false;
    }

    if (!fs.existsSync(MODEL_PATH)) {
      loadError = `Model file not found: ${MODEL_PATH}`;
      logger.warn(loadError);
      return false;
    }

    const ort = getOnnxRuntime();
    if (!ort) {
      loadError = 'onnxruntime-node not available';
      return false;
    }

    ortSession = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });

    modelLoaded = true;
    logger.info('Person detection model loaded', { model: MODEL_PATH });
    return true;
  } catch (err) {
    loadError = `Failed to load model: ${err.message}`;
    logger.error(loadError);
    return false;
  }
}

// ── JPEG decoding ───────────────────────────────────────────────────

/**
 * Decode a JPEG buffer to raw RGB pixels.
 * Uses Node's built-in zlib for basic JPEG parsing, or falls back
 * to returning null if the JPEG uses unsupported features.
 *
 * For production, consider using sharp or jpeg-js for robust decoding.
 *
 * @param {Buffer} jpegBuffer
 * @returns {{ width: number, height: number, data: Uint8Array } | null}
 */
function decodeJpeg(jpegBuffer) {
  if (!jpegBuffer || jpegBuffer.length < 2) return null;
  if (jpegBuffer[0] !== 0xFF || jpegBuffer[1] !== 0xD8) return null;

  // Try to use sharp if available (best quality, handles all JPEG types)
  try {
    // eslint-disable-next-line global-require
    const sharp = require('sharp');
    // Synchronous decode not available in sharp, return null to use async path
    return null;
  } catch {
    // sharp not available
  }

  // Try jpeg-js
  try {
    // eslint-disable-next-line global-require
    const jpeg = require('jpeg-js');
    const decoded = jpeg.decode(jpegBuffer, { useTArray: true });
    return {
      width: decoded.width,
      height: decoded.height,
      data: decoded.data, // RGBA Uint8Array
    };
  } catch {
    // jpeg-js not available
  }

  return null;
}

/**
 * Async JPEG decode using sharp (preferred) or jpeg-js.
 *
 * @param {Buffer} jpegBuffer
 * @returns {Promise<{ width: number, height: number, data: Uint8Array } | null>}
 */
async function decodeJpegAsync(jpegBuffer) {
  if (!jpegBuffer || jpegBuffer.length < 2) return null;
  if (jpegBuffer[0] !== 0xFF || jpegBuffer[1] !== 0xD8) return null;

  // Try sharp first (best quality)
  try {
    // eslint-disable-next-line global-require
    const sharp = require('sharp');
    const { data, info } = await sharp(jpegBuffer)
      .ensureAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true });
    return { width: info.width, height: info.height, data };
  } catch {
    // sharp not available, try sync path
  }

  // Fallback to jpeg-js
  const sync = decodeJpeg(jpegBuffer);
  if (sync) return sync;

  return null;
}

// ── Image preprocessing ─────────────────────────────────────────────

/**
 * Resize and normalize image data for YOLOv8 input.
 * Converts RGBA → RGB, resizes to 640×640, normalizes to 0-1.
 *
 * @param {Uint8Array} rgbaData - Raw RGBA pixel data
 * @param {number} srcWidth - Source image width
 * @param {number} srcHeight - Source image height
 * @returns {Float32Array} 1×3×640×640 float32 array (CHW format)
 */
function preprocess(rgbaData, srcWidth, srcHeight) {
  const output = new Float32Array(1 * 3 * INPUT_SIZE * INPUT_SIZE);

  const xRatio = srcWidth / INPUT_SIZE;
  const yRatio = srcHeight / INPUT_SIZE;

  // Simple bilinear resize + RGBA→RGB + normalize
  for (let y = 0; y < INPUT_SIZE; y++) {
    for (let x = 0; x < INPUT_SIZE; x++) {
      const srcX = Math.min(Math.floor(x * xRatio), srcWidth - 1);
      const srcY = Math.min(Math.floor(y * yRatio), srcHeight - 1);
      const srcIdx = (srcY * srcWidth + srcX) * 4;

      const r = rgbaData[srcIdx] / 255;
      const g = rgbaData[srcIdx + 1] / 255;
      const b = rgbaData[srcIdx + 2] / 255;

      // CHW format: channel 0 (R), channel 1 (G), channel 2 (B)
      const dstIdx = y * INPUT_SIZE + x;
      output[dstIdx] = r;                    // R channel
      output[INPUT_SIZE * INPUT_SIZE + dstIdx] = g;  // G channel
      output[2 * INPUT_SIZE * INPUT_SIZE + dstIdx] = b;  // B channel
    }
  }

  return output;
}

/**
 * Fast nearest-neighbor resize for fallback when quality is less critical.
 *
 * @param {Uint8Array} rgbaData
 * @param {number} srcWidth
 * @param {number} srcHeight
 * @returns {Float32Array}
 */
function preprocessFast(rgbaData, srcWidth, srcHeight) {
  return preprocess(rgbaData, srcWidth, srcHeight); // Same for now
}

// ── Post-processing ─────────────────────────────────────────────────

/**
 * Apply Non-Maximum Suppression to remove overlapping boxes.
 *
 * @param {Array<{ x: number, y: number, w: number, h: number, confidence: number, classId: number }>} boxes
 * @param {number} iouThreshold
 * @returns {Array} Filtered boxes
 */
function nms(boxes, iouThreshold = NMS_IOU_THRESHOLD) {
  if (boxes.length === 0) return [];

  // Sort by confidence descending
  boxes.sort((a, b) => b.confidence - a.confidence);

  const selected = [];
  const suppressed = new Set();

  for (let i = 0; i < boxes.length; i++) {
    if (suppressed.has(i)) continue;

    selected.push(boxes[i]);

    for (let j = i + 1; j < boxes.length; j++) {
      if (suppressed.has(j)) continue;
      const iou = computeIoU(boxes[i], boxes[j]);
      if (iou > iouThreshold) {
        suppressed.add(j);
      }
    }
  }

  return selected;
}

/**
 * Compute Intersection over Union between two boxes.
 */
function computeIoU(a, b) {
  const x1 = Math.max(a.x - a.w / 2, b.x - b.w / 2);
  const y1 = Math.max(a.y - a.h / 2, b.y - b.h / 2);
  const x2 = Math.min(a.x + a.w / 2, b.x + b.w / 2);
  const y2 = Math.min(a.y + a.h / 2, b.y + b.h / 2);

  const intersection = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  const areaA = a.w * a.h;
  const areaB = b.w * b.h;
  const union = areaA + areaB - intersection;

  return union > 0 ? intersection / union : 0;
}

/**
 * Parse YOLOv8 output tensor and extract person detections.
 *
 * @param {Float32Array} output - Raw model output (1×84×8400)
 * @param {number} width - Original image width
 * @param {number} height - Original image height
 * @param {number} confidenceThreshold
 * @returns {Array<{ x: number, y: number, w: number, h: number, confidence: number, classId: number }>}
 */
function parseDetections(output, width, height, confidenceThreshold = CONFIDENCE_THRESHOLD) {
  const numClasses = 80;
  const numAnchors = 8400;
  const boxes = [];

  for (let i = 0; i < numAnchors; i++) {
    let maxConf = 0;
    let maxClass = -1;

    // Find max confidence across classes for this anchor
    for (let c = 0; c < numClasses; c++) {
      const conf = output[(4 + c) * numAnchors + i];
      if (conf > maxConf) {
        maxConf = conf;
        maxClass = c;
      }
    }

    if (maxConf < confidenceThreshold) continue;
    if (maxClass !== PERSON_CLASS_ID) continue;

    // Extract bbox (center x, center y, width, height) - normalized 0-1
    const cx = output[0 * numAnchors + i];
    const cy = output[1 * numAnchors + i];
    const w = output[2 * numAnchors + i];
    const h = output[3 * numAnchors + i];

    // Scale to original image dimensions
    boxes.push({
      x: cx * width,
      y: cy * height,
      w: w * width,
      h: h * height,
      confidence: maxConf,
      classId: maxClass,
    });
  }

  return boxes;
}

// ── Main detection API ──────────────────────────────────────────────

/**
 * Detect persons in a JPEG image buffer.
 *
 * @param {Buffer} jpegBuffer - JPEG image data
 * @returns {Promise<{ persons: Array, inferenceTimeMs: number, error: string|null }>}
 *   persons: array of { x, y, w, h, confidence }
 */
async function detectPersons(jpegBuffer) {
  const startTime = Date.now();

  // Check if detection is available
  if (!modelLoaded) {
    const loaded = await loadModel();
    if (!loaded) {
      return { persons: [], inferenceTimeMs: 0, error: loadError || 'Model not loaded' };
    }
  }

  try {
    // Decode JPEG
    const image = await decodeJpegAsync(jpegBuffer);
    if (!image) {
      return { persons: [], inferenceTimeMs: 0, error: 'Failed to decode JPEG' };
    }

    // Preprocess
    const inputTensor = preprocess(image.data, image.width, image.height);

    // Create ONNX tensor
    const ort = getOnnxRuntime();
    const inputName = ortSession.inputNames[0];
    const tensor = new ort.Tensor('float32', inputTensor, [1, 3, INPUT_SIZE, INPUT_SIZE]);

    // Run inference
    const results = await ortSession.run({ [inputName]: tensor });
    const outputName = ortSession.outputNames[0];
    const outputData = results[outputName].data;

    // Parse detections
    let boxes = parseDetections(outputData, image.width, image.height, CONFIDENCE_THRESHOLD);

    // Apply NMS
    boxes = nms(boxes, NMS_IOU_THRESHOLD);

    // Limit results
    if (boxes.length > MAX_DETECTIONS) {
      boxes = boxes.slice(0, MAX_DETECTIONS);
    }

    const inferenceTimeMs = Date.now() - startTime;

    return {
      persons: boxes.map(b => ({
        x: Math.round(b.x),
        y: Math.round(b.y),
        w: Math.round(b.w),
        h: Math.round(b.h),
        confidence: Math.round(b.confidence * 100) / 100,
      })),
      inferenceTimeMs,
      error: null,
    };
  } catch (err) {
    logger.error('Detection failed', { error: err.message });
    return { persons: [], inferenceTimeMs: Date.now() - startTime, error: err.message };
  }
}

/**
 * Check if person detection is available (model loaded or loadable).
 *
 * @returns {Promise<boolean>}
 */
async function isAvailable() {
  if (modelLoaded) return true;
  return loadModel();
}

/**
 * Get current module status.
 *
 * @returns {Object} Status info
 */
function getStatus() {
  return {
    modelLoaded,
    ortAvailable,
    modelPath: MODEL_PATH,
    modelExists: fs.existsSync(MODEL_PATH),
    loadError,
    confidenceThreshold: CONFIDENCE_THRESHOLD,
    nmsIouThreshold: NMS_IOU_THRESHOLD,
    inputSize: INPUT_SIZE,
  };
}

module.exports = {
  detectPersons,
  isAvailable,
  getStatus,
  loadModel,
  // Exposed for testing
  _internal: {
    decodeJpeg,
    decodeJpegAsync,
    preprocess,
    parseDetections,
    nms,
    computeIoU,
  },
};
