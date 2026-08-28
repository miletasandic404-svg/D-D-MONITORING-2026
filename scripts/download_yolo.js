#!/usr/bin/env node
'use strict';

/**
 * Download YOLOv8n ONNX model using Node.js https module.
 * Tries multiple sources to find a compatible detection model.
 */

const https = require('https');
const http = require('http');
const fs = require('fs');
const path = require('path');

const OUTPUT_PATH = path.join(__dirname, '..', 'models', 'yolov8n.onnx');

// Sources to try (in order of preference)
const SOURCES = [
  {
    name: 'HuggingFace Kalray/yolov8 (YOLOv8n detection)',
    url: 'https://huggingface.co/Kalray/yolov8/resolve/main/yolov8n.onnx?download=true',
  },
  {
    name: 'HuggingFace SpotLab/YOLOv8Detection',
    url: 'https://huggingface.co/SpotLab/YOLOv8Detection/resolve/3005c6751fb19cdeb6b10c066185908faf66a097/yolov8n.onnx?download=true',
  },
  {
    name: 'Ultralytics GitHub (v8.2.0)',
    url: 'https://github.com/ultralytics/assets/releases/download/v8.2.0/yolov8n.onnx',
  },
  {
    name: 'Ultralytics GitHub (v0.0.0)',
    url: 'https://github.com/ultralytics/assets/releases/download/v0.0.0/yolov8n.onnx',
  },
  {
    name: 'HuggingFace AXERA-TECH (may be different format)',
    url: 'https://huggingface.co/AXERA-TECH/YOLOv8/resolve/main/yolov8n_640x640.onnx',
  },
];

function downloadFile(url, outputPath) {
  return new Promise((resolve, reject) => {
    const protocol = url.startsWith('https') ? https : http;

    const request = protocol.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (response) => {
      // Handle redirects
      if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
        console.log(`  Redirect: ${response.headers.location}`);
        downloadFile(response.headers.location, outputPath)
          .then(resolve)
          .catch(reject);
        return;
      }

      if (response.statusCode !== 200) {
        reject(new Error(`HTTP ${response.statusCode}`));
        return;
      }

      const fileStream = fs.createWriteStream(outputPath);
      response.pipe(fileStream);

      fileStream.on('finish', () => {
        fileStream.close();
        resolve();
      });

      fileStream.on('error', (err) => {
        fs.unlink(outputPath, () => {});
        reject(err);
      });
    });

    request.on('error', (err) => {
      reject(err);
    });

    // Timeout
    request.setTimeout(120000, () => {
      request.destroy();
      reject(new Error('Request timeout'));
    });
  });
}

async function main() {
  console.log('YOLOv8n ONNX Model Download');
  console.log('='.repeat(50));

  // Ensure models directory exists
  const modelsDir = path.dirname(OUTPUT_PATH);
  if (!fs.existsSync(modelsDir)) {
    fs.mkdirSync(modelsDir, { recursive: true });
  }

  for (const source of SOURCES) {
    console.log(`\nTrying: ${source.name}`);
    console.log(`  URL: ${source.url}`);

    try {
      await downloadFile(source.url, OUTPUT_PATH);

      const stats = fs.statSync(OUTPUT_PATH);
      const sizeMB = (stats.size / (1024 * 1024)).toFixed(2);
      console.log(`  Downloaded: ${sizeMB} MB`);

      // Check if it's a valid ONNX file (not HTML)
      const fd = fs.openSync(OUTPUT_PATH, 'r');
      const buffer = Buffer.alloc(8);
      fs.readSync(fd, buffer, 0, 8, 0);
      fs.closeSync(fd);

      if (buffer[0] === 0x08) {
        console.log('  Valid ONNX header detected');
        console.log('\n' + '='.repeat(50));
        console.log('DOWNLOAD SUCCESS');
        console.log(`Source: ${source.name}`);
        console.log(`Size: ${sizeMB} MB`);
        console.log(`Path: ${OUTPUT_PATH}`);
        return;
      } else {
        console.log('  Invalid file (not ONNX)');
        fs.unlinkSync(OUTPUT_PATH);
      }
    } catch (err) {
      console.log(`  Failed: ${err.message}`);
      // Clean up partial download
      try { fs.unlinkSync(OUTPUT_PATH); } catch {}
    }
  }

  console.log('\n' + '='.repeat(50));
  console.log('ALL DOWNLOAD SOURCES FAILED');
  console.log('Please manually download YOLOv8n ONNX from:');
  console.log('  https://github.com/ultralytics/assets/releases');
  process.exit(1);
}

main();
