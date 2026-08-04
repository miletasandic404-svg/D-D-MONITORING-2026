import React, { useState, useEffect } from 'react';
import api from '../services/api';

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
  const [tab, setTab] = useState('scan'); // 'scan' | 'onvif' | 'manual'
  const [error, setError] = useState('');

  // ── Subnet scan state ──────────────────────────────────────────────────────
  const [subnet, setSubnet] = useState('192.168.1');
  const [scanning, setScanning] = useState(false);
  const [scanResults, setScanResults] = useState(null); // null = not yet scanned
  const [addingIp, setAddingIp] = useState(null);      // IP currently being registered
  const [addedIps, setAddedIps] = useState(new Set()); // IPs successfully registered
  const [scanCreds, setScanCreds] = useState({ username: '', password: '' });

  // ONVIF wizard state
  const [onvifFields, setOnvifFields] = useState({ ip: '', port: '', username: '', password: '' });
  const [discovering, setDiscovering] = useState(false);
  const [discovered, setDiscovered] = useState(null); // result from setup task
  const [registering, setRegistering] = useState(false);

  // Manual form state
  const [newCamera, setNewCamera] = useState({ name: '', stream_url: '', username: '', password: '', location: '', lat: '', lng: '' });
  const [saving, setSaving] = useState(false);

  // ── Subnet scan handler (via task queue → local media node) ────────────────
  const handleScan = async () => {
    setError('');
    setScanResults(null);
    setAddedIps(new Set());
    setScanning(true);
    try {
      const createRes = await api.post('/cameras?path=setup-create', {
        mode: 'scan',
        ip: subnet.trim(),
        username: scanCreds.username || undefined,
        password: scanCreds.password || undefined,
      });
      const taskId = createRes.data.task_id;
      const result = await pollTask(taskId, 120000); // scan can take up to 2 min
      if (result.status === 'done' && result.result) {
        const parsed = typeof result.result === 'string' ? JSON.parse(result.result) : result.result;
        setScanResults(parsed.cameras || []);
      } else {
        setError(result.error || 'Scan completed but no cameras were found.');
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Scan failed. Ensure your media node is online.');
    } finally {
      setScanning(false);
    }
  };

  // Register a single camera discovered during a subnet scan (via task queue).
  const handleScanAdd = async (camera) => {
    setError('');
    setAddingIp(camera.ip);
    try {
      const createRes = await api.post('/cameras?path=setup-create', {
        mode: 'onvif',
        ip: camera.ip,
        onvif_port: camera.onvif_port,
        username: scanCreds.username || undefined,
        password: scanCreds.password || undefined,
      });
      const taskId = createRes.data.task_id;
      const result = await pollTask(taskId, 60000);
      if (result.status === 'done') {
        setAddedIps((prev) => new Set([...prev, camera.ip]));
        onSuccess();
      } else {
        setError(`Failed to add ${camera.ip}: ${friendlySetupError(result)}`);
      }
    } catch (err) {
      setError(
        `Failed to add ${camera.ip}: ${err.response?.data?.error || err.message}`,
      );
    } finally {
      setAddingIp(null);
    }
  };

  const handleDiscover = async () => {
    setError('');
    setDiscovered(null);
    setDiscovering(true);
    try {
      const createRes = await api.post('/cameras?path=setup-create', {
        mode: 'onvif',
        ip: onvifFields.ip.trim(),
        onvif_port: onvifFields.port ? parseInt(onvifFields.port, 10) : 80,
        username: onvifFields.username || undefined,
        password: onvifFields.password || undefined,
      });
      const taskId = createRes.data.task_id;
      const result = await pollTask(taskId, 60000);
      if (result.status === 'done' && result.result) {
        const parsed = typeof result.result === 'string' ? JSON.parse(result.result) : result.result;
        setDiscovered({
          manufacturer: parsed.manufacturer || 'Unknown',
          model: parsed.model || 'Unknown',
          rtsp_urls: parsed.rtsp_url ? [parsed.rtsp_url] : [],
          rtsp_reachable: parsed.rtsp_reachable !== false,
        });
      } else {
        setError(friendlySetupError(result));
      }
    } catch (err) {
      setError(err.response?.data?.error || err.message || 'Discovery failed. Ensure your media node is online.');
    } finally {
      setDiscovering(false);
    }
  };

  const handleAutoRegister = async () => {
    setError('');
    setRegistering(true);
    try {
      // The discover task already registered the camera if it reached 'done'
      // Just refresh the camera list
      onSuccess({ camera_id: discovered?.camera_id });
    } catch (err) {
      setError(err.response?.data?.error || 'Registration failed. Please try again.');
    } finally {
      setRegistering(false);
    }
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
      });
      const taskId = createRes.data.task_id;
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

  const inputStyle = { padding: '.8rem', background: 'rgba(87,125,196,.1)', border: '1px solid rgba(87,125,196,.3)', borderRadius: '8px', color: '#dff7ff', width: '100%', boxSizing: 'border-box' };

  return (
    <div className="add-form-panel">
      <h2 style={{ fontSize: '1.15rem', color: 'var(--text-primary, #dff7ff)', marginBottom: '1.25rem' }}>Add New Camera</h2>

      <div className="add-form-tabs">
        <button className={`add-form-tab${tab === 'onvif' ? ' active' : ''}`} onClick={() => { setTab('onvif'); setError(''); setDiscovered(null); }}>
          🔍 ONVIF Auto-Discover
        </button>
        <button className={`add-form-tab${tab === 'manual' ? ' active' : ''}`} onClick={() => { setTab('manual'); setError(''); }}>
          ✏️ Manual (RTSP)
        </button>
      </div>

      <div className="add-form-tabs">
        <button className={`add-form-tab${tab === 'scan' ? ' active' : ''}`} onClick={() => { setTab('scan'); setError(''); }}>
          📡 Scan LAN
        </button>
        <button className={`add-form-tab${tab === 'onvif' ? ' active' : ''}`} onClick={() => { setTab('onvif'); setError(''); setDiscovered(null); }}>
          🔍 Single Camera
        </button>
        <button className={`add-form-tab${tab === 'manual' ? ' active' : ''}`} onClick={() => { setTab('manual'); setError(''); }}>
          ✏️ Manual (RTSP)
        </button>
      </div>

      {error && <p style={{ color: '#ff5050', marginBottom: '1rem', fontSize: '.9rem' }}>{error}</p>}

      {tab === 'scan' && (
        <>
          <div className="scan-notice">
            📡 Scans your local network for ONVIF cameras. Enter the subnet of your camera network (e.g. <strong>192.168.1</strong> or <strong>192.168.1.0/24</strong>). Only private RFC-1918 subnets are supported.
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label style={{ display: 'block', color: '#8ab0c9', fontSize: '.85rem', marginBottom: '.3rem' }}>Subnet *</label>
              <input
                type="text"
                placeholder="192.168.1 or 192.168.1.0/24"
                value={subnet}
                onChange={(e) => setSubnet(e.target.value)}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={{ display: 'block', color: '#8ab0c9', fontSize: '.85rem', marginBottom: '.3rem' }}>Username (optional)</label>
              <input
                type="text"
                placeholder="admin"
                value={scanCreds.username}
                onChange={(e) => setScanCreds({ ...scanCreds, username: e.target.value })}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={{ display: 'block', color: '#8ab0c9', fontSize: '.85rem', marginBottom: '.3rem' }}>Password (optional)</label>
              <input
                type="password"
                placeholder="••••••••"
                value={scanCreds.password}
                onChange={(e) => setScanCreds({ ...scanCreds, password: e.target.value })}
                style={inputStyle}
              />
            </div>
            <div style={{ display: 'flex', alignItems: 'flex-end' }}>
              <button
                className="add-cam-btn"
                onClick={handleScan}
                disabled={scanning || !subnet.trim()}
                style={{ width: '100%', opacity: scanning || !subnet.trim() ? .6 : 1 }}
              >
                {scanning ? '⏳ Scanning...' : '📡 Scan Network'}
              </button>
            </div>
          </div>

          {scanning && (
            <p style={{ color: '#8ab0c9', fontSize: '.85rem', textAlign: 'center', padding: '1rem' }}>
              Probing 254 hosts on {subnet}… this may take 30–60 seconds.
            </p>
          )}

          {scanResults !== null && !scanning && (
            <>
              {scanResults.length === 0 ? (
                <p style={{ color: '#8ab0c9', fontSize: '.9rem', textAlign: 'center', padding: '1rem' }}>
                  No ONVIF cameras found on <strong>{subnet}</strong>. Check the subnet and that cameras are powered on.
                </p>
              ) : (
                <>
                  <p style={{ color: '#00d450', fontSize: '.9rem', marginBottom: '.5rem' }}>
                    ✓ Found {scanResults.length} camera{scanResults.length !== 1 ? 's' : ''}
                  </p>
                  <div className="scan-result-list">
                    {scanResults.map((cam) => (
                      <div key={cam.ip} className="scan-result-item">
                        <div className="scan-result-info">
                          <div className="scan-result-name">
                            {cam.manufacturer !== 'Unknown' || cam.model !== 'Unknown'
                              ? `${cam.manufacturer} ${cam.model}`.trim()
                              : `Camera at ${cam.ip}`}
                          </div>
                          <div className="scan-result-meta">
                            <span>🌐 {cam.ip}</span>
                            <span>🔌 Port {cam.onvif_port}</span>
                            {cam.serial_number && <span>🔢 S/N {cam.serial_number}</span>}
                          </div>
                        </div>
                        <button
                          className={`scan-result-add${addedIps.has(cam.ip) ? ' added' : ''}`}
                          onClick={() => handleScanAdd(cam)}
                          disabled={addingIp !== null || addedIps.has(cam.ip)}
                        >
                          {addedIps.has(cam.ip) ? '✓ Added' : addingIp === cam.ip ? '⏳' : '+ Add'}
                        </button>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}
        </>
      )}

      {tab === 'onvif' && (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '1rem', marginBottom: '1rem' }}>
            <div>
              <label style={{ display: 'block', color: '#8ab0c9', fontSize: '.85rem', marginBottom: '.3rem' }}>Camera IP *</label>
              <input
                type="text"
                placeholder="192.168.1.100"
                value={onvifFields.ip}
                onChange={(e) => setOnvifFields({ ...onvifFields, ip: e.target.value })}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={{ display: 'block', color: '#8ab0c9', fontSize: '.85rem', marginBottom: '.3rem' }}>ONVIF Port (default 80)</label>
              <input
                type="number"
                placeholder="80"
                value={onvifFields.port}
                onChange={(e) => setOnvifFields({ ...onvifFields, port: e.target.value })}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={{ display: 'block', color: '#8ab0c9', fontSize: '.85rem', marginBottom: '.3rem' }}>Username</label>
              <input
                type="text"
                placeholder="admin"
                value={onvifFields.username}
                onChange={(e) => setOnvifFields({ ...onvifFields, username: e.target.value })}
                style={inputStyle}
              />
            </div>
            <div>
              <label style={{ display: 'block', color: '#8ab0c9', fontSize: '.85rem', marginBottom: '.3rem' }}>Password</label>
              <input
                type="password"
                placeholder="••••••••"
                value={onvifFields.password}
                onChange={(e) => setOnvifFields({ ...onvifFields, password: e.target.value })}
                style={inputStyle}
              />
            </div>
          </div>

          {!discovered ? (
            <button
              className="add-cam-btn"
              onClick={handleDiscover}
              disabled={discovering || !onvifFields.ip.trim()}
              style={{ opacity: discovering || !onvifFields.ip.trim() ? .6 : 1 }}
            >
              {discovering ? '⏳ Discovering...' : '🔍 Discover Camera'}
            </button>
          ) : (
            <>
              <div className="discovery-result">
                <div className="discovery-result-row"><span className="check">✓</span> {discovered.manufacturer} {discovered.model}</div>
                {discovered.rtsp_urls && discovered.rtsp_urls.length > 0 && (
                  <div className="discovery-result-row"><span className="check">✓</span> RTSP stream found</div>
                )}
                {discovered.rtsp_reachable && (
                  <div className="discovery-result-row"><span className="check">✓</span> Stream reachable</div>
                )}
                {discovered.rtsp_urls && discovered.rtsp_urls.length > 0 && (
                  <div style={{ marginTop: '.5rem', color: '#8ab0c9', fontSize: '.8rem', wordBreak: 'break-all' }}>
                    {discovered.rtsp_urls[0]}
                  </div>
                )}
              </div>
              <div style={{ display: 'flex', gap: '1rem', marginTop: '.5rem' }}>
                <button
                  className="add-cam-btn"
                  onClick={handleAutoRegister}
                  disabled={registering}
                  style={{ opacity: registering ? .6 : 1 }}
                >
                  {registering ? '⏳ Registering...' : '➕ Add Camera'}
                </button>
                <button
                  className="cam-btn cam-btn-secondary"
                  style={{ padding: '.8rem 1.5rem' }}
                  onClick={() => { setDiscovered(null); setError(''); }}
                >
                  Rediscover
                </button>
              </div>
            </>
          )}
        </>
      )}

      {tab === 'manual' && (
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
              style={{ ...inputStyle, gridColumn: '1 / -1' }}
            />
          </div>
          <p style={{ color: '#8ab0c9', fontSize: '.8rem', marginTop: '.75rem' }}>
            The camera is verified with a real RTSP handshake (reachability + authentication) before it is saved. Wrong credentials are rejected with a clear error.
          </p>
          <div style={{ display: 'flex', gap: '1rem', marginTop: '1rem' }}>
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

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="cameras-page">
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
                  <button className="cam-btn cam-btn-secondary">Settings</button>
                  <button className="cam-btn cam-btn-primary">View Stream</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
