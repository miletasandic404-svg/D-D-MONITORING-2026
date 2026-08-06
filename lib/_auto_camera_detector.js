// =========================================================
// Auto-Camera Detector
//
// Pronalazi kameru po IP adresi i automatski pronalazi:
// - Model kamere
// - Vendor
// - Default kredencijale
// - RTSP putanju koja radi
// =========================================================

const http = require('http');
const https = require('https');
const { detectCameraByMac, detectCameraByHttpResponse, getRtspPathsForVendor, getDefaultCredentialsForVendor, getOnvifPortForVendor } = require('./_camera_models_database');
const { probeRtspUrl } = require('./_rtsp_probe');
const { discoverCamera } = require('./_onvif_client');

/**
 * Pronalazi MAC adresu kamere preko ARP
 * @param {string} ipAddress - IP adresa kamere
 * @returns {Promise<string|null>} MAC adresa ili null
 */
async function discoverMacAddress(ipAddress) {
  return new Promise((resolve) => {
    const command = process.platform === 'win32'
      ? `arp -a ${ipAddress}`
      : `arp -n ${ipAddress}`;
    
    const { exec } = require('child_process');
    exec(command, (error, stdout) => {
      if (error) {
        resolve(null);
        return;
      }
      const macMatch = stdout.match(/([0-9A-Fa-f]{2}[:-]){5}([0-9A-Fa-f]{2})/);
      resolve(macMatch ? macMatch[0] : null);
    });
  });
}

/**
 * Pronalazi HTTP header-e kamere
 * @param {string} ipAddress - IP adresa kamere
 * @param {number} port - Port (80, 8080, itd)
 * @returns {Promise<object|null>} Headers ili null
 */
async function probeHttpHeaders(ipAddress, port = 80) {
  return new Promise((resolve) => {
    const options = {
      hostname: ipAddress,
      port,
      path: '/',
      method: 'GET',
      timeout: 3000,
    };

    const req = http.request(options, (res) => {
      let body = '';
      res.on('data', chunk => body += chunk);
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: body.substring(0, 500),
        });
      });
    });

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });

    req.end();
  });
}

/**
 * GLAVNI DETCTOR - Pronalazi kameru po IP adresi
 * @param {string} ipAddress - IP adresa kamere
 * @returns {Promise<object>} Detekti rezultat
 */
async function autoDetectCamera(ipAddress) {
  console.log(`[auto-detector] Počeo detekt za: ${ipAddress}`);

  const result = {
    success: false,
    ip: ipAddress,
    detected_vendor: null,
    detection_method: null,
    model_guess: null,
    default_credentials: null,
    rtsp_url_working: null,
    rtsp_candidates: [],
    error: null,
  };

  try {
    // ===== STEP 1: Pronađi MAC adresu =====
    console.log(`[auto-detector] Pronalaženje MAC adrese...`);
    const macAddress = await discoverMacAddress(ipAddress);
    
    if (macAddress) {
      console.log(`[auto-detector] MAC adresa: ${macAddress}`);
      const vendorByMac = detectCameraByMac(macAddress);
      if (vendorByMac) {
        result.detected_vendor = vendorByMac.vendor_key;
        result.detection_method = 'MAC_PREFIX';
        result.model_guess = vendorByMac.name;
        console.log(`[auto-detector] ✅ Pronašao vendor po MAC-u: ${vendorByMac.name}`);
      }
    }

    // ===== STEP 2: Pronađi HTTP response =====
    if (!result.detected_vendor) {
      console.log(`[auto-detector] Pronalaženje HTTP response-a...`);
      const commonPorts = [80, 8080, 8000, 8888, 8899];
      
      for (const port of commonPorts) {
        const httpProbe = await probeHttpHeaders(ipAddress, port);
        if (httpProbe && httpProbe.status === 200) {
          console.log(`[auto-detector] HTTP pronašao port: ${port}`);
          const vendorByHttp = detectCameraByHttpResponse(httpProbe.headers, httpProbe.body);
          if (vendorByHttp) {
            result.detected_vendor = vendorByHttp.vendor_key;
            result.detection_method = 'HTTP_HEADERS';
            result.model_guess = vendorByHttp.name;
            console.log(`[auto-detector] ✅ Pronašao vendor po HTTP-u: ${vendorByHttp.name}`);
            break;
          }
        }
      }
    }

    // ===== STEP 3: Pronađi ONVIF =====
    if (!result.detected_vendor) {
      console.log(`[auto-detector] Pronalaženje ONVIF-a...`);
      try {
        const onvifInfo = await discoverCamera(ipAddress, 8080, null, null);
        if (onvifInfo) {
          result.detected_vendor = 'onvif_detected';
          result.detection_method = 'ONVIF';
          result.model_guess = `${onvifInfo.manufacturer} ${onvifInfo.model}`;
          console.log(`[auto-detector] ✅ ONVIF pronašao: ${result.model_guess}`);
        }
      } catch (e) {
        console.log(`[auto-detector] ONVIF nije dostupan`);
      }
    }

    // ===== STEP 4: Pronađi RTSP putanju =====
    console.log(`[auto-detector] Pronalaženje RTSP putanje...`);
    
    const vendor_key = result.detected_vendor || 'generic';
    const rtspPaths = getRtspPathsForVendor(vendor_key);
    const credentials = getDefaultCredentialsForVendor(vendor_key);
    result.default_credentials = credentials;

    // Testiraj RTSP putanje
    for (const path of rtspPaths) {
      const rtspUrl = `rtsp://${credentials.username}:${credentials.password}@${ipAddress}:554${path}`;
      
      try {
        const probeResult = await Promise.race([
          probeRtspUrl(rtspUrl),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('Timeout')), 4000)
          ),
        ]);

        result.rtsp_candidates.push({
          path,
          url: rtspUrl,
          status: probeResult.success ? 'OK' : 'FAILED',
        });

        if (probeResult.success) {
          result.rtsp_url_working = rtspUrl;
          result.success = true;
          console.log(`[auto-detector] ✅ RTSP pronašao: ${path}`);
          break;
        }
      } catch (e) {
        result.rtsp_candidates.push({
          path,
          url: rtspUrl,
          status: 'TIMEOUT',
        });
      }
    }

    if (!result.success) {
      result.error = 'Nije pronašao radnu RTSP putanju. Pokušajte sa drugim kredencijalima.';
    }

  } catch (error) {
    result.error = error.message;
    console.error(`[auto-detector] GREŠKA:`, error.message);
  }

  console.log(`[auto-detector] Rezultat:`, JSON.stringify(result, null, 2));
  return result;
}

module.exports = {
  autoDetectCamera,
  discoverMacAddress,
  probeHttpHeaders,
};
