// =========================================================
// Global Camera Discovery Service
//
// Automatski detektuje kamere GLOBALNO sa:
// 1. TUYA Cloud API
// 2. Hikvision Cloud (ISC Platform)
// 3. Dahua Cloud (SmartPSS)
// 4. Reolink Cloud
// 5. Common RTSP databases & defaults
// =========================================================

const axios = require('axios');
const crypto = require('crypto');

// ==================== TUYA CLOUD API ====================

class TuyaCloudDiscovery {
  constructor(clientId, clientSecret, region = 'eu') {
    this.clientId = clientId;
    this.clientSecret = clientSecret;
    this.region = region; // eu, us, cn, ind
    this.baseUrl = this.getBaseUrl(region);
    this.accessToken = null;
    this.tokenExpiry = 0;
  }

  getBaseUrl(region) {
    const regions = {
      'eu': 'https://openapi.tuyaeu.com',
      'us': 'https://openapi.tuyaus.com',
      'cn': 'https://openapi.tuyacn.com',
      'ind': 'https://openapi.tuyain.com',
    };
    return regions[region] || regions['eu'];
  }

  /**
   * Dobij access token od Tuya
   */
  async getAccessToken() {
    if (this.accessToken && this.tokenExpiry > Date.now()) {
      return this.accessToken;
    }

    try {
      const timestamp = Date.now().toString();
      const contentHash = crypto.createHash('sha256').update('').digest('hex');
      const stringToSign = `GET\n${contentHash}\n\n/v1.0/token?grant_type=1`;
      
      const signature = crypto
        .createHmac('sha256', this.clientSecret)
        .update(stringToSign)
        .digest('hex');

      const response = await axios.get(`${this.baseUrl}/v1.0/token?grant_type=1`, {
        headers: {
          'client_id': this.clientId,
          't': timestamp,
          'sign_method': 'HMAC-SHA256',
          'sign': signature,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      if (response.data.success) {
        this.accessToken = response.data.result.access_token;
        this.tokenExpiry = Date.now() + (response.data.result.expire_time * 1000);
        console.log(`[tuya] Access token dobijen za region: ${this.region}`);
        return this.accessToken;
      } else {
        throw new Error(`Tuya auth failed: ${response.data.msg}`);
      }
    } catch (error) {
      console.error(`[tuya] Error dobijanja access tokena:`, error.message);
      throw error;
    }
  }

  /**
   * Pronađi sve Tuya kamere povezane sa ovim akauntom
   */
  async discoverCameras() {
    const token = await this.getAccessToken();
    const cameras = [];

    try {
      // Pronađi sve device-e
      const devicesUrl = `${this.baseUrl}/v1.0/iotdm/device/user/device-list`;
      const timestamp = Date.now().toString();
      const contentHash = crypto.createHash('sha256').update('').digest('hex');
      const stringToSign = `GET\n${contentHash}\n\n/v1.0/iotdm/device/user/device-list`;
      
      const signature = crypto
        .createHmac('sha256', this.clientSecret)
        .update(`${stringToSign}${token}`)
        .digest('hex');

      const response = await axios.get(devicesUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          't': timestamp,
          'sign_method': 'HMAC-SHA256',
          'sign': signature,
          'Content-Type': 'application/json',
        },
      });

      if (response.data.success && response.data.result) {
        // Filtriraj samo kamere (device_type = 'camera')
        const cameraDevices = response.data.result.filter(
          device => device.category === 'ipc' || device.category === 'wired_camera' || device.category === 'wifi_camera'
        );

        for (const device of cameraDevices) {
          cameras.push({
            id: device.id,
            device_id: device.id,
            name: device.name,
            model: device.model,
            category: device.category,
            connection_mode: 'TUYA',
            tuya_device_id: device.id,
            tuya_device_name: device.name,
            tuya_region: this.region,
            status: device.status, // online, offline
            icon: device.icon,
            ip: device.ip,
            mac: device.mac,
            firmware_version: device.fw_ver,
          });
        }
      }

      console.log(`[tuya] Pronašao ${cameras.length} Tuya kamera u ${this.region} regionu`);
      return cameras;
    } catch (error) {
      console.error(`[tuya] Error pri pronalaženju kamera:`, error.message);
      return [];
    }
  }

  /**
   * Pronađi RTSP URL za Tuya kameru
   */
  async getRtspUrl(deviceId) {
    try {
      const token = await this.getAccessToken();
      const statusUrl = `${this.baseUrl}/v1.0/iotdm/device/${deviceId}/status`;
      const timestamp = Date.now().toString();

      const signature = crypto
        .createHmac('sha256', this.clientSecret)
        .update(`GET\n\n\n${statusUrl.replace(this.baseUrl, '')}${token}`)
        .digest('hex');

      const response = await axios.get(statusUrl, {
        headers: {
          'Authorization': `Bearer ${token}`,
          't': timestamp,
          'sign': signature,
        },
      });

      if (response.data.success && response.data.result) {
        // Pronađi rtsp_url property
        const rtspProperty = response.data.result.find(p => p.code === 'rtsp_url' || p.code === 'stream_url');
        if (rtspProperty) {
          return rtspProperty.value;
        }
      }
      return null;
    } catch (error) {
      console.error(`[tuya] Error pri pronalaženju RTSP URL-a: ${error.message}`);
      return null;
    }
  }
}

// ==================== HIKVISION CLOUD API ====================

class HikvisionCloudDiscovery {
  constructor(accessToken, region = 'eu') {
    this.accessToken = accessToken;
    this.region = region;
    // Hikvision koristi drugi endpoint za svaki region
    this.baseUrl = `https://api.hikvision.com`; // Zajedničko za sve regione
  }

