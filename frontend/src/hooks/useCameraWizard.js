import { useEffect, useRef, useState } from 'react';
import Hls from 'hls.js';
import api from '../services/api';

export function useCameraWizard(addAuditEntry) {
  const hlsBaseUrl = (import.meta.env.VITE_HLS_BASE_URL || '/hls').replace(/\/$/, '');

  const wizardPreviewRef = useRef(null);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardScanning, setWizardScanning] = useState(false);
  const [wizardSaving, setWizardSaving] = useState(false);
  const [wizardScanResults, setWizardScanResults] = useState(null);
  const [wizardNode, setWizardNode] = useState(null);
  const [wizardNodeError, setWizardNodeError] = useState('');
  const [wizardSelectedCam, setWizardSelectedCam] = useState(null);
  const [wizardManualIp, setWizardManualIp] = useState('');
  const [wizardStreams, setWizardStreams] = useState(null);
  const [wizardSelectedStream, setWizardSelectedStream] = useState('');
  const [wizardProbing, setWizardProbing] = useState(false);
  const [wizardPreviewReady, setWizardPreviewReady] = useState(false);
  const [wizardTokenOk, setWizardTokenOk] = useState(false);
  const [wizardTunnelBusy, setWizardTunnelBusy] = useState(false);
  const [newCamera, setNewCamera] = useState({ id: '', name: '', rtsp_url: '', location: '', lat: '', lng: '', enabled: true, resolution: '1920x1080', fps: 30, codec: 'H264' });
  const [wizardUsername, setWizardUsername] = useState('');
  const [wizardPassword, setWizardPassword] = useState('');
  const [wizardTask, setWizardTask] = useState(null);
  const [wizardTaskId, setWizardTaskId] = useState(null);
  const [wizardError, setWizardError] = useState('');
  const [wizardPreview, setWizardPreview] = useState(null);

  const resetWizardState = () => {
    setWizardStep(1);
    setWizardScanning(false);
    setWizardSaving(false);
    setWizardScanResults(null);
    setWizardNode(null);
    setWizardNodeError('');
    setWizardSelectedCam(null);
    setWizardManualIp('');
    setWizardStreams(null);
    setWizardSelectedStream('');
    setWizardProbing(false);
    setWizardPreviewReady(false);
    setWizardTokenOk(false);
    setWizardTunnelBusy(false);
    setWizardUsername('');
    setWizardPassword('');
    setWizardTask(null);
    setWizardTaskId(null);
    setWizardError('');
    setWizardPreview(null);
    setNewCamera({ id: '', name: '', rtsp_url: '', location: '', lat: '', lng: '', enabled: true, resolution: '1920x1080', fps: 30, codec: 'H264' });
  };

  const openWizard = () => {
    setWizardOpen(true);
    resetWizardState();
    fetchWizardNode();
    startWizardScan();
  };

  const closeWizard = (skipCleanup = false) => {
    if (wizardTaskId && !skipCleanup) {
      try { api.post('/camera-setup/cancel', { task_id: wizardTaskId }); } catch { /* best effort */ }
    }
    const cameraId = wizardPreview?.cameraId;
    if (cameraId && !skipCleanup) {
      try { api.post('/camera-setup', { mode: 'cleanup', camera_id: cameraId }); } catch { /* best effort */ }
    }
    setWizardOpen(false);
    resetWizardState();
  };

  const pollWizardTask = async (taskId) => {
    for (let attempt = 0; attempt < 90; attempt += 1) {
      try {
        const res = await api.get(`/camera-setup/${taskId}`);
        const t = res.data?.task || res.data;
        setWizardTask(t);
        if (t?.status === 'done' || t?.status === 'failed') return t;
      } catch (err) {
        /* transient — keep polling */
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    return null;
  };

  const refreshWizardCameras = async () => {
    try {
      const res = await api.get('/cameras');
      return res.data?.cameras || [];
    } catch (err) {
      return [];
    }
  };

  const fetchWizardNode = async () => {
    try {
      const res = await api.get('/camera-setup/node');
      setWizardNode(res.data?.node || null);
      setWizardNodeError('');
      return res.data?.node || null;
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || 'Unknown error';
      setWizardNodeError(msg);
      setWizardNode(null);
      return null;
    }
  };

  const startWizardScan = async () => {
    setWizardScanning(true);
    setWizardError('');
    setWizardScanResults(null);
    setWizardTask(null);
    try {
      const res = await api.post('/camera-setup', { mode: 'scan' });
      const taskId = res.data?.taskId;
      if (!taskId) throw new Error('No task id returned');
      setWizardTaskId(taskId);
      const t = await pollWizardTask(taskId);
      if (!t) { setWizardError('Scan timed out. Is the desktop media app running?'); return; }
      if (t.status === 'failed') { setWizardError(t.error || 'Scan failed'); return; }
      setWizardScanResults({ cameras: t.result?.cameras || [], subnet: t.result?.subnet || null });
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || 'Unknown error';
      setWizardError(msg);
      if (err?.response?.status === 409) alert(msg);
    } finally {
      setWizardScanning(false);
    }
  };

  const testWizardConnection = async () => {
    const cam = wizardSelectedCam;
    const ip = (cam?.ip || wizardManualIp || '').trim();
    if (!ip) { alert('Enter the camera IP address or select one from the scan results.'); return; }
    if (!wizardUsername.trim() || !wizardPassword.trim()) {
      alert('Enter the camera username and password to discover its streams.');
      return;
    }
    setWizardProbing(true);
    setWizardError('');
    setWizardStreams(null);
    setWizardSelectedStream('');
    try {
      const res = await api.post('/camera-setup', {
        mode: 'probe',
        ip,
        onvif_port: cam?.onvif_port || 80,
        username: wizardUsername.trim(),
        password: wizardPassword.trim(),
      });
      const taskId = res.data?.taskId;
      if (!taskId) throw new Error('No task id returned');
      setWizardTaskId(taskId);
      const t = await pollWizardTask(taskId);
      if (!t) { setWizardError('Connection test timed out. Is the desktop media app running?'); return; }
      if (t.status === 'failed') { setWizardError(t.error || 'Connection test failed'); return; }
      const streams = t.result?.streams || [];
      if (streams.length === 0) {
        setWizardError(t.result?.need_credentials
          ? 'No streams found without valid credentials. Check the username/password, or paste an RTSP URL manually on the next step.'
          : 'No RTSP streams found on this camera. You can still paste an RTSP URL manually on the next step.');
        setWizardStep(2);
        return;
      }
      setWizardStreams(streams);
      setWizardSelectedStream(streams[0]?.url || '');
      setWizardStep(2);
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || 'Unknown error';
      setWizardError(msg);
      if (err?.response?.status === 409) alert(msg);
    } finally {
      setWizardProbing(false);
    }
  };

  const checkWizardHlsToken = async (hlsUrl) => {
    try {
      const res = await fetch(hlsUrl, { method: 'GET' });
      setWizardTokenOk(res.status !== 401 && res.status !== 403);
    } catch {
      setWizardTokenOk(false);
    }
  };

  const connectWizardPreview = async () => {
    const cam = wizardSelectedCam;
    const ip = (cam?.ip || wizardManualIp || '').trim();
    const rtspUrl = wizardSelectedStream.trim() || newCamera.rtsp_url.trim();
    if (!rtspUrl) { alert('Select a stream from the list or enter an RTSP URL.'); return; }
    setWizardSaving(true);
    setWizardError('');
    setWizardTask(null);
    setWizardPreview(null);
    setWizardPreviewReady(false);
    setWizardTokenOk(false);
    setWizardStep(2);
    try {
      const res = await api.post('/camera-setup', {
        mode: 'preview',
        ip: ip || null,
        onvif_port: cam?.onvif_port || 80,
        username: wizardUsername.trim() || null,
        password: wizardPassword.trim() || null,
        rtsp_url: rtspUrl,
        camera_name: newCamera.name.trim() || null,
      });
      const taskId = res.data?.taskId;
      if (!taskId) throw new Error('No task id returned');
      setWizardTaskId(taskId);
      const t = await pollWizardTask(taskId);
      if (!t) { setWizardError('Setup timed out. Is the desktop media app running?'); return; }
      if (t.status === 'failed') {
        setWizardError(t.error || 'Camera setup failed');
        setWizardStep(1);
        return;
      }
      const cameraId = t.camera_id || t.result?.camera_id;
      const base = t.node_hls_base_url || wizardNode?.public_hls_url || hlsBaseUrl;
      try {
        const vr = await api.post('/camera-views', { camera_id: cameraId });
        const token = vr.data?.streamToken;
        if (token) {
          const hlsUrl = `${base.replace(/\/$/, '')}/${cameraId}/index.m3u8?token=${encodeURIComponent(token)}`;
          setWizardPreview({ cameraId, name: newCamera.name.trim() || cameraId, hlsUrl });
          checkWizardHlsToken(hlsUrl);
        }
      } catch (err) {
        setWizardError(`Camera registered, but preview failed: ${err?.response?.data?.error || err.message}`);
      }
      setWizardStep(3);
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || 'Unknown error';
      setWizardError(msg);
      if (err?.response?.status === 409) alert(msg);
      setWizardStep(1);
    } finally {
      setWizardSaving(false);
    }
  };

  const saveWizardCamera = async () => {
    await refreshWizardCameras();
    closeWizard(true);
  };

  const startWizardTunnel = async () => {
    setWizardTunnelBusy(true);
    setWizardError('');
    try {
      const res = await api.post('/camera-setup', { mode: 'start_tunnel' });
      const taskId = res.data?.taskId;
      if (!taskId) throw new Error('No task id returned');
      setWizardTaskId(taskId);
      const t = await pollWizardTask(taskId);
      if (t?.status === 'failed') {
        setWizardError(t.error || 'Failed to start tunnel');
      } else {
        setWizardError(t?.result?.tunnel_online
          ? 'Tunnel is now online.'
          : 'Tunnel start requested — it may take a few seconds. Watch the health panel.');
      }
      await fetchWizardNode();
    } catch (err) {
      const msg = err?.response?.data?.error || err.message || 'Unknown error';
      setWizardError(msg);
      if (err?.response?.status === 409) alert(msg);
    } finally {
      setWizardTunnelBusy(false);
    }
  };

  // Live preview: attach hls.js to the preview video element
  useEffect(() => {
    if (!wizardPreview?.hlsUrl || !wizardPreviewRef.current) return undefined;
    const video = wizardPreviewRef.current;
    if (Hls.isSupported()) {
      const hls = new Hls();
      hls.loadSource(wizardPreview.hlsUrl);
      hls.attachMedia(video);
      return () => hls.destroy();
    }
    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = wizardPreview.hlsUrl;
    }
    return undefined;
  }, [wizardPreview]);

  // Health panel refreshes in real time while the wizard is open
  useEffect(() => {
    if (!wizardOpen) return undefined;
    const timer = setInterval(() => { fetchWizardNode(); }, 10000);
    return () => clearInterval(timer);
  }, [wizardOpen]);

  return {
    wizardOpen,
    setWizardOpen,
    wizardStep,
    setWizardStep,
    wizardScanning,
    wizardSaving,
    wizardScanResults,
    wizardNode,
    wizardNodeError,
    wizardSelectedCam,
    setWizardSelectedCam,
    wizardManualIp,
    setWizardManualIp,
    wizardStreams,
    wizardSelectedStream,
    setWizardSelectedStream,
    wizardProbing,
    wizardPreviewReady,
    setWizardPreviewReady,
    wizardTokenOk,
    wizardTunnelBusy,
    newCamera,
    setNewCamera,
    wizardUsername,
    setWizardUsername,
    wizardPassword,
    setWizardPassword,
    wizardTask,
    wizardError,
    setWizardError,
    wizardPreview,
    wizardPreviewRef,
    openWizard,
    closeWizard,
    startWizardScan,
    testWizardConnection,
    connectWizardPreview,
    saveWizardCamera,
    startWizardTunnel,
  };
}
