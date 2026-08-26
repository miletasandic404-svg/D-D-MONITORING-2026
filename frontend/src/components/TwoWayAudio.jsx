import React, { useState, useRef, useEffect } from 'react';

const audioApiBaseUrl = (import.meta.env.VITE_AUDIO_API_BASE_URL || '').replace(/\/$/, '');

const SAMPLE_RATE = 8000;
const FRAME_SAMPLES = 320; // 40 ms @ 8 kHz
const FRAME_BYTES = FRAME_SAMPLES * 2; // 16-bit PCM

/**
 * Two-Way Audio — camera-agnostic, auto-detecting.
 *
 * Props:
 *   cameraId       string   — camera ID (used in API paths)
 *   cameraName     string   — display name
 *   streamToken    string   — stream token from POST /api/camera-views
 *   capabilities   object   — { supported, protocol, reason, ... }
 *                            (fetched from the backend or pre-computed)
 *
 * Data flow:
 *   1. Browser captures mic via getUserMedia → AudioContext
 *   2. AudioContext resamples to 8 kHz 16-bit mono PCM
 *   3. 40 ms frames (320 samples) are base64-encoded and POSTed to
 *      the Fly.io VM's Two-Way Audio API, which forwards them to the
 *      camera's speaker via the appropriate protocol (OPTalk for DVRIP,
 *      future ONVIF/RTSP support).
 *   3. Authentication uses the same stream token issued for HLS viewing.
 */