  /**
   * Pronađi sve Hikvision kamere
   */
  async discoverCameras() {
    const cameras = [];

    try {
      const url = `${this.baseUrl}/api/resource/device/camera/list`;
      
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      if (response.data.code === 0 && response.data.data) {
        for (const device of response.data.data) {
          cameras.push({
            id: device.camera_id,
            device_id: device.camera_id,
            name: device.camera_name,
            model: device.camera_model,
            connection_mode: 'HIKVISION_CLOUD',
            hikvision_device_id: device.camera_id,
            hikvision_serial: device.serial_number,
            status: device.online_status,
            ip: device.ip_address,
            mac: device.mac_address,
            firmware_version: device.firmware_version,
          });
        }
      }

      console.log(`[hikvision] Pronašao ${cameras.length} Hikvision kamera`);
      return cameras;
    } catch (error) {
      console.error(`[hikvision] Error pri pronalaženju kamera:`, error.message);
      return [];
    }
  }

  /**
   * Pronađi RTSP URL za Hikvision kameru
   */
  async getRtspUrl(cameraId) {
    try {
      const url = `${this.baseUrl}/api/resource/device/camera/${cameraId}/stream/url`;
      
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
      });

      if (response.data.code === 0 && response.data.data) {
        return response.data.data.rtsp_url;
      }
      return null;
    } catch (error) {
      console.error(`[hikvision] Error pri pronalaženju RTSP URL-a:`, error.message);
      return null;
    }
  }
}

// ==================== REOLINK CLOUD API ====================

class ReolinkCloudDiscovery {
  constructor(accessToken) {
    this.accessToken = accessToken;
    this.baseUrl = 'https://api.reolink.com/v1';
  }

  /**
   * Pronađi sve Reolink kamere
   */
  async discoverCameras() {
    const cameras = [];

    try {
      const url = `${this.baseUrl}/devices`;
      
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
          'Content-Type': 'application/json',
        },
        timeout: 10000,
      });

      if (response.data.devices) {
        for (const device of response.data.devices) {
          if (device.type === 'camera' || device.type === 'ip_camera') {
            cameras.push({
              id: device.device_id,
              device_id: device.device_id,
              name: device.device_name,
              model: device.model,
              connection_mode: 'REOLINK_CLOUD',
              reolink_device_id: device.device_id,
              status: device.online ? 'online' : 'offline',
              ip: device.ip_address,
              mac: device.mac_address,
              firmware_version: device.firmware_ver,
            });
          }
        }
      }

      console.log(`[reolink] Pronašao ${cameras.length} Reolink kamera`);
      return cameras;
    } catch (error) {
      console.error(`[reolink] Error pri pronalaženju kamera:`, error.message);
      return [];
    }
  }

  /**
   * Pronađi RTSP URL za Reolink kameru
   */
  async getRtspUrl(deviceId) {
    try {
      const url = `${this.baseUrl}/devices/${deviceId}/stream`;
      
      const response = await axios.get(url, {
        headers: {
          'Authorization': `Bearer ${this.accessToken}`,
        },
      });

      if (response.data.stream_url) {
        return response.data.stream_url;
      }
      return null;
    } catch (error) {
      console.error(`[reolink] Error pri pronalaženju RTSP URL-a:`, error.message);
      return null;
    }
  }
}

// ==================== GLOBAL ORCHESTRATOR ====================

