'use strict';

/**
 * Xiongmai OPTalk Two-Way Audio Adapter
 * 
 * Clean implementation of OPTalk protocol for Xiongmai DVRIP cameras.
 * 
 * Protocol sequence (verified on 192.168.1.3):
 * 1. Login (1000/1001) - via existing DVRIP
 * 2. Claim (1434/1435) - reserve talk channel
 * 3. Start (1430/1431) - activate talk session
 * 4. Audio (1432) - send G.711 A-law audio data
 * 5. Stop (1430) - deactivate talk session
 * 
 * Audio format (from protocol docs):
 * - Codec: G.711 A-law
 * - Sample rate: 8 kHz
 * - Frame size: 320 bytes (~40ms)
 * - Channels: mono
 */

const net = require('net');
const crypto = require('crypto');

// DVRIP Message IDs
const MSG_LOGIN = 1000;
const MSG_LOGIN_RESPONSE = 1001;
const MSG_OPTALK_CLAIM = 1434;
const MSG_OPTALK_CLAIM_RESPONSE = 1435;
const MSG_OPTALK_START = 1430;
const MSG_OPTALK_START_RESPONSE = 1431;
const MSG_OPTALK_AUDIO = 1432;
const MSG_OPTALK_AUDIO_RESPONSE = 1433;

const DVRIP_PORT = 34567;
const TIMEOUT_MS = 5000;

/**
 * Sofia hash for DVRIP authentication
 */
function sofiaHash(password) {
  const md5 = crypto.createHash('md5').update(password, 'utf8').digest();
  const chars = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';
  let out = '';
  for (let i = 0; i < 8; i++) out += chars[(md5[2 * i] + md5[2 * i + 1]) % 62];
  return out;
}

/**
 * Build V5.00 DVRIP frame (20-byte header + JSON + \n\0)
 */
function buildJsonFrame(msgId, jsonObj, sessionId = 0) {
  const body = Buffer.from(JSON.stringify(jsonObj), 'utf8');
  const h = Buffer.alloc(20);
  h[0] = 0xFF;
  h[1] = 0x00; // V5.00 request type
  h.writeUInt32LE(sessionId >>> 0, 4); // session ID (unsigned)
  h.writeUInt32LE(0, 8); // sequence
  h.writeUInt16LE(msgId, 14);
  h.writeUInt32LE(body.length + 2, 16); // + \n \0
  return Buffer.concat([h, body, Buffer.from([0x0A, 0x00])]);
}

/**
 * Build binary frame (for audio data)
 */
function buildBinaryFrame(msgId, sessionId, data) {
  const h = Buffer.alloc(20);
  h[0] = 0xFF;
  h[1] = 0x00;
  h.writeUInt32LE(sessionId >>> 0, 4);
  h.writeUInt32LE(0, 8);
  h.writeUInt16LE(msgId, 14);
  h.writeUInt32LE(data.length, 16);
  return Buffer.concat([h, data]);
}

/**
 * Parse V5.00 JSON response
 */
function parseJsonResponse(data, expectedMsgId) {
  if (data.length < 20) {
    throw new Error('Response too short');
  }
  const msgId = data.readUInt16LE(14);
  const len = data.readUInt32LE(16);
  if (data.length < 20 + len) {
    throw new Error('Response payload incomplete');
  }
  if (msgId !== expectedMsgId) {
    throw new Error(`Expected msg ${expectedMsgId}, got ${msgId}`);
  }
  const body = data.subarray(20, 20 + len).toString('utf8').replace(/[\n\x00]*$/, '');
  const json = JSON.parse(body);
  return { 
    Ret: json.Ret, 
    SessionID: json.SessionID ? parseInt(json.SessionID, 16) : 0,
    success: json.Ret === 100 
  };
}

/**
 * Build G.711 A-law frame from PCM
 */
function linearToAlaw(sample) {
  if (sample > 32767) sample = 32767;
  if (sample < -32768) sample = -32767;
  const sign = (sample >> 8) & 0x80;
  if (sign !== 0) sample = -sample;
  let exp = 0;
  let mag = sample;
  if (mag > 0) {
    while (mag > 15 && exp < 7) { mag >>= 1; exp++; }
  }
  const mantissa = mag & 0x0F;
  const compressed = ((exp << 4) | mantissa) ^ 0x55;
  return (sign === 0) ? (compressed | 0x80) : compressed;
}

