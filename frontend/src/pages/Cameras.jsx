import React, { useState, useEffect, useRef } from 'react';
import api from '../services/api';
import { useNavigate } from 'react-router-dom';
import Hls from 'hls.js';
import TwoWayAudio from '../components/TwoWayAudio';
import BackToDashboard from '../components/BackToDashboard';

const hlsBaseUrl = (import.meta.env.VITE_HLS_BASE_URL || '/hls').replace(/\/$/, '');

function buildHlsManifestUrl(cameraId, cameraHlsBaseUrl) {
  const base = (cameraHlsBaseUrl || hlsBaseUrl).replace(/\/$/, '');
  return `${base}/${cameraId}/index.m3u8`;
}

const PAGE_CSS = `
  .cameras-page { padding: 2rem; color: var(--text-primary, #e5eef7); }
  .cameras-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
  .cameras-title { font-family: 'Orbitron', sans-serif; font-size: 1.5rem; color: var(--text-primary, #dff5ff); }
  .cameras-status-online { color: var(--accent-success, #00d450); font-size: .9rem; font-weight: 600; }
  .cameras-status-offline { color: var(--accent-danger, #ff5050); font-size: .9rem; font-weight: 600; }
  .add-cam-btn { background: linear-gradient(135deg,#00d4ff,#8c4dff); color: #03101c; border: none; padding: .8rem 1.5rem; border-radius: 10px; font-family: 'Orbitron', sans-serif; font-size: .8rem; text-transform: uppercase; letter-spacing: .1em; cursor: pointer; }
  .cameras-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(300px, 1fr)); gap: 1.5rem; }
  .camera-card { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; overflow: hidden; transition: all .2s; }
  .camera-card:hover { border-color: rgba(0,212,255,.5); transform: translateY(-4px); }
  .camera-preview { height: 180px; background: #000; display: flex; align-items: center; justify-content: center; position: relative; }
  .camera-placeholder { font-size: 3rem; color: #6a8aaa; }
  .camera-status { position: absolute; top: .75rem; right: .75rem; padding: .25rem .6rem; border-radius: 10px; font-size: .7rem; font-weight: bold; }
  .status-online { background: rgba(0,212,80,.8); color: white; }
  .status-offline { background: rgba(255,80,80,.8); color: white; }
  .camera-info { padding: 1rem; }
  .camera-info h3 { font-size: 1rem; color: var(--text-primary, #dff7ff); margin-bottom: .5rem; display: flex; align-items: center; gap: .5rem; }
  .camera-meta { display: flex; flex-wrap: wrap; gap: .75rem; color: #8ab0c9; font-size: .8rem; }
  .camera-meta span { display: flex; align-items: center; gap: .25rem; }
  .camera-actions { display: flex; gap: .5rem; padding: 1rem; padding-top: 0; }
  .cam-btn { flex: 1; padding: .6rem; border: none; border-radius: 8px; font-size: .8rem; cursor: pointer; transition: all .2s; }
  .cam-btn-primary { background: linear-gradient(135deg,#00d4ff,#8c4dff); color: #03101c; font-weight: bold; }
  .cam-btn-secondary { background: rgba(87,125,196,.2); color: var(--text-primary, #dff5ff); font-weight: 600; }
  .cam-btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
  .empty-cameras { text-align: center; padding: 4rem; background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; }
  .empty-cameras h2 { color: var(--text-primary, #dff7ff); font-size: 1.15rem; margin-bottom: 1rem; }
  .empty-cameras p { color: #8ab0c9; margin-bottom: 1.5rem; }
  .add-form-panel { background: rgba(10,18,38,.95); border: 1px solid rgba(0,212,255,.3); border-radius: 16px; padding: 2rem; margin-bottom: 2rem; }
  .add-form-tabs { display: flex; gap: .5rem; margin-bottom: 1.5rem; flex-wrap: wrap; }
  .add-form-tab { padding: .5rem 1.25rem; border-radius: 8px; border: 1px solid rgba(87,125,196,.3); background: rgba(87,125,196,.1); color: #8ab0c9; cursor: pointer; font-size: .85rem; transition: all .2s; }
  .add-form-tab.active { background: rgba(0,212,255,.15); border-color: #00d4ff; color: #00d4ff; }
  .discovery-result { background: rgba(0,212,80,.08); border: 1px solid rgba(0,212,80,.25); border-radius: 12px; padding: 1.25rem; margin: 1.25rem 0; }
  .discovery-result-row { display: flex; align-items: center; gap: .6rem; padding: .3rem 0; color: #dff7ff; font-size: .9rem; }
  .discovery-result-row .check { color: #00d450; font-size: 1.1rem; }
  .scan-result-list { display: flex; flex-direction: column; gap: .75rem; margin-top: 1rem; }
  .scan-result-item { display: flex; align-items: center; justify-content: space-between; gap: 1rem; background: rgba(87,125,196,.1); border: 1px solid rgba(87,125,196,.2); border-radius: 10px; padding: .9rem 1rem; }
  .scan-result-info { flex: 1; min-width: 0; }
  .scan-result-name { color: #dff7ff; font-weight: 600; font-size: .9rem; margin-bottom: .2rem; }
  .scan-result-meta { color: #8ab0c9; font-size: .8rem; display: flex; gap: .75rem; flex-wrap: wrap; }
  .scan-result-add { flex-shrink: 0; background: linear-gradient(135deg,#00d4ff,#8c4dff); color: #03101c; border: none; padding: .5rem 1.1rem; border-radius: 8px; font-size: .8rem; font-weight: bold; cursor: pointer; white-space: nowrap; }
  .scan-result-add:disabled { opacity: .6; cursor: not-allowed; }
  .scan-result-add.added { background: rgba(0,212,80,.8); color: white; }
  .scan-notice { background: rgba(255,180,50,.08); border: 1px solid rgba(255,180,50,.2); border-radius: 10px; padding: .85rem 1rem; color: #ffb432; font-size: .85rem; margin-bottom: 1rem; }
`;