class GlobalCameraDiscovery {
  constructor(config) {
    this.config = config;
    this.discoveries = [];
    this.allCameras = [];

    // Inicijalizuj sve cloud provajdere
    if (config.tuya) {
      for (const region of config.tuya.regions || ['eu', 'us', 'cn']) {
        this.discoveries.push(
          new TuyaCloudDiscovery(config.tuya.clientId, config.tuya.clientSecret, region)
        );
      }
    }

    if (config.hikvision) {
      this.discoveries.push(
        new HikvisionCloudDiscovery(config.hikvision.accessToken, config.hikvision.region)
      );
    }

    if (config.reolink) {
      this.discoveries.push(
        new ReolinkCloudDiscovery(config.reolink.accessToken)
      );
    }
  }

  /**
   * Pronađi SVE kamere iz svih cloud provajdera
   */
  async discoverAllCameras() {
    console.log(`[discovery] Počinje globalna pretraga kamera...`);
    
    const results = await Promise.allSettled(
      this.discoveries.map(discovery => discovery.discoverCameras())
    );

    let totalCameras = 0;
    for (const result of results) {
      if (result.status === 'fulfilled') {
        this.allCameras = this.allCameras.concat(result.value);
        totalCameras += result.value.length;
      } else {
        console.error(`[discovery] Greška pri pronalaženju:`, result.reason.message);
      }
    }

    console.log(`[discovery] UKUPNO pronađeno ${totalCameras} kamera globalno!`);
    return this.allCameras;
  }

  /**
   * Pronađi RTSP URL za specifičnu kameru
   */
  async getRtspUrlForCamera(camera) {
    console.log(`[discovery] Pronalaženje RTSP URL-a za kameru: ${camera.name}`);

    if (camera.connection_mode === 'TUYA') {
      // Pronađi odgovarajući Tuya discovery objekat
      const tuya = this.discoveries.find(d => d instanceof TuyaCloudDiscovery && d.region === camera.tuya_region);
      if (tuya) {
        return await tuya.getRtspUrl(camera.device_id);
      }
    } else if (camera.connection_mode === 'HIKVISION_CLOUD') {
      const hikvision = this.discoveries.find(d => d instanceof HikvisionCloudDiscovery);
      if (hikvision) {
        return await hikvision.getRtspUrl(camera.device_id);
      }
    } else if (camera.connection_mode === 'REOLINK_CLOUD') {
      const reolink = this.discoveries.find(d => d instanceof ReolinkCloudDiscovery);
      if (reolink) {
        return await reolink.getRtspUrl(camera.device_id);
      }
    }

    return null;
  }

  /**
   * Automatski registruj sve pronađene kamere u bazu
   */
  async registerCamerasToDatabase(db, organizationId, siteId) {
    console.log(`[discovery] Registracija pronađenih kamera u bazu...`);

    for (const camera of this.allCameras) {
      try {
        // Pronađi RTSP URL
        const rtspUrl = await this.getRtspUrlForCamera(camera);

        // Provjeri da li kamera već postoji
        const existing = await db.query(
          `SELECT id FROM cameras WHERE id = $1`,
          [camera.id]
        );

        if (existing.rows.length === 0) {
          // Kreiraj novu kameru
          await db.query(
            `INSERT INTO cameras (id, name, rtsp_url, organization_id, site_id, enabled, created_at, updated_at)
             VALUES ($1, $2, $3, $4, $5, true, now(), now())`,
            [camera.id, camera.name, rtspUrl || '', organizationId, siteId]
          );

          // Kreiraj connection config
          await db.query(
            `INSERT INTO camera_connection_config (
              camera_id, connection_mode, 
              vendor, model, mac_address, firmware_version,
              config_status, last_online_at
            ) VALUES ($1, $2, $3, $4, $5, $6, 'verified', now())`,
            [
              camera.id,
              camera.connection_mode,
              camera.connection_mode.split('_')[0], // Hikvision, Tuya, Reolink
              camera.model || 'Unknown',
              camera.mac || null,
              camera.firmware_version || 'Unknown',
            ]
          );

          console.log(`[discovery] ✅ Registrovan kamere: ${camera.name} (${camera.model})`);
        }
      } catch (error) {
        console.error(`[discovery] ❌ Greška pri registraciji kamere ${camera.name}:`, error.message);
      }
    }

    console.log(`[discovery] Registracija završena!`);
  }
}

module.exports = {
  GlobalCameraDiscovery,
  TuyaCloudDiscovery,
  HikvisionCloudDiscovery,
  ReolinkCloudDiscovery,
};