const TwoWayAudio = ({ cameraId, cameraName, streamToken, capabilities }) => {
  const [listening, setListening] = useState(false);
  const [speaking, setSpeaking] = useState(false);
  const [volume, setVolume] = useState(50);
  const [error, setError] = useState(null);
  const [sessionActive, setSessionActive] = useState(false);

  const audioContextRef = useRef(null);
  const analyserRef = useRef(null);
  const sourceRef = useRef(null);
  const processorRef = useRef(null);
  const micStreamRef = useRef(null);
  const sendQueueRef = useRef([]);
  const sendTimerRef = useRef(null);
  const resampleStateRef = useRef(null);

  const caps = capabilities || { supported: false, reason: 'not loaded' };

  const supported = caps?.supported === true && Boolean(audioApiBaseUrl);

  // ── Linear resampler: any rate → 8 kHz, 16-bit PCM ──────────────────
  function createResampler(inputRate) {
    if (inputRate === SAMPLE_RATE) return null;
    const ratio = inputRate / SAMPLE_RATE;
    const buffer = new Float32Array(4096);
    let offset = 0;
    return {
      push(inputFrame) {
        for (let i = 0; i < inputFrame.length; i++) {
          buffer[offset++] = inputFrame[i];
          if (offset >= buffer.length) {
            const out = new Float32Array(FRAME_SAMPLES);
            for (let j = 0; j < FRAME_SAMPLES; j++) {
              const srcIdx = Math.floor(j * ratio);
              out[j] = srcIdx < buffer.length ? buffer[srcIdx] : 0;
            }
            buffer.copyWithin(0, FRAME_SAMPLES);
            offset = Math.max(0, offset - FRAME_SAMPLES);
            return out;
          }
        }
        return null;
      },
    };
  }

  // ── Send a PCM frame to the backend ─────────────────────────────────
  async function sendAudioFrame(pcmFloat32) {
    if (!audioApiBaseUrl || !streamToken || !cameraId) return;

    // Convert Float32 [-1, 1] → Int16
    const int16 = new Int16Array(pcmFloat32.length);
    for (let i = 0; i < pcmFloat32.length; i++) {
      const v = Math.max(-1, Math.min(1, pcmFloat32[i]));
      int16[i] = v < 0 ? v * 0x8000 : v * 0x7FFF;
    }

    const base64 = btoa(
      Array.from(new Uint8Array(int16.buffer))
        .map(b => String.fromCharCode(b))
        .join('')
    );

    try {
      await fetch(`${audioApiBaseUrl}/api/audio/${cameraId}/send?token=${encodeURIComponent(streamToken)}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ audio: base64 }),
      });
    } catch (err) {
      setError('Failed to send audio');
    }
  }

  // ── Start listening (capture mic) ───────────────────────────────────
  const startListening = async () => {
    if (!supported) return;
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      micStreamRef.current = stream;

      audioContextRef.current = new (window.AudioContext || window.webkitAudioContext)({
        latencyHint: 'interactive',
      });

      analyserRef.current = audioContextRef.current.createAnalyser();
      analyserRef.current.fftSize = 256;

      sourceRef.current = audioContextRef.current.createMediaStreamSource(stream);
      sourceRef.current.connect(analyserRef.current);

      const inputRate = audioContextRef.current.sampleRate;
      resampleStateRef.current = createResampler(inputRate);

      // ScriptProcessorNode for capturing audio at ~8 kHz output
      const bufferSize = 4096;
      processorRef.current = audioContextRef.current.createScriptProcessor(bufferSize, 1, 1);

      processorRef.current.onaudioprocess = (e) => {
        if (!speaking) return;
        const input = e.inputBuffer.getChannelData(0);

        if (inputRate === SAMPLE_RATE) {
          // Native 8 kHz — send frames directly
          for (let i = 0; i + FRAME_SAMPLES <= input.length; i += FRAME_SAMPLES) {
            sendAudioFrame(input.slice(i, i + FRAME_SAMPLES));
          }
        } else {
          // Resample
          const resampler = resampleStateRef.current;
          if (resampler) {
            for (let i = 0; i < input.length; i++) {
              const frame = resampler.push([input[i]]);
              if (frame) sendAudioFrame(frame);
            }
          }
        }
      };

      sourceRef.current.connect(processorRef.current);
      processorRef.current.connect(audioContextRef.current.destination);

      setListening(true);
    } catch (err) {
      setError('Microphone access denied');
    }
  };

  // ── Start speaking (push-to-talk) ───────────────────────────────────
  const startSpeaking = async () => {
    if (!listening) {
      await startListening();
    }
    if (!listening) return;

    try {
      setError(null);
      await fetch(
        `${audioApiBaseUrl}/api/audio/${cameraId}/start?token=${encodeURIComponent(streamToken)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } }
      );
      setSpeaking(true);
      setSessionActive(true);
    } catch (err) {
      setError('Failed to start talk session');
    }
  };

  const stopSpeaking = async () => {
    setSpeaking(false);
    try {
      await fetch(
        `${audioApiBaseUrl}/api/audio/${cameraId}/stop?token=${encodeURIComponent(streamToken)}`,
        { method: 'POST', headers: { 'Content-Type': 'application/json' } }
      );
    } catch (err) {
      // best-effort
    }
    setSessionActive(false);
  };

  // ── Stop listening ──────────────────────────────────────────────────
  const stopListening = () => {
    if (processorRef.current) {
      processorRef.current.disconnect();
      processorRef.current.onaudioprocess = null;
    }
    if (sourceRef.current) sourceRef.current.disconnect();
    if (audioContextRef.current) {
      audioContextRef.current.close();
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach(t => t.stop());
    }
    audioContextRef.current = null;
    analyserRef.current = null;
    sourceRef.current = null;
    processorRef.current = null;
    micStreamRef.current = null;
    setListening(false);
    setSpeaking(false);
    setSessionActive(false);
  };

  // ── Volume visualization ──────────────────────────────────────────────
  const getVolumeLevel = () => {
    if (!analyserRef.current || !listening) return 0;
    const dataArray = new Uint8Array(analyserRef.current.frequencyBinCount);
    analyserRef.current.getByteFrequencyData(dataArray);
    const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
    return Math.min((avg / 128) * 100, 100);
  };

  useEffect(() => {
    if (!listening) return;
    const id = setInterval(() => {
      const level = getVolumeLevel();
      if (level > 0) {
        // trigger re-render for volume bar
        setVolume(prev => prev);
      }
    }, 100);
    return () => clearInterval(id);
  }, [listening]);

  useEffect(() => {
    return () => {
      stopSpeaking();
      stopListening();
    };
  }, []);

  // ── Render ──────────────────────────────────────────────────────────

  if (!supported) {
    return (
      <div style={{
        padding: '1rem',
        background: 'rgba(255,80,80,.1)',
        border: '1px solid rgba(255,80,80,.3)',
        borderRadius: '12px',
        textAlign: 'center',
        color: '#ff5050',
        fontSize: '.85rem',
      }}>
        {'🔇'} Two-Way Audio not available for this camera
      </div>
    );
  }

  return (
    <div style={{
      background: 'rgba(10,18,38,.95)',
      border: '1px solid rgba(87,140,255,.18)',
      borderRadius: '16px',
      padding: '1.5rem',
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '1rem',
      }}>
        <h3 style={{ color: '#dff7ff', margin: 0 }}>
          {'🎙️'} Two-Way Audio
        </h3>
        <span style={{
          padding: '.25rem .75rem',
          borderRadius: '10px',
          fontSize: '.75rem',
          background: sessionActive ? 'rgba(0,212,80,.2)' : 'rgba(255,180,50,.2)',
          color: sessionActive ? '#00d450' : '#ffb432',
        }}>
          {sessionActive ? '● Connected' : '○ Disconnected'}
        </span>
      </div>

      {error && (
        <div style={{
          padding: '.75rem',
          background: 'rgba(255,80,80,.1)',
          borderRadius: '8px',
          color: '#ff5050',
          marginBottom: '1rem',
          fontSize: '.85rem',
        }}>
          {'⚠️'} {error}
        </div>
      )}

      <div style={{
        display: 'flex',
        gap: '1rem',
        marginBottom: '1rem',
      }}>
        {/* Listen Button */}
        <button
          onClick={listening ? stopListening : startListening}
          style={{
            flex: 1,
            padding: '1rem',
            border: 'none',
            borderRadius: '12px',
            background: listening
              ? 'linear-gradient(135deg,rgba(0,212,80,.3),rgba(0,212,80,.1))'
              : 'rgba(87,125,196,.2)',
            color: listening ? '#00d450' : '#8ab0c9',
            cursor: 'pointer',
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '.5rem',
          }}
        >
          {listening ? '🔊' : '🔇'}
          {listening ? 'Listening...' : 'Start Listen'}
        </button>

        {/* Push-to-Talk Button */}
        <button
          onMouseDown={startSpeaking}
          onMouseUp={stopSpeaking}
          onTouchStart={startSpeaking}
          onTouchEnd={stopSpeaking}
          disabled={!listening}
          style={{
            flex: 1,
            padding: '1rem',
            border: 'none',
            borderRadius: '12px',
            background: speaking
              ? 'linear-gradient(135deg,rgba(255,80,80,.4),rgba(255,80,80,.2))'
              : 'rgba(87,125,196,.2)',
            color: speaking ? '#ff5050' : '#8ab0c9',
            cursor: listening ? 'pointer' : 'not-allowed',
            opacity: listening ? 1 : 0.5,
            fontWeight: 'bold',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: '.5rem',
          }}
        >
          {speaking ? '⏹️' : '🎙️'}
          {speaking ? 'Sending...' : 'Hold to Speak'}
        </button>
      </div>

      {/* Volume Control */}
      {listening && (
        <div style={{
          padding: '1rem',
          background: 'rgba(87,125,196,.1)',
          borderRadius: '12px',
        }}>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            marginBottom: '.5rem',
            color: '#8ab0c9',
            fontSize: '.85rem',
          }}>
            <span>🔊 Volume</span>
            <span>{volume}%</span>
          </div>
          <input
            type="range"
            min="0"
            max="100"
            value={volume}
            onChange={(e) => setVolume(e.target.value)}
            style={{
              width: '100%',
              height: '8px',
              borderRadius: '4px',
              background: `linear-gradient(to right, #00d4ff ${volume}%, rgba(87,125,196,.3) ${volume}%)`,
              appearance: 'none',
              cursor: 'pointer',
            }}
          />
          <div style={{
            marginTop: '1rem',
            display: 'flex',
            alignItems: 'center',
            gap: '.5rem',
          }}>
            <span style={{ color: '#8ab0c9', fontSize: '.8rem' }}>Level:</span>
            <div style={{
              flex: 1,
              height: '20px',
              background: 'rgba(87,125,196,.2)',
              borderRadius: '4px',
              overflow: 'hidden',
              position: 'relative',
            }}>
              <div style={{
                width: `${getVolumeLevel()}%`,
                height: '100%',
                background: getVolumeLevel() > 80 ? '#ff5050' : getVolumeLevel() > 50 ? '#ffb432' : '#00d450',
                transition: 'width .1s ease',
              }} />
            </div>
          </div>
        </div>
      )}

      <p style={{
        color: '#6a8aaa',
        fontSize: '.75rem',
        marginTop: '1rem',
        textAlign: 'center',
      }}>
        {'💡'} Press and hold "Hold to Speak" while connected to transmit audio to {cameraName}
      </p>
    </div>
  );
};

export default TwoWayAudio;