// ── Add Camera Form ────────────────────────────────────────────────────────

function AddCameraForm({ onSuccess, onCancel }) {
  // Single entry point: user picks "Discover automatically" (opens the existing
  // V3 camera wizard on the Dashboard — Scan LAN / ONVIF) or the manual RTSP form.
  // Both go through the media-node task queue (POST /api/camera-setup).
  const [addStep, setAddStep] = useState('choose'); // 'choose' | 'manual'
  const navigate = useNavigate();
  const [error, setError] = useState('');


   // Manual form state
  const [newCamera, setNewCamera] = useState({ name: '', stream_url: '', username: '', password: '', location: '', lat: '', lng: '' });
  const [saving, setSaving] = useState(false);
  const [geoLoading, setGeoLoading] = useState(false);
  const [geoError, setGeoError] = useState('');

  // Unified "Discover automatically" entry: opens the existing V3 camera wizard
  // (Dashboard), which runs Scan LAN / ONVIF through the media-node task queue.
  // Same backend (POST /api/camera-setup) — no new discovery system.
  const handleDiscoverAuto = () => {
    navigate('/dashboard?addCamera=1');
  };

  // Poll a setup task until it reaches a terminal state or times out
  const pollTask = async (taskId, timeoutMs = 60000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 2000));
      try {
        const res = await api.get(`/cameras?path=setup-get&id=${taskId}`);
        const task = res.data.task;
        if (task.status === 'done' || task.status === 'failed') return task;
      } catch { /* keep polling */ }
    }
    return { status: 'failed', error: 'Timed out waiting for the media node to respond. Ensure it is online.' };
  };

  // Map agent task failures to clear, human-readable messages.
  const friendlySetupError = (task) => {
    const msg = task?.error || 'Setup failed. Ensure your media node is online.';
    if (/authentication failed|wrong username or password/i.test(msg)) {
      return '❌ Authentication failed — wrong camera username or password.';
    }
    if (/unreachable/i.test(msg)) {
      return '❌ Camera not reachable on the network — check the IP address and that it is powered on.';
    }
    if (/already exists/i.test(msg)) {
      return '⚠️ A camera with this RTSP URL already exists in your organization.';
    }
    return msg;
  };

  // Manual RTSP add — goes through the LOCAL media node agent (preview task)
  // so the camera is verified with a real RTSP handshake (reachability +
  // authentication) BEFORE it is saved. Wrong credentials or an unreachable
  // stream fail with a clear error and nothing is saved.
  const handleManualAdd = async () => {
    if (!newCamera.name) { setError('Camera name is required'); return; }
    if (!newCamera.stream_url) { setError('RTSP stream URL is required (rtsp://...)'); return; }
    setError('');
    setSaving(true);
    try {
      const createRes = await api.post('/cameras?path=setup-create', {
        mode: 'preview',
        rtsp_url: newCamera.stream_url.trim(),
        camera_name: newCamera.name.trim(),
        username: newCamera.username || undefined,
        password: newCamera.password || undefined,
        location: newCamera.location || null,
        lat: newCamera.lat ? parseFloat(newCamera.lat) : null,
        lng: newCamera.lng ? parseFloat(newCamera.lng) : null,
      });
      const taskId = createRes.data.taskId;
      const result = await pollTask(taskId, 60000);
      if (result.status === 'done') {
        const parsed = result.result && typeof result.result === 'string'
          ? JSON.parse(result.result)
          : result.result;
        const cameraId = parsed?.camera_id;
        // The preview task registers name + stream. Preserve location/lat/lng
        // via the upsert endpoint (encrypted credentials are kept because the
        // update URL carries none).
        if (cameraId && (newCamera.location || newCamera.lat || newCamera.lng)) {
          try {
            await api.post('/cameras', {
              id: cameraId,
              name: newCamera.name,
              stream_url: newCamera.stream_url,
              location: newCamera.location || null,
              lat: newCamera.lat ? parseFloat(newCamera.lat) : null,
              lng: newCamera.lng ? parseFloat(newCamera.lng) : null,
            });
          } catch { /* location update is best-effort */ }
        }
        onSuccess({ camera_id: cameraId });
      } else {
        setError(friendlySetupError(result));
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Failed to add camera. Please try again.');
    } finally {
      setSaving(false);
    }
  };

   // Request the browser's current location and populate lat/lng.
   // Only triggered by an explicit user click — never on mount.
   const getCurrentLocation = () => {
     if (!navigator.geolocation) {
       setGeoError('Geolocation is not supported by your browser. Please enter coordinates manually.');
       return;
     }
     setGeoLoading(true);
     setGeoError('');
     navigator.geolocation.getCurrentPosition(
       (pos) => {
         setNewCamera((prev) => ({
           ...prev,
           lat: pos.coords.latitude.toFixed(6),
           lng: pos.coords.longitude.toFixed(6),
         }));
         setGeoLoading(false);
       },
       (err) => {
         setGeoLoading(false);
         if (err.code === err.PERMISSION_DENIED) {
           setGeoError('Location permission denied. Please enter coordinates manually.');
         } else if (err.code === err.TIMEOUT) {
           setGeoError('Location request timed out. Please enter coordinates manually.');
         } else {
           setGeoError('Location unavailable. Please enter coordinates manually.');
         }
       },
       { timeout: 8000 },
     );
    };

  const inputStyle = { padding: '.8rem', background: 'rgba(87,125,196,.1)', border: '1px solid rgba(87,125,196,.3)', borderRadius: '8px', color: '#dff7ff', width: '100%', boxSizing: 'border-box' };

  return (
    <div className="add-form-panel">
      <h2 style={{ fontSize: '1.15rem', color: 'var(--text-primary, #dff7ff)', marginBottom: '1.25rem' }}>Add New Camera</h2>

      {addStep === 'choose' && (
        <>
          <p style={{ color: '#8ab0c9', fontSize: '.9rem', marginBottom: '1rem' }}>
            Choose how to add your camera:
          </p>
          <div style={{ display: 'grid', gap: '.75rem', marginBottom: '1rem' }}>
            <button className="add-cam-btn" onClick={handleDiscoverAuto} style={{ padding: '1rem 1.5rem', textAlign: 'left' }}>
              🔍 Find My Camera (auto-scan)
            </button>
            <button className="cam-btn cam-btn-secondary" onClick={() => { setAddStep('manual'); setError(''); }} style={{ padding: '1rem 1.5rem', textAlign: 'left', width: '100%' }}>
              ✏️ Manual (RTSP)
            </button>
          </div>
          <p style={{ color: '#8ab0c9', fontSize: '.8rem', lineHeight: 1.5, marginBottom: '1rem' }}>
            Discover automatically scans your local network (Scan LAN / ONVIF) through the camera wizard,
            then guides you through stream selection and a live HLS preview. Manual (RTSP) lets you enter
            the stream URL directly. Both paths verify the camera with a real RTSP handshake before saving.
          </p>
        </>
      )}

      {error && <p style={{ color: '#ff5050', marginBottom: '1rem', fontSize: '.9rem' }}>{error}</p>}

      {addStep === 'manual' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem' }}>
            <input
              type="text"
              placeholder="Camera Name *"
              value={newCamera.name}
              onChange={(e) => setNewCamera({ ...newCamera, name: e.target.value })}
              style={inputStyle}
            />
            <input
              type="text"
              placeholder="RTSP Stream URL * (rtsp://ip/...)"
              value={newCamera.stream_url}
              onChange={(e) => setNewCamera({ ...newCamera, stream_url: e.target.value })}
              style={inputStyle}
            />
            <input
              type="text"
              placeholder="Username"
              value={newCamera.username}
              onChange={(e) => setNewCamera({ ...newCamera, username: e.target.value })}
              style={inputStyle}
            />
            <input
              type="password"
              placeholder="Password"
              value={newCamera.password}
              onChange={(e) => setNewCamera({ ...newCamera, password: e.target.value })}
              style={inputStyle}
            />
            <input
              type="text"
              placeholder="Location (e.g., Entrance, Parking)"
              value={newCamera.location}
              onChange={(e) => setNewCamera({ ...newCamera, location: e.target.value })}
              style={inputStyle}
            />
             <input
               type="number"
               placeholder="Latitude"
               value={newCamera.lat}
               onChange={(e) => setNewCamera({ ...newCamera, lat: e.target.value })}
               style={inputStyle}
             />
             <input
               type="number"
               placeholder="Longitude"
               value={newCamera.lng}
               onChange={(e) => setNewCamera({ ...newCamera, lng: e.target.value })}
               style={inputStyle}
             />
           </div>
           <div style={{ display: 'flex', gap: '.5rem', alignItems: 'center', marginTop: '.5rem' }}>
             <button
               type="button"
               onClick={getCurrentLocation}
               disabled={geoLoading}
               style={{
                 padding: '.5rem 1rem',
                 background: 'rgba(0,212,255,.15)',
                 border: '1px solid rgba(0,212,255,.4)',
                 borderRadius: '8px',
                 color: '#00d4ff',
                 fontSize: '.8rem',
                 cursor: geoLoading ? 'default' : 'pointer',
                 opacity: geoLoading ? 0.6 : 1,
               }}
             >
               {geoLoading ? 'Locating...' : '📍 Use my current location'}
             </button>
             {geoError && <span style={{ color: '#ffb432', fontSize: '.75rem' }}>{geoError}</span>}
           </div>
          <p style={{ color: '#8ab0c9', fontSize: '.8rem', marginTop: '.75rem' }}>
            The camera is verified with a real RTSP handshake (reachability + authentication) before it is saved. Wrong credentials are rejected with a clear error.
          </p>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
            <button className="cam-btn cam-btn-secondary" style={{ padding: '.8rem 1.5rem' }} onClick={() => { setAddStep('choose'); setError(''); }}>
              ← Back
            </button>
            <button className="add-cam-btn" onClick={handleManualAdd} disabled={saving}>
              {saving ? 'Verifying...' : '🔌 Verify & Add Camera'}
            </button>
          </div>
        </>
      )}

      <button
        className="cam-btn cam-btn-secondary"
        style={{ marginTop: '1rem', padding: '.6rem 1.5rem' }}
        onClick={onCancel}
      >
        Cancel
      </button>
    </div>
  );
}

