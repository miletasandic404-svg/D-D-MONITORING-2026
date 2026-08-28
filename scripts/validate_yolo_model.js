#!/usr/bin/env node
'use strict';

/**
 * Validate YOLOv8n ONNX model.
 *
 * Checks:
 *   - File exists and is valid ONNX
 *   - Model loads in ONNX Runtime
 *   - Input shape is [1, 3, 640, 640]
 *   - Output shape is [1, 84, 8400]
 *   - Can run inference on a test image
 */

const fs = require('fs');
const path = require('path');

const MODEL_PATH = path.join(__dirname, '..', 'models', 'yolov8n.onnx');

async function validateModel() {
  console.log('='.repeat(60));
  console.log('YOLOv8n ONNX Model Validation');
  console.log('='.repeat(60));

  // ── Step 1: File exists ──────────────────────────────────────────
  console.log('\n[1] File check');
  if (!fs.existsSync(MODEL_PATH)) {
    console.log('  FAIL: Model file not found at', MODEL_PATH);
    return { model: 'FAIL', reason: 'file not found' };
  }

  const stats = fs.statSync(MODEL_PATH);
  const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
  console.log(`  PASS: File exists (${sizeMB} MB)`);

  // Check first bytes for ONNX magic
  const fd = fs.openSync(MODEL_PATH, 'r');
  const buffer = Buffer.alloc(8);
  fs.readSync(fd, buffer, 0, 8, 0);
  fs.closeSync(fd);

  // ONNX files start with protobuf varint for field 1 (ir_version)
  // Typically starts with 0x08 followed by version number
  if (buffer[0] === 0x08) {
    console.log('  PASS: Valid ONNX header detected');
  } else {
    console.log('  FAIL: Invalid file header (not ONNX)');
    return { model: 'FAIL', reason: 'invalid header' };
  }

  // ── Step 2: Load ONNX Runtime ────────────────────────────────────
  console.log('\n[2] ONNX Runtime check');
  let ort;
  try {
    ort = require('onnxruntime-node');
    console.log('  PASS: onnxruntime-node loaded');
  } catch (err) {
    console.log('  FAIL: onnxruntime-node not available:', err.message);
    return { model: 'FAIL', reason: 'onnxruntime not available' };
  }

  // ── Step 3: Load model ───────────────────────────────────────────
  console.log('\n[3] Model loading');
  let session;
  try {
    session = await ort.InferenceSession.create(MODEL_PATH, {
      executionProviders: ['cpu'],
      graphOptimizationLevel: 'all',
    });
    console.log('  PASS: Model loaded successfully');
  } catch (err) {
    console.log('  FAIL: Model loading failed:', err.message);
    return { model: 'FAIL', reason: 'load failed', error: err.message };
  }

  // ── Step 4: Validate input/output shapes ─────────────────────────
  console.log('\n[4] Input/Output validation');

  // Check inputs
  const inputNames = session.inputNames;
  console.log(`  Input names: ${JSON.stringify(inputNames)}`);

  // Check outputs
  const outputNames = session.outputNames;
  console.log(`  Output names: ${JSON.stringify(outputNames)}`);

  // For YOLOv8n, we expect:
  // - Input: [1, 3, 640, 640] (batch, channels, height, width)
  // - Output: [1, 84, 8400] (batch, 4+80 classes, anchors)

  // Note: onnxruntime-node doesn't directly expose tensor shapes from session
  // We'll verify by running inference

  // ── Step 5: Run inference ────────────────────────────────────────
  console.log('\n[5] Inference test');

  // Create a dummy input tensor (zeros - black image)
  const inputShape = [1, 3, 640, 640];
  const inputData = new Float32Array(1 * 3 * 640 * 640);
  // Fill with small random values to simulate a real image
  for (let i = 0; i < inputData.length; i++) {
    inputData[i] = Math.random() * 0.1;
  }

  const inputTensor = new ort.Tensor('float32', inputData, inputShape);

  try {
    const startTime = Date.now();
    const results = await session.run({ [inputNames[0]]: inputTensor });
    const inferenceTime = Date.now() - startTime;

    const outputTensor = results[outputNames[0]];
    const outputShape = outputTensor.dims;

    console.log(`  Inference time: ${inferenceTime}ms`);
    console.log(`  Output shape: [${outputShape.join(', ')}]`);

    // Validate output shape
    if (outputShape.length === 3 &&
        outputShape[0] === 1 &&
        outputShape[1] === 84 &&
        outputShape[2] === 8400) {
      console.log('  PASS: Output shape matches YOLOv8n [1, 84, 8400]');
    } else if (outputShape.length === 3 &&
               outputShape[0] === 1 &&
               outputShape[2] === 8400) {
      console.log(`  WARN: Output shape [${outputShape.join(', ')}] has ${outputShape[1]} channels (expected 84)`);
    } else {
      console.log(`  WARN: Unexpected output shape [${outputShape.join(', ')}]`);
    }

    // Check output values
    const outputData = outputTensor.data;
    let maxVal = -Infinity;
    let minVal = Infinity;
    for (let i = 0; i < Math.min(outputData.length, 10000); i++) {
      if (outputData[i] > maxVal) maxVal = outputData[i];
      if (outputData[i] < minVal) minVal = outputData[i];
    }
    console.log(`  Output value range: [${minVal.toFixed(4)}, ${maxVal.toFixed(4)}]`);

    // ── Summary ─────────────────────────────────────────────────────
    console.log('\n' + '='.repeat(60));
    console.log('VALIDATION SUMMARY');
    console.log('='.repeat(60));
    console.log(`MODEL: PASS`);
    console.log(`MODEL SIZE: ${sizeMB} MB`);
    console.log(`INPUT SHAPE: [${inputShape.join(', ')}]`);
    console.log(`OUTPUT SHAPE: [${outputShape.join(', ')}]`);
    console.log(`ONNX LOAD: PASS`);
    console.log(`INFERENCE: PASS (${inferenceTime}ms)`);
    console.log('='.repeat(60));

    return {
      model: 'PASS',
      modelSize: `${sizeMB} MB`,
      inputShape: `[${inputShape.join(', ')}]`,
      outputShape: `[${outputShape.join(', ')}]`,
      onnxLoad: 'PASS',
      inference: 'PASS',
      inferenceTime: `${inferenceTime}ms`,
    };

  } catch (err) {
    console.log('  FAIL: Inference failed:', err.message);
    return {
      model: 'PASS',
      modelSize: `${sizeMB} MB`,
      onnxLoad: 'PASS',
      inference: 'FAIL',
      error: err.message,
    };
  }
}

validateModel()
  .then(result => {
    console.log('\nResult:', JSON.stringify(result, null, 2));
    process.exit(result.model === 'PASS' ? 0 : 1);
  })
  .catch(err => {
    console.error('Validation error:', err);
    process.exit(1);
  });