function pcmToAlaw(pcmData) {
  const alawData = Buffer.alloc(pcmData.length / 2);
  for (let i = 0; i < pcmData.length; i += 2) {
    const sample = pcmData.readInt16LE(i);
    alawData[i / 2] = linearToAlaw(sample);
  }
  return alawData;
}

/**
 * OPTalk Two-Way Audio Adapter
 */
class OptalkAudioAdapter {
  constructor(ip, port = DVRIP_PORT) {
    this.ip = ip;
    this.port = port;
    this.socket = null;
    this.sessionId = 0;
    this.isAuthenticated = false;
    this.isTalkActive = false;
    this._cleanupFns = [];
  }

  /**
   * Connect and login to camera
   */
  async login(username, password) {
    return new Promise((resolve, reject) => {
      this.socket = new net.Socket();
      let responseData = Buffer.alloc(0);
      
      const cleanup = () => {
        this.socket.removeAllListeners('data');
        this.socket.removeAllListeners('error');
        clearTimeout(timeout);
      };
      this._cleanupFns.push(cleanup);
      
      const timeout = setTimeout(() => {
        cleanup();
        this.socket.destroy();
        reject(new Error('Login timeout'));
      }, TIMEOUT_MS);
      
      this.socket.on('data', (data) => {
        responseData = Buffer.concat([responseData, data]);
        try {
          const resp = parseJsonResponse(responseData, MSG_LOGIN_RESPONSE);
          cleanup();
          if (resp.success) {
            this.isAuthenticated = true;
            this.sessionId = resp.SessionID;
            this.socket.removeAllListeners('data');
            resolve({ success: true, sessionId: this.sessionId });
          } else {
            this.socket.destroy();
            reject(new Error(`Login failed: Ret=${resp.Ret}`));
          }
        } catch (err) {
          if (!err.message.includes('too short') && !err.message.includes('incomplete')) {
            cleanup();
            this.socket.destroy();
            reject(err);
          }
        }
      });
      
      this.socket.on('error', (err) => {
        cleanup();
        reject(new Error(`Connection error: ${err.message}`));
      });
      
      this.socket.connect(this.port, this.ip, () => {
        const loginMsg = buildJsonFrame(MSG_LOGIN, {
          EncryptType: 'MD5',
          LoginType: 'DVRIP-Web',
          PassWord: sofiaHash(password),
          UserName: username
        }, 0);
        this.socket.write(loginMsg);
      });
    });
  }

  /**
   * Step 2: Claim OPTalk channel
   */
  async claimTalk() {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated');
    }
    return new Promise((resolve, reject) => {
      let responseData = Buffer.alloc(0);
      
      const cleanup = () => {
        this.socket.removeAllListeners('data');
        this.socket.removeAllListeners('error');
        clearTimeout(timeout);
      };
      
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Claim timeout'));
      }, TIMEOUT_MS);
      
      this.socket.on('data', (data) => {
        responseData = Buffer.concat([responseData, data]);
        try {
          const resp = parseJsonResponse(responseData, MSG_OPTALK_CLAIM_RESPONSE);
          cleanup();
          if (resp.success) {
            resolve({ success: true });
          } else {
            reject(new Error(`Claim failed: Ret=${resp.Ret}`));
          }
        } catch (err) {
          if (!err.message.includes('too short') && !err.message.includes('incomplete')) {
            cleanup();
            reject(err);
          }
        }
      });
      
      this.socket.on('error', (err) => {
        cleanup();
        reject(new Error(`Socket error: ${err.message}`));
      });
      