export default function Cameras() {
  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showAddForm, setShowAddForm] = useState(false);
  const [selectedCamera, setSelectedCamera] = useState(null);
  const [editLocation, setEditLocation] = useState('');
  const [editLat, setEditLat] = useState('');
  const [editLng, setEditLng] = useState('');
  const [editError, setEditError] = useState('');
  const [editSaving, setEditSaving] = useState(false);
  useEffect(() => {
    if (selectedCamera) {
      setEditLocation(selectedCamera.location || '');
      setEditLat(selectedCamera.lat != null ? String(selectedCamera.lat) : '');
      setEditLng(selectedCamera.lng != null ? String(selectedCamera.lng) : '');
      setEditError('');
    }
  }, [selectedCamera]);
  const [streamCamera, setStreamCamera] = useState(null);
  const [streamToken, setStreamToken] = useState(null);
  const videoRef = useRef(null);
  const hlsRef = useRef(null);

  useEffect(() => {
    fetchCameras();
  }, []);

  const fetchCameras = async () => {
    try {
      const res = await api.get('/cameras');
      setCameras(res.data.cameras || []);
    } catch (err) {
      console.error('Failed to fetch cameras:', err);
    } finally {
      setLoading(false);
    }
  };

  const handleAddSuccess = () => {
    setShowAddForm(false);
    fetchCameras();
  };

  const stats = {
    total: cameras.length,
    online: cameras.filter(c => c.enabled !== false).length,
    offline: cameras.filter(c => c.enabled === false).length
  };

  const handleViewStream = async (camera) => {
    setStreamCamera(camera);
    try {
      const tokenRes = await api.post('/camera-views', { camera_id: camera.id });
      const streamToken = tokenRes.data.streamToken;
      setStreamToken(streamToken);
      const targetCamera = camera;
      setTimeout(() => {
        const video = videoRef.current;
        if (!video) return;
        const manifestUrl = `${buildHlsManifestUrl(targetCamera.id, targetCamera.hls_base_url)}?token=${encodeURIComponent(streamToken)}`;
        console.log('HLS URL:', manifestUrl);
        if (hlsRef.current) {
          hlsRef.current.destroy();
          hlsRef.current = null;
        }
        if (Hls.isSupported()) {
          const hls = new Hls({
            lowLatencyMode: true,
            liveSyncDuration: 2,
            maxBufferLength: 3,
            backBufferLength: 1,
          });
          hls.on(Hls.Events.ERROR, (_event, data) => {
            if (!data.fatal) return;
            console.error('HLS error:', data);
          });
          hls.loadSource(manifestUrl);
          hls.attachMedia(video);
          hlsRef.current = hls;
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = manifestUrl;
        }
      }, 100);
    } catch (err) {
      console.error('Failed to get stream token:', err);
    }
  };

  const handleCloseStream = () => {
    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    setStreamToken(null);
    setStreamCamera(null);
  };

  const handleSaveLocation = async () => {
    const latVal = editLat;
    const lngVal = editLng;
    if (latVal && (isNaN(parseFloat(latVal)) || parseFloat(latVal) < -90 || parseFloat(latVal) > 90)) {
      setEditError('Latitude must be between -90 and 90');
      return;
    }
    if (lngVal && (isNaN(parseFloat(lngVal)) || parseFloat(lngVal) < -180 || parseFloat(lngVal) > 180)) {
      setEditError('Longitude must be between -180 and 180');
      return;
    }
    setEditSaving(true);
    try {
      await api.post('/cameras', {
        id: selectedCamera.id,
        name: selectedCamera.name,
        location: editLocation || null,
        lat: latVal ? parseFloat(latVal) : null,
        lng: lngVal ? parseFloat(lngVal) : null,
      });
      setSelectedCamera(null);
      fetchCameras();
    } catch (e) {
      setEditError(e.response?.data?.error || 'Failed to save location');
    } finally {
      setEditSaving(false);
    }
  };

  // ── Auto-detect Two-Way Audio capability per camera type ─────────────
  function detectTwoWayAudioCapability(camera) {
    if (!camera) return { supported: false, reason: 'camera not found' };
    if (camera.connection_type === 'dvrip') {
      return {
        supported: true,
        protocol: 'optalk',
        audio_format: 'G.711 A-law',
        audio_sample_rate: 8000,
        audio_frame_size: 320,
        reason: null,
      };
    }
    return {
      supported: false,
      protocol: null,
      audio_format: null,
      audio_sample_rate: null,
      audio_frame_size: null,
      reason: 'No speaker/talkback detected for this camera type',
    };
  }

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="cameras-page">
        <BackToDashboard />
        <div className="cameras-header">
          <h1 className="cameras-title">📷 Camera Management</h1>
          <div style={{ display: 'flex', gap: '1rem', alignItems: 'center' }}>
            <span className="cameras-status-online">✓ {stats.online} Online</span>
            <span className="cameras-status-offline">✗ {stats.offline} Offline</span>
            <button className="add-cam-btn" onClick={() => setShowAddForm(true)}>+ Add Camera</button>
          </div>
        </div>

        {showAddForm && (
          <AddCameraForm
            onSuccess={handleAddSuccess}
            onCancel={() => setShowAddForm(false)}
          />
        )}

        {loading ? (
          <div className="empty-cameras"><p>Loading cameras...</p></div>
        ) : cameras.length === 0 && !showAddForm ? (
          <div className="empty-cameras">
            <h2>No Cameras Configured</h2>
            <p>Add cameras to start monitoring your security zones.</p>
            <button className="add-cam-btn" style={{ marginTop: '1rem' }} onClick={() => setShowAddForm(true)}>+ Add First Camera</button>
          </div>
        ) : (
          <div className="cameras-grid">
            {cameras.map(camera => (
              <div key={camera.id} className="camera-card">
                <div className="camera-preview">
                  <div className="camera-placeholder">📹</div>
                  <span className={`camera-status ${camera.enabled !== false ? 'status-online' : 'status-offline'}`}>
                    {camera.enabled !== false ? 'ONLINE' : 'OFFLINE'}
                  </span>
                </div>
                <div className="camera-info">
                  <h3>
                    <span>{camera.enabled !== false ? '🟢' : '🔴'}</span>
                    {camera.name}
                  </h3>
                  <div className="camera-meta">
                    <span>📍 {camera.location || 'No location'}</span>
                    {camera.fps && <span>⚡ {camera.fps} FPS</span>}
                    {camera.stream_url && <span>🔗 Stream active</span>}
                  </div>
                </div>
                <div className="camera-actions">
                  <button className="cam-btn cam-btn-secondary" onClick={() => setSelectedCamera(camera)}>Settings</button>
                  <button className="cam-btn cam-btn-primary" onClick={() => handleViewStream(camera)}>View Stream</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>

      {selectedCamera && (
        <div className="modal-overlay" onClick={() => setSelectedCamera(null)} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ background: 'rgba(10,18,38,.95)', border: '1px solid rgba(87,140,255,.3)', borderRadius: '20px', padding: '2rem', width: '100%', maxWidth: '500px', maxHeight: '80vh', overflowY: 'auto' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h2 style={{ fontFamily: "'Orbitron', sans-serif", fontSize: '1.2rem', color: '#dff5ff', margin: 0 }}>Camera Settings</h2>
              <button onClick={() => setSelectedCamera(null)} style={{ background: 'none', border: 'none', color: '#8ab0c9', fontSize: '1.5rem', cursor: 'pointer' }}>&times;</button>
            </div>
            <div style={{ display: 'grid', gap: '1rem' }}>
             <div><label style={{ color: '#8ab0c9', fontSize: '.85rem' }}>Name</label><div style={{ color: '#dff7ff', marginTop: '.25rem' }}>{selectedCamera.name}</div></div>
             <div><label style={{ color: '#8ab0c9', fontSize: '.85rem' }}>ID</label><div style={{ color: '#dff7ff', marginTop: '.25rem', fontSize: '.85rem', fontFamily: 'monospace' }}>{selectedCamera.id}</div></div>
             <div><label style={{ color: '#8ab0c9', fontSize: '.85rem' }}>Location</label><input type="text" placeholder="e.g. Front yard" value={editLocation} onChange={(e) => setEditLocation(e.target.value)} style={{ marginTop: '.25rem', padding: '.8rem', background: 'rgba(87,125,196,.1)', border: '1px solid rgba(87,125,196,.3)', borderRadius: '8px', color: '#dff7ff', width: '100%', boxSizing: 'border-box' }} /></div>
             <div><label style={{ color: '#8ab0c9', fontSize: '.85rem' }}>Latitude</label><input type="number" step="any" placeholder="-90 to 90" value={editLat} onChange={(e) => setEditLat(e.target.value)} style={{ marginTop: '.25rem', padding: '.8rem', background: 'rgba(87,125,196,.1)', border: '1px solid rgba(87,125,196,.3)', borderRadius: '8px', color: '#dff7ff', width: '100%', boxSizing: 'border-box' }} /></div>
             <div><label style={{ color: '#8ab0c9', fontSize: '.85rem' }}>Longitude</label><input type="number" step="any" placeholder="-180 to 180" value={editLng} onChange={(e) => setEditLng(e.target.value)} style={{ marginTop: '.25rem', padding: '.8rem', background: 'rgba(87,125,196,.1)', border: '1px solid rgba(87,125,196,.3)', borderRadius: '8px', color: '#dff7ff', width: '100%', boxSizing: 'border-box' }} /></div>
             <div><label style={{ color: '#8ab0c9', fontSize: '.85rem' }}>FPS</label><div style={{ color: '#dff7ff', marginTop: '.25rem' }}>{selectedCamera.fps || 'Unknown'}</div></div>
             <div><label style={{ color: '#8ab0c9', fontSize: '.85rem' }}>Status</label><div style={{ color: selectedCamera.enabled !== false ? '#00d450' : '#ff5050', marginTop: '.25rem' }}>{selectedCamera.enabled !== false ? 'Online' : 'Offline'}</div></div>
             <div><label style={{ color: '#8ab0c9', fontSize: '.85rem' }}>HLS Base URL</label><div style={{ color: '#dff7ff', marginTop: '.25rem', fontSize: '.85rem', fontFamily: 'monospace', wordBreak: 'break-all' }}>{selectedCamera.hls_base_url || 'Default'}</div></div>
           </div>
           {editError && <p style={{ color: '#ff5050', marginTop: '.75rem', fontSize: '.9rem' }}>{editError}</p>}
           <div style={{ display: 'flex', gap: '0.75rem', marginTop: '1.5rem' }}>
           <button onClick={handleSaveLocation} disabled={editSaving} style={{ flex: 1, padding: '.8rem', background: 'linear-gradient(135deg,#00d4ff,#8c4dff)', color: '#03101c', border: 'none', borderRadius: '8px', fontSize: '.8rem', fontWeight: 'bold', cursor: 'pointer' }}>{editSaving ? 'Saving...' : 'Save Location'}</button>
           <button onClick={() => setSelectedCamera(null)} style={{ flex: 1, marginTop: '1.5rem', width: '100%', padding: '.8rem', background: 'rgba(87,125,196,.2)', border: 'none', color: '#dff7ff', borderRadius: '8px', cursor: 'pointer' }}>Close</button>
           </div>
          </div>
        </div>
      )}

      {streamCamera && (
        <div className="modal-overlay" onClick={handleCloseStream} style={{ position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000 }}>
          <div className="modal-content" onClick={e => e.stopPropagation()} style={{ background: '#000', border: '1px solid rgba(87,140,255,.3)', borderRadius: '16px', width: '100%', maxWidth: '900px', maxHeight: '90vh', overflow: 'hidden' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '1rem', background: 'rgba(10,18,38,.95)' }}>
              <h2 style={{ fontFamily: "'Orbitron', sans-serif", fontSize: '1rem', color: '#dff5ff', margin: 0 }}>{streamCamera.name}</h2>
              <button onClick={handleCloseStream} style={{ background: 'none', border: 'none', color: '#8ab0c9', fontSize: '1.5rem', cursor: 'pointer' }}>&times;</button>
            </div>
            <div style={{ background: '#000', display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: '400px' }}>
              <video
                ref={videoRef}
                controls
                autoPlay
                style={{ width: '100%', maxHeight: '70vh', background: '#000' }}
              />
            </div>
            {streamToken && (
              <div style={{ padding: '1rem' }}>
                <TwoWayAudio
                  cameraId={streamCamera.id}
                  cameraName={streamCamera.name}
                  streamToken={streamToken}
                  capabilities={detectTwoWayAudioCapability(streamCamera)}
                />
              </div>
            )}
          </div>
        </div>
      )}
    </>
  );
}