      // Send Claim (1434) with SessionID
      const claimMsg = buildJsonFrame(MSG_OPTALK_CLAIM, {}, this.sessionId);
      this.socket.write(claimMsg);
    });
  }

  /**
   * Step 3: Start OPTalk session
   */
  async startTalk() {
    if (!this.isAuthenticated) {
      throw new Error('Not authenticated');
    }
    return new Promise((resolve, reject) => {
      let responseData = Buffer.alloc(0);
      
      const cleanup = () => {
        this.socket.removeAllListeners('data');
        this.socket.removeAllListeners('error');
        clearTimeout(timeout);
      };
      
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error('Start timeout'));
      }, TIMEOUT_MS);
      
      this.socket.on('data', (data) => {
        responseData = Buffer.concat([responseData, data]);
        
        try {
          const resp = parseJsonResponse(responseData, MSG_OPTALK_START_RESPONSE);
          cleanup();
          if (resp.success) {
            this.isTalkActive = true;
            resolve({ success: true });
          } else {
            reject(new Error(`Start failed: Ret=${resp.Ret}`));
          }
        } catch (err) {
          if (err.message.includes(`got ${MSG_OPTALK_AUDIO_RESPONSE}`)) {
            this.isTalkActive = true;
            cleanup();
            resolve({ success: true });
          } else if (!err.message.includes('too short') && !err.message.includes('incomplete')) {
            cleanup();
            reject(err);
          }
        }
      });
      
      this.socket.on('error', (err) => {
        cleanup();
        reject(new Error(`Socket error: ${err.message}`));
      });
      
      // Send Start (1430) with verified payload
      const startPayload = {
        Name: 'OPTalk',
        OPTalk: {
          Action: 'Start',
          Parameter: {
            Channel: 0,
            TransMode: 'TCP'
          }
        }
      };
      const startMsg = buildJsonFrame(MSG_OPTALK_START, startPayload, this.sessionId);
      this.socket.write(startMsg);
    });
  }

  /**
   * Step 4: Send audio frame
   */
  async sendAudio(pcmBuffer) {
    if (!this.isTalkActive) {
      throw new Error('Talk not active');
    }
    if (!this.socket || this.socket.destroyed) {
      throw new Error('Socket closed');
    }

    const alawData = pcmToAlaw(pcmBuffer);
    const audioMsg = buildBinaryFrame(MSG_OPTALK_AUDIO, this.sessionId, alawData);

    if (!this.socket.write(audioMsg)) {
      await new Promise((resolve, reject) => {
        const onDrain = () => {
          this.socket.removeListener('error', onError);
          this.socket.removeListener('close', onClose);
          resolve();
        };
        const onError = (err) => {
          this.socket.removeListener('drain', onDrain);
          this.socket.removeListener('close', onClose);
          reject(new Error(`Socket error: ${err.message}`));
        };
        const onClose = () => {
          this.socket.removeListener('drain', onDrain);
          this.socket.removeListener('error', onError);
          reject(new Error('Socket closed while writing'));
        };
        this.socket.once('drain', onDrain);
        this.socket.once('error', onError);
        this.socket.once('close', onClose);
      });
    }
  }

  /**
   * Step 5: Stop OPTalk session
   */
  async stopTalk() {
    if (!this.isTalkActive) {
      return;
    }
    
    // Send Stop message (same as Start but with Action: 'Stop')
    const stopPayload = {
      Name: 'OPTalk',
      OPTalk: {
        Action: 'Stop',
        Parameter: {
          Channel: 0,
          TransMode: 'TCP'
        }
      }
    };
    const stopMsg = buildJsonFrame(MSG_OPTALK_START, stopPayload, this.sessionId);
    this.socket.write(stopMsg);
    this.isTalkActive = false;
  }

  /**
   * Full sequence: login + claim + start
   */
  async openSession(username, password) {
    await this.login(username, password);
    await this.claimTalk();
    await this.startTalk();
    return { success: true, sessionId: this.sessionId };
  }

  /**
   * Close session and cleanup
   */
  close() {
    // Run cleanup functions
    for (const fn of this._cleanupFns) {
      try { fn(); } catch {}
    }
    this._cleanupFns = [];
    
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.isAuthenticated = false;
    this.isTalkActive = false;
    this.sessionId = 0;
  }
}

module.exports = {
  OptalkAudioAdapter,
  // Export constants for testing
  MSG_LOGIN,
  MSG_LOGIN_RESPONSE,
  MSG_OPTALK_CLAIM,
  MSG_OPTALK_CLAIM_RESPONSE,
  MSG_OPTALK_START,
  MSG_OPTALK_START_RESPONSE,
  MSG_OPTALK_AUDIO,
  MSG_OPTALK_AUDIO_RESPONSE,
  // Export builders for testing
  buildJsonFrame,
  buildBinaryFrame,
  pcmToAlaw,
  linearToAlaw,
  // Constants
  DVRIP_PORT,
  TIMEOUT_MS,
};
