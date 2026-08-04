import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../services/api';
import Hls from 'hls.js';
import { getSession, signOut } from '../services/auth-client';
import { fetchSubscriptionState } from '../services/billing';
import { loadPayPalSdk, loadStripeSdk } from '../services/payment-helpers';

const hlsBaseUrl = (import.meta.env.VITE_HLS_BASE_URL || '/hls').replace(/\/$/, '');
const paypalClientId = import.meta.env.VITE_PAYPAL_CLIENT_ID || '';
const paypalCurrency = import.meta.env.VITE_PAYPAL_CURRENCY || 'USD';
const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '';


const PLAN_OPTIONS = [
  {
    id: 'starter',
    name: 'Standard Global',
    price: '$500 / month',
    paypalAmount: '500',
    features: [
      'Global monitoring for up to 5 active locations/cameras',
      'Automated reports',
      'Standard support',
    ],
  },
  {
    id: 'growth',
    name: 'Business Global',
    price: '$950 / month',
    paypalAmount: '950',
    features: [
      'Advanced monitoring for up to 15 active locations/cameras',
      'Accelerated AI reporting',
      'Priority support',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise Global',
    price: '$1500 / month',
    paypalAmount: '1500',
    features: [
      'Maximum capacity',
      'Unlimited locations',
      'Dedicated AI analytics',
      '24/7 premium support',
    ],
  },
];

function formatPlanOption(plan) {
  const amount = Number.parseFloat(plan?.amount || '0');
  const limit = Number(plan?.limits?.camera_limit || 0);
  return {
    id: plan.id,
    name: plan.name,
    price: Number.isFinite(amount) ? `$${amount.toLocaleString()} / month` : plan.amount,
    paypalAmount: Number.isFinite(amount) ? String(amount) : '',
    features: [
      `${limit > 0 ? `Up to ${limit}` : 'Unlimited'} cameras / locations`,
      plan.features?.aiDetection ? 'AI detection included' : 'AI detection unavailable',
      plan.features?.reports ? 'Reports included' : 'No reports included',
      plan.features?.apiAccess ? 'API access included' : 'No API access',
    ],
  };
}

function buildHlsManifestUrl(cameraId, cameraHlsBaseUrl) {
  // Vercel serverless ne moze da hostuje trajni RTSP->HLS transkoder,
  // pa se HLS manifest/segmenti sluze DIREKTNO sa eksternog media
  // servera (MediaMTX), preko VITE_HLS_BASE_URL (ili po-kameri
  // hls_base_url iz media_nodes tabele ako postoji).
  // "/api/hls/:camera" NE POSTOJI kao Vercel funkcija -- ranija verzija
  // je pogresno usmeravala ovde, sto je izazivalo 404 na svaki stream.
  const base = (cameraHlsBaseUrl || hlsBaseUrl).replace(/\/$/, '');
  return `${base}/${cameraId}/index.m3u8`;
}

function buildCameraGeo(camera) {
  return {
    lat: Number(camera?.lat ?? 0),
    lng: Number(camera?.lng ?? 0),
    label: camera?.name || camera?.id || 'Unknown location',
    note: camera?.location || 'Security perimeter point',
  };
}

function buildIncidentReport(event, camera, contacts, plan) {
  const cameraGeo = buildCameraGeo(camera);
  return {
    generated_at: new Date().toISOString(),
    plan: plan?.name || 'Unselected',
    incident: {
      event_id: event?.eventId || null,
      title: event?.title || 'Alarm Triggered',
      status: event?.status || 'New',
      confidence: event?.confidence ?? null,
      camera_id: event?.camera_id || camera?.id || null,
      camera_name: camera?.name || event?.source || 'Unknown camera',
      location_label: cameraGeo.label,
      location_note: cameraGeo.note,
      coordinates: { lat: cameraGeo.lat, lng: cameraGeo.lng },
      zone: event?.zone || camera?.location || 'unknown',
      direction: event?.direction || 'unknown',
      dwell_seconds: event?.dwell_seconds ?? null,
      source: event?.source || 'system',
      timestamp: event?.time || new Date().toISOString(),
    },
    emergency_contacts: contacts,
  };
}

// Audio alarm - 3 beeps via Web Audio API
function playAlarmBeep() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    [0, 0.45, 0.9].forEach((delay) => {
      const osc = ctx.createOscillator();
      const gainNode = ctx.createGain();
      osc.connect(gainNode);
      gainNode.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = 'sine';
      gainNode.gain.setValueAtTime(0.35, ctx.currentTime + delay);
      gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.3);
      osc.start(ctx.currentTime + delay);
      osc.stop(ctx.currentTime + delay + 0.35);
    });
  } catch (e) { /* AudioContext unavailable or blocked */ }
}

// Debounces a rapidly-changing value so downstream work (filtering, search)
// only runs after the user pauses typing, keeping each keystroke fast.
function useDebounce(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setDebounced(value), delay);
    return () => clearTimeout(id);
  }, [value, delay]);
  return debounced;
}

export default function Dashboard() {
  const navigate = useNavigate();
  const paypalButtonsRef = useRef(null);
  const cardElementRef = useRef(null);
  const stripeRef = useRef(null);
  const stripeElementsRef = useRef(null);
  const [authChecked, setAuthChecked] = useState(false);
  const [incidents, setIncidents] = useState([]);
  const [incidentsLoaded, setIncidentsLoaded] = useState(false);
  const [cameras, setCameras] = useState(null);
  const [camerasError, setCamerasError] = useState(null);
  const [streamErrors, setStreamErrors] = useState({});
  const [snapshotStatus, setSnapshotStatus] = useState({});
  const [updatingIncidentId, setUpdatingIncidentId] = useState(null);
  const [error, setError] = useState(null);

  // Smart Search v2 filter state
  const [filterCamera, setFilterCamera] = useState('');
  const [filterZone, setFilterZone] = useState('');
  const [filterDirection, setFilterDirection] = useState('');
  const [filterDwellMin, setFilterDwellMin] = useState('');
  const [globalSearchTerm, setGlobalSearchTerm] = useState('');
  const [showNotifications, setShowNotifications] = useState(false);
  const [filterObjectType, setFilterObjectType] = useState('');
  const [filterColor, setFilterColor] = useState('');

  // Debounced versions of text-input filter states — filtering runs only
  // after the user pauses typing instead of on every keystroke.
  const dFilterObjectType = useDebounce(filterObjectType);
  const dFilterZone = useDebounce(filterZone);
  const dFilterDwellMin = useDebounce(filterDwellMin);
  const dFilterColor = useDebounce(filterColor);
  const dGlobalSearchTerm = useDebounce(globalSearchTerm);

  // False Alarm suppression
  const [suppressEnabled, setSuppressEnabled] = useState(false);
  const [suppressThreshold, setSuppressThreshold] = useState(85);

  // Phase 3 - Camera Onboarding Wizard
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wizardStep, setWizardStep] = useState(1);
  const [wizardScanning, setWizardScanning] = useState(false);
  const [wizardSaving, setWizardSaving] = useState(false);
  const [wizardScanResults, setWizardScanResults] = useState(null); // { cameras: [], subnet }
  const [wizardNode, setWizardNode] = useState(null);       // { id, public_hls_url, mediamtx_online, tunnel_online, health }
  const [wizardNodeError, setWizardNodeError] = useState('');
  const [wizardSelectedCam, setWizardSelectedCam] = useState(null); // { ip, manufacturer, model, firmware_version, onvif_port }
  const [wizardManualIp, setWizardManualIp] = useState('');
  const [wizardStreams, setWizardStreams] = useState(null); // [{ url, label, reachable }]
  const [wizardSelectedStream, setWizardSelectedStream] = useState('');
  const [wizardProbing, setWizardProbing] = useState(false);
  const [wizardPreviewReady, setWizardPreviewReady] = useState(false);
  const [wizardTokenOk, setWizardTokenOk] = useState(false);
  const [wizardTunnelBusy, setWizardTunnelBusy] = useState(false);
  const [newCamera, setNewCamera] = useState({ id: '', name: '', rtsp_url: '', location: '', lat: '', lng: '', enabled: true, resolution: '1920x1080', fps: 30, codec: 'H264' });
  const [wizardUsername, setWizardUsername] = useState('');
  const [wizardPassword, setWizardPassword] = useState('');
  const [wizardTask, setWizardTask] = useState(null);       // { status, error, result }
  const [wizardTaskId, setWizardTaskId] = useState(null);
  const [wizardError, setWizardError] = useState('');
  const [wizardPreview, setWizardPreview] = useState(null); // { cameraId, name, hlsUrl }
  const wizardPreviewRef = useRef(null);

  // Inline camera add form
  const [showAddCam, setShowAddCam] = useState(false);
  const [addCamForm, setAddCamForm] = useState({ name: '', rtsp_url: '', location: '', lat: '', lng: '' });
  const [addCamSaving, setAddCamSaving] = useState(false);
  const [addCamError, setAddCamError] = useState('');

  // Audio alarm incident count tracker
  const prevNewIncidentsRef = useRef(null);

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
    // Phase 7: cancel any in-flight setup task (scan/probe/preview) so the
    // agent stops processing it and wipes temporary credentials.
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

  // ── Camera Setup Wizard (V3 — One-Click Setup) ──────────────────────────
  // LAN work (ONVIF discovery, RTSP probing, MediaMTX path, tunnel) runs on
  // the local media node via camera-setup-agent.js; the wizard only creates
  // tasks and polls results. No SQL, no MediaMTX/Cloudflare config needed.
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
      const list = res.data?.cameras || [];
      setCameras(list);
      return list;
    } catch (err) {
      return [];
    }
  };

  // Auto-pick the best online media node and fetch its live health.
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

  // Step 1a — auto-scan the LAN for ONVIF cameras (starts on wizard open).
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

  // Step 1b — probe the selected camera and list its RTSP streams (main/sub).
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

  // Verify the HLS URL answers with a token (401/403 = token problem).
  const checkWizardHlsToken = async (hlsUrl) => {
    try {
      const res = await fetch(hlsUrl, { method: 'GET' });
      setWizardTokenOk(res.status !== 401 && res.status !== 403);
    } catch {
      setWizardTokenOk(false);
    }
  };

  // Step 2 — register the camera (preview mode) and start the live preview.
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

  // Step 3 — "Save" is only enabled once the video is actually playing.
  const saveWizardCamera = async () => {
    await refreshWizardCameras();
    closeWizard(true);
  };

  // Start the Cloudflare tunnel on the node (agent spawns cloudflared).
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

  // Live preview: attach hls.js to the preview video element.
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

  // Health panel refreshes in real time while the wizard is open.
  useEffect(() => {
    if (!wizardOpen) return undefined;
    const timer = setInterval(() => { fetchWizardNode(); }, 10000);
    return () => clearInterval(timer);
  }, [wizardOpen]);

  // Phase 3 - Voice Talkdown
  const [talkdownActive, setTalkdownActive] = useState(null);

  // Phase 4 - Audit Log
  const [auditLog, setAuditLog] = useState([]);
  const currentUser = JSON.parse(localStorage.getItem('currentUser') || 'null');
  const addAuditEntry = (action) => setAuditLog((prev) => [{ id: Date.now(), ts: new Date().toLocaleTimeString(), user: currentUser?.email || 'operator', action }, ...prev].slice(0, 50));

  // Phase 4 - White-Label Branding
  const [brandMode, setBrandMode] = useState('default'); // 'default' | 'corporate'

  // Sidebar collapsible sections
  const [sidebarSections, setSidebarSections] = useState({
    monitoring: true,
    intelligence: true,
    recognition: true,
    operations: true,
  });
  const brandName = brandMode === 'corporate' ? 'SecureOps Enterprise' : 'D&D Global AI Surveillance';
  const brandInitial = brandMode === 'corporate' ? 'S' : 'D';

  // Phase 4 - Subscription
  const [showBilling, setShowBilling] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState('growth');
  const [availablePlans, setAvailablePlans] = useState(PLAN_OPTIONS);
  const [subscriptionState, setSubscriptionState] = useState(null);
  const [checkoutStatus, setCheckoutStatus] = useState('');
  const [paymentStep, setPaymentStep] = useState('details');
  const [emergencyDistrict, setEmergencyDistrict] = useState('');
  const [emergencyContacts, setEmergencyContacts] = useState({
    policeStation: '',
    fireService: '',
    ambulance: '',
    localCommand: '',
  });
  const [selectedAlarmId, setSelectedAlarmId] = useState(null);
  const [reportNotes, setReportNotes] = useState('');
  const [paypalMountError, setPaypalMountError] = useState('');
  const [paypalMounting, setPaypalMounting] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('paypal');
  const [cardMountError, setCardMountError] = useState('');
  const [cardMounting, setCardMounting] = useState(false);
  const [cardSubmitting, setCardSubmitting] = useState(false);

  const selectedPlan = availablePlans.find((plan) => plan.id === selectedPlanId) || availablePlans[0] || PLAN_OPTIONS[1];

  const triggerTalkdown = (camId) => {
    setTalkdownActive(camId);
    const camName = cameras.find((c) => c.id === camId)?.name || camId;
    addAuditEntry(`Triggered voice talkdown on ${camName}`);
    setTimeout(() => setTalkdownActive(null), 5000);
  };

  // Captures the current frame from a camera's <video> element via
  // Canvas and uploads it through POST /api/snapshots (Phase 3). This
  // only works once the stream has an actual frame decoded -- if the
  // video hasn't started playing yet, the canvas capture will be blank,
  // which is why we check readyState first.
  const takeSnapshot = async (camId) => {
    const video = document.getElementById(`video-${camId}`);
    if (!video || video.readyState < 2) {
      setSnapshotStatus((prev) => ({ ...prev, [camId]: 'error' }));
      setTimeout(() => setSnapshotStatus((prev) => ({ ...prev, [camId]: null })), 3000);
      return;
    }

    setSnapshotStatus((prev) => ({ ...prev, [camId]: 'capturing' }));
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageBase64 = canvas.toDataURL('image/jpeg', 0.9);

      await api.post('/snapshots', { camera_id: camId, image_base64: imageBase64 });
      setSnapshotStatus((prev) => ({ ...prev, [camId]: 'success' }));
      const camName = cameras.find((c) => c.id === camId)?.name || camId;
      addAuditEntry(`Captured snapshot from ${camName}`);
    } catch (err) {
      console.error('Snapshot capture error:', err);
      setSnapshotStatus((prev) => ({ ...prev, [camId]: 'error' }));
    } finally {
      setTimeout(() => setSnapshotStatus((prev) => ({ ...prev, [camId]: null })), 3000);
    }
  };

  const submitAddCamera = async (e) => {
    e.preventDefault();
    if (!addCamForm.name.trim() || !addCamForm.rtsp_url.trim()) {
      setAddCamError('Camera name and RTSP URL are required.');
      return;
    }
    setAddCamSaving(true);
    setAddCamError('');
    const id = `CAM-${String((cameras?.length || 0) + 1).padStart(2, '0')}`;
    const newCam = {
      id,
      name: addCamForm.name.trim(),
      rtsp_url: addCamForm.rtsp_url.trim(),
      location: addCamForm.location.trim() || id,
      lat: addCamForm.lat ? Number(addCamForm.lat) : null,
      lng: addCamForm.lng ? Number(addCamForm.lng) : null,
      enabled: true,
      resolution: '1920x1080',
      fps: 30,
      codec: 'H264',
    };
    try {
      await api.post('/cameras', newCam);
      setCameras((prev) => [...(prev || []), newCam]);
      setAddCamForm({ name: '', rtsp_url: '', location: '', lat: '', lng: '' });
      setShowAddCam(false);
      addAuditEntry(`Added camera: ${newCam.name} (${id})`);
    } catch (err) {
      setAddCamError(err?.response?.data?.error || err.message || 'Failed to save camera.');
    } finally {
      setAddCamSaving(false);
    }
  };

  const selectedPlanAmount = selectedPlan.paypalAmount;
  const selectedPlanSupportsPaypal = Boolean(selectedPlanAmount);

  const requiredEmergencyFields = [
    emergencyDistrict,
    emergencyContacts.policeStation,
    emergencyContacts.fireService,
    emergencyContacts.ambulance,
    emergencyContacts.localCommand,
  ].every((value) => String(value || '').trim().length > 0);

  const openAlarmMap = (event) => {
    setSelectedAlarmId(event.eventId);
    addAuditEntry(`Opened alarm map for Event #${event.eventId}`);
  };

  const downloadReport = () => {
    const blob = new Blob([JSON.stringify({ ...generatedReport, notes: reportNotes }, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `alarm_report_event_${generatedReport.incident.event_id || 'unknown'}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
    addAuditEntry(`Generated automatic report for Event #${generatedReport.incident.event_id || 'unknown'}`);
  };

  const startCheckout = () => {
    if (!requiredEmergencyFields) {
      setCheckoutStatus('Fill emergency contacts before checkout.');
      return;
    }

    if (paymentMethod === 'paypal' && !paypalClientId) {
      setCheckoutStatus('PayPal client ID is missing in VITE_PAYPAL_CLIENT_ID.');
      return;
    }

    if (paymentMethod === 'card' && !stripePublishableKey) {
      setCheckoutStatus('Stripe publishable key is missing in VITE_STRIPE_PUBLISHABLE_KEY.');
      return;
    }

    if (!selectedPlanSupportsPaypal) {
      setCheckoutStatus('Select a package to continue with PayPal checkout.');
      return;
    }

    setCheckoutStatus(`Opening ${paymentMethod === 'paypal' ? 'PayPal' : 'card'} checkout for ${selectedPlan.name}.`);
    setPaymentStep('checkout');
    addAuditEntry(`Prepared ${paymentMethod} checkout for ${selectedPlan.name}`);
  };

  useEffect(() => {
    if (paymentStep !== 'checkout' || paymentMethod !== 'paypal') {
      return undefined;
    }

    let cancelled = false;

    const mountButtons = async () => {
      if (!requiredEmergencyFields) {
        setCheckoutStatus('Fill emergency contacts before checkout.');
        return;
      }

      if (!selectedPlanSupportsPaypal) {
        setCheckoutStatus('Select a package to continue with PayPal checkout.');
        return;
      }

      if (!paypalButtonsRef.current) {
        return;
      }

      setPaypalMounting(true);
      setPaypalMountError('');

      try {
        const paypal = await loadPayPalSdk(paypalClientId, paypalCurrency);
        if (cancelled || !paypalButtonsRef.current) {
          return;
        }

        paypalButtonsRef.current.innerHTML = '';

        const buttons = paypal.Buttons({
          style: {
            layout: 'vertical',
            shape: 'rect',
            label: 'paypal',
            height: 48,
          },
          createOrder: async () => {
            const response = await api.post('/paypal/orders', {
              planId: selectedPlan.id,
              district: emergencyDistrict,
              contacts: emergencyContacts,
              idempotencyKey: window.crypto?.randomUUID?.(),
            });

            return response.data.id;
          },
          onApprove: async (data) => {
            setPaypalMounting(true);
            const response = await api.post(`/paypal/orders/${data.orderID}/capture`);

            if (cancelled) {
              return;
            }

            setPaymentStep('complete');
            setCheckoutStatus(`PayPal payment completed: ${response.data.status || 'COMPLETED'}.`);
            await loadBillingState();
            addAuditEntry(`Activated ${selectedPlan.name} via PayPal order ${data.orderID}`);
          },
          onCancel: () => {
            if (!cancelled) {
              setCheckoutStatus('PayPal checkout canceled.');
            }
          },
          onError: (err) => {
            if (!cancelled) {
              setCheckoutStatus(err?.message || 'PayPal checkout failed.');
            }
          },
        });

        if (!buttons.isEligible()) {
          setCheckoutStatus('PayPal buttons are not eligible in this browser.');
          return;
        }

        await buttons.render(paypalButtonsRef.current);

        if (!cancelled) {
          setCheckoutStatus(`PayPal checkout ready for ${selectedPlan.name}.`);
        }
      } catch (err) {
        if (!cancelled) {
          setPaypalMountError(err?.message || 'Failed to load PayPal checkout.');
          setCheckoutStatus(err?.message || 'Failed to load PayPal checkout.');
        }
      } finally {
        if (!cancelled) {
          setPaypalMounting(false);
        }
      }
    };

    mountButtons();

    return () => {
      cancelled = true;
      if (paypalButtonsRef.current) {
        paypalButtonsRef.current.innerHTML = '';
      }
    };
  }, [paymentMethod, paymentStep, requiredEmergencyFields, selectedPlan.id, selectedPlan.name, selectedPlanAmount, selectedPlanSupportsPaypal, emergencyDistrict, emergencyContacts.policeStation, emergencyContacts.fireService, emergencyContacts.ambulance, emergencyContacts.localCommand]);

  useEffect(() => {
    if (paymentStep !== 'checkout' || paymentMethod !== 'card') {
      return undefined;
    }

    let cancelled = false;
    let paymentElement = null;

    const mountCard = async () => {
      if (!requiredEmergencyFields) {
        setCheckoutStatus('Fill emergency contacts before checkout.');
        return;
      }

      if (!cardElementRef.current) {
        return;
      }

      setCardMounting(true);
      setCardMountError('');

      try {
        const intent = await api.post('/payments/card/intent', {
          planId: selectedPlan.id,
          district: emergencyDistrict,
          contacts: emergencyContacts,
          idempotencyKey: window.crypto?.randomUUID?.(),
        });
        const stripe = await loadStripeSdk(stripePublishableKey);
        if (cancelled || !cardElementRef.current) {
          return;
        }

        stripeRef.current = stripe;
        stripeElementsRef.current = stripe.elements({
          clientSecret: intent.data.client_secret,
          appearance: { theme: 'night' },
        });

        cardElementRef.current.innerHTML = '';
        paymentElement = stripeElementsRef.current.create('payment');
        paymentElement.mount(cardElementRef.current);
        setCheckoutStatus(`Card checkout ready for ${selectedPlan.name}.`);
      } catch (err) {
        if (!cancelled) {
          const message = err?.response?.data?.error || err?.message || 'Failed to load card checkout.';
          setCardMountError(message);
          setCheckoutStatus(message);
        }
      } finally {
        if (!cancelled) {
          setCardMounting(false);
        }
      }
    };

    mountCard();

    return () => {
      cancelled = true;
      if (paymentElement) paymentElement.unmount();
      stripeElementsRef.current = null;
      stripeRef.current = null;
      if (cardElementRef.current) {
        cardElementRef.current.innerHTML = '';
      }
    };
  }, [paymentMethod, paymentStep, requiredEmergencyFields, selectedPlan.id, selectedPlan.name, emergencyDistrict, emergencyContacts.policeStation, emergencyContacts.fireService, emergencyContacts.ambulance, emergencyContacts.localCommand, stripePublishableKey]);

  const handleCardCheckout = async () => {
    if (!stripeRef.current || !stripeElementsRef.current) {
      setCardMountError('Card checkout is still loading.');
      return;
    }

    setCardSubmitting(true);
    setCardMountError('');

    try {
      const result = await stripeRef.current.confirmPayment({
        elements: stripeElementsRef.current,
        redirect: 'if_required',
      });

      if (result.error) {
        throw new Error(result.error.message || 'Card payment failed.');
      }

      const response = await api.post('/payments/card/confirm', {
        paymentIntentId: result.paymentIntent?.id,
      });

      setPaymentStep('complete');
      setCheckoutStatus(`Card payment completed: ${response.data.status || 'SUCCEEDED'}.`);
      await loadBillingState();
      addAuditEntry(`Activated ${selectedPlan.name} via card payment ${result.paymentIntent?.id}`);
    } catch (err) {
      const message = err?.response?.data?.error || err?.message || 'Card payment failed.';
      setCardMountError(message);
      setCheckoutStatus(message);
    } finally {
      setCardSubmitting(false);
    }
  };

  // Phase 3 - Push Notification Banner
  const [notifications, setNotifications] = useState([]);
  const dismissNotification = (id) => setNotifications((prev) => prev.filter((n) => n.id !== id));

  const loadBillingState = async () => {
    try {
      const state = await fetchSubscriptionState();
      setSubscriptionState(state.subscription || null);
      if (Array.isArray(state.plans) && state.plans.length > 0) {
        const planOptions = state.plans.map(formatPlanOption);
        setAvailablePlans(planOptions);
        setSelectedPlanId((currentPlanId) => {
          if (currentPlanId && planOptions.some((plan) => plan.id === currentPlanId)) {
            return currentPlanId;
          }
          return state.subscription?.planId || planOptions[0].id;
        });
      }
    } catch (err) {
      console.error('Failed to load billing state:', err);
    }
  };


  // Auth guard - redirect to login if no active session
  useEffect(() => {
    (async () => {
      try {
        const session = await getSession();
        if (!session || !session.user) {
          // Clear stale session data
          localStorage.removeItem('currentUser');
          await signOut();
          navigate('/', { replace: true });
        } else {
          // Sync user info from server session
          localStorage.setItem('currentUser', JSON.stringify(session.user));
          await loadBillingState();
          setAuthChecked(true);
        }
      } catch (err) {
        localStorage.removeItem('currentUser');
        navigate('/', { replace: true });
      }
    })();
  }, [navigate]);

  const systemStatus = {
    label: 'Operational',
    tone: 'good',
  };

  // Client-side filter + false-alarm suppression applied to incidents list.
  // Memoized so the filter only re-runs when data or filter state actually
  // changes, not on every unrelated state update.
  const filteredIncidents = useMemo(() => (incidents || []).filter((item) => {
    if (suppressEnabled && Number(item.confidence) < suppressThreshold / 100) return false;
    if (filterCamera && String(item.camera_id || '').toLowerCase() !== filterCamera.toLowerCase()) return false;
    if (dFilterZone && !String(item.zone || item.location || '').toLowerCase().includes(dFilterZone.toLowerCase())) return false;
    if (filterDirection && !String(item.direction || '').toLowerCase().includes(filterDirection.toLowerCase())) return false;
    if (dFilterDwellMin && Number(item.dwell_seconds || 0) < Number(dFilterDwellMin)) return false;
    if (dFilterObjectType && !String(item.object_type || '').toLowerCase().includes(dFilterObjectType.toLowerCase())) return false;
    if (dFilterColor) {
      const hasColor = (item.attributes || []).some(
        (a) => String(a.attribute_type || a.type || '').toLowerCase() === 'color' &&
               String(a.attribute_value || a.value || '').toLowerCase().includes(dFilterColor.toLowerCase())
      );
      if (!hasColor) return false;
    }
    return true;
  }), [incidents, suppressEnabled, suppressThreshold, filterCamera, dFilterZone, filterDirection, dFilterDwellMin, dFilterObjectType, dFilterColor]);

  const activeCameras = useMemo(
    () => (cameras ? cameras.filter((camera) => camera.enabled !== false).length : 0),
    [cameras],
  );

  const globalSearchNeedle = globalSearchTerm.trim().toLowerCase();

  const visibleCameras = useMemo(() => {
    const needle = dGlobalSearchTerm.trim().toLowerCase();
    return cameras && needle
      ? cameras.filter((cam) => [cam.name, cam.location, cam.id].some((field) => (field || '').toLowerCase().includes(needle)))
      : cameras;
  }, [cameras, dGlobalSearchTerm]);

  const recentAlerts = filteredIncidents.filter((incident) => ['New', 'Acknowledged', 'In Progress'].includes(incident.status)).length;

  const recentEvents = useMemo(() => filteredIncidents.slice(0, 20).map((item) => ({
    id: `evt-${item.event_id}-${item.detection_id}`,
    eventId: item.event_id,
    title: `${item.object_type} detection`,
    subtitle: item.subtitle || `Confidence ${Math.round(Number(item.confidence) * 100)}%`,
    source: item.source || `Event #${item.event_id}`,
    time: item.timestamp,
    status: item.status || 'New',
    confidence: item.confidence,
    camera_id: item.camera_id,
    zone: item.zone || item.location,
    direction: item.direction,
    dwell_seconds: item.dwell_seconds,
  })), [filteredIncidents]);

  const selectedAlarmEvent = recentEvents.find((event) => event.eventId === selectedAlarmId) || recentEvents[0] || null;
  const selectedAlarmCamera = cameras?.find((camera) => camera.id === selectedAlarmEvent?.camera_id) || cameras?.[0] || null;
  const selectedAlarmGeo = buildCameraGeo(selectedAlarmCamera);
  const generatedReport = buildIncidentReport(selectedAlarmEvent, selectedAlarmCamera, { district: emergencyDistrict, ...emergencyContacts }, selectedPlan);
  const reportSummary = selectedAlarmEvent
    ? `Alarm at ${selectedAlarmGeo.label} requires dispatch confirmation. Route to ${selectedAlarmGeo.note}.`
    : 'No active alarm selected yet.';

  // Only fetch data once auth is confirmed
  useEffect(() => {
    if (!authChecked) return;

    api
      .get('/incidents')
      .then((res) => {
        setIncidents(res.data.incidents || []);
        setIncidentsLoaded(true);
      })
      .catch((err) => setError(err.message));
  }, [authChecked]);

  // Audio alarm: play 3 beeps when new 'New' incidents arrive
  useEffect(() => {
    if (!incidentsLoaded) return;
    const newCount = incidents.filter((i) => i.status === 'New').length;
    if (prevNewIncidentsRef.current !== null && newCount > prevNewIncidentsRef.current) {
      playAlarmBeep();
    }
    prevNewIncidentsRef.current = newCount;
  }, [incidents, incidentsLoaded]);

  // Fetch cameras once auth is confirmed
  useEffect(() => {
    if (!authChecked) return;

    api
      .get('/cameras')
      .then((res) => {
        setCameras(res.data.cameras || []);
        setCamerasError(null);
      })
      .catch((err) => {
        const backendMessage = err.response?.data?.error;
        setCamerasError(
          backendMessage ||
          (err.response
            ? `Camera service returned an error (HTTP ${err.response.status}).`
            : 'Could not reach the camera API. Check your network connection or API deployment.')
        );
        setCameras([]);
      });
  }, [authChecked]);

  // Initialize HLS for each camera video element. As of Phase 2, each
  // camera stream requires a short-lived token (see api/camera-views and
  // media-server's authHTTPAddress hook) -- the raw manifest URL alone is
  // no longer sufficient, and every view is logged server-side.
  useEffect(() => {
    if (!authChecked || !cameras) return undefined;

    let cancelled = false;
    const hlsInstances = [];
    const openViewLogIds = [];
    setStreamErrors({});

    const closeViewLog = (viewLogId) => {
      if (!viewLogId) return;
      api.patch(`/camera-views/${viewLogId}`).catch(() => {
        // Best-effort: if this fails (e.g. network drop on tab close),
        // the view log simply stays open with no ended_at. Not fatal --
        // it just means that session's duration won't show as closed.
      });
    };

    async function initCamera(cam) {
      const video = document.getElementById(`video-${cam.id}`);
      if (!video) return;

      let streamToken;
      let viewLogId;
      try {
        const res = await api.post('/camera-views', { camera_id: cam.id });
        
        // Validate response
        if (!res.data?.success) {
          console.error('Camera views API failed:', res.data?.error);
          setStreamErrors((prev) => ({
            ...prev,
            [cam.id]: res.data?.error || 'Failed to start viewing session.',
          }));
          return;
        }
        
        streamToken = res.data?.streamToken;
        viewLogId = res.data?.viewLogId;
        
        // Validate token exists
        if (!streamToken) {
          console.error('No stream token returned for camera:', cam.id, 'Response:', res.data);
          setStreamErrors((prev) => ({
            ...prev,
            [cam.id]: 'Stream token not received from server.',
          }));
          return;
        }
      } catch (err) {
        console.error('Camera views API error:', err.message, err.response?.data);
        if (cancelled) return;
        setStreamErrors((prev) => ({
          ...prev,
          [cam.id]: err.response?.status === 404
            ? 'You do not have access to this camera.'
            : 'Could not start a viewing session for this camera.',
        }));
        return;
      }
      if (cancelled) {
        closeViewLog(viewLogId); // effect was torn down while the request was in flight
        return;
      }
      openViewLogIds.push(viewLogId);

      const manifestUrl = `${buildHlsManifestUrl(cam.id, cam.hls_base_url)}?token=${encodeURIComponent(streamToken)}`;
      console.log('HLS URL for camera', cam.id, ':', manifestUrl);

      if (Hls.isSupported()) {
        const hls = new Hls();
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          setStreamErrors((prev) => ({
            ...prev,
            [cam.id]: 'Stream unavailable. Check that the media server is running and reachable.',
          }));
        });
        hls.loadSource(manifestUrl);
        hls.attachMedia(video);
        hlsInstances.push(hls);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        // Native HLS support (e.g. Safari)
        video.src = manifestUrl;
        video.addEventListener('error', () => {
          setStreamErrors((prev) => ({
            ...prev,
            [cam.id]: 'Stream unavailable. Check that the media server is running and reachable.',
          }));
        });
      } else {
        setStreamErrors((prev) => ({
          ...prev,
          [cam.id]: 'This browser does not support HLS playback.',
        }));
      }
    }

    cameras.forEach((cam) => {
      if (cam.enabled === false) return;
      initCamera(cam);
    });

    return () => {
      cancelled = true;
      hlsInstances.forEach((hls) => hls.destroy());
      openViewLogIds.forEach(closeViewLog);
    };
  }, [cameras, authChecked]);

  // Evidence export: fetches the real recordings/snapshots for this
  // event (Phase 3 storage) and bundles them with metadata into a
  // downloadable JSON -- previously this only wrote a placeholder
  // note ("Clip URL will be populated once storage is connected")
  // even though storage has been wired up since Phase 3.
  const exportEvidence = async (event) => {
    let evidence = { recordings: [], snapshots: [], storage_configured: false };
    try {
      const res = await api.get(`/incidents/${event.eventId}/evidence`);
      evidence = res.data;
    } catch (err) {
      // Fall through with empty evidence rather than blocking the
      // export entirely -- the metadata below is still useful even
      // if the evidence lookup failed (e.g. storage not configured).
      console.error('Failed to fetch evidence for export:', err.message);
    }

    const metadata = {
      export_version: '2.0',
      exported_at: new Date().toISOString(),
      incident: {
        event_id: event.eventId,
        title: event.title,
        status: event.status,
        confidence: event.confidence,
        camera_id: event.camera_id || 'unknown',
        zone: event.zone || 'unknown',
        direction: event.direction || 'unknown',
        dwell_seconds: event.dwell_seconds || null,
        source: event.source,
        timestamp: event.time,
      },
      recordings: evidence.recordings || [],
      snapshots: evidence.snapshots || [],
      note: evidence.storage_configured
        ? 'download_url links expire 1 hour after this export was generated.'
        : 'Object storage is not configured on this deployment, so no recordings/snapshots could be attached.',
    };

    const blob = new Blob([JSON.stringify(metadata, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = `evidence_event_${event.eventId}.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  const updateIncidentStatus = async (eventId, status) => {
    try {
      setUpdatingIncidentId(eventId);
      await api.patch(`/incidents/${eventId}/status`, { status });
      setIncidents((previous) => previous.map((incident) => (
        incident.event_id === eventId ? { ...incident, status } : incident
      )));
      addAuditEntry(`Set Incident #${eventId} status to "${status}"`);
    } catch (err) {
      alert(`Failed to update incident: ${err.message}`);
    } finally {
      setUpdatingIncidentId(null);
    }
  };

  const statusClassName = (status) => {
    if (status === 'False Alarm') return 'neutral';
    if (status === 'Resolved') return 'good';
    if (status === 'In Progress' || status === 'Acknowledged') return 'warning';
    return 'warning';
  };

  const nextActionsForStatus = (status) => {
    switch (status) {
      case 'New':
        return ['Acknowledged', 'In Progress', 'False Alarm'];
      case 'Acknowledged':
        return ['In Progress', 'Resolved', 'False Alarm'];
      case 'In Progress':
        return ['Resolved', 'False Alarm'];
      case 'Resolved':
        return ['In Progress', 'False Alarm'];
      case 'False Alarm':
        return ['New', 'Acknowledged'];
      default:
        return ['Acknowledged'];
    }
  };

  if (!authChecked) return null;

  if (error) {
    return (
      <div className="dashboard-shell">
        <aside className="sidebar">
          <div>
            <div className="brand-mark">D</div>
            <h1 className="sidebar-title">D&D Global AI Surveillance</h1>
            <p className="sidebar-copy">Security monitoring, detections, and camera intelligence.</p>
          </div>
        </aside>
        <main className="dashboard-main" role="main">
          <div className="topbar">
            <div>
              <p className="eyebrow">Security Command Center</p>
              <h2>Dashboard</h2>
            </div>
          </div>
          <section className="dashboard-panel">
            <h3>Unable to load data</h3>
            <p>{error?.message || String(error)}</p>
          </section>
        </main>
      </div>
    );
  }

  return (
    <div className="dashboard-shell">
      {/* -- Push Notification Banner -- */}
      {notifications && notifications.length > 0 && (
        <div className="notif-stack" role="alert" aria-live="assertive">
          {notifications.map((n) => (
            <div key={n.id} className={`notif-banner notif-${n.level}`}>
              <span className="notif-dot" aria-hidden="true" />
              <div className="notif-body">
                <strong>{n.title}</strong>
                <p>{n.body}</p>
              </div>
              <span className="notif-time">{n.ts}</span>
              <button className="notif-dismiss" onClick={() => dismissNotification(n.id)} aria-label="Dismiss">&#x2715;</button>
            </div>
          ))}
        </div>
      )}

      {/* -- Camera Onboarding Wizard V3 (One-Click Setup) -- */}
      {wizardOpen && (
        <div className="modal-overlay" role="dialog" aria-modal="true" aria-label="Add new camera">
          <section className="modal-card">
            <div className="modal-header">
              <h2 className="modal-title">
                {wizardStep === 3 ? 'Live Preview' : wizardStep === 2 ? 'Connect Camera' : 'Add New Camera'}
              </h2>
              <button className="notif-dismiss" onClick={closeWizard} aria-label="Close">&#x2715;</button>
            </div>

            {/* Health panel — always visible */}
            <div className="wizard-fields" style={{ background: 'rgba(0,0,0,0.35)', borderRadius: 8, padding: '8px 12px', marginBottom: 10 }}>
              {[
                { key: 'node', label: 'Media Node online', ok: !!wizardNode, hint: 'Desktop media app nije online — pokreni start-laptop.bat na računaru pored kamera.' },
                { key: 'mtx', label: 'MediaMTX online', ok: !!wizardNode?.mediamtx_online, hint: 'MediaMTX ne odgovara na nodu — proveri da je pokrenut (start-laptop.bat).' },
                { key: 'tunnel', label: 'Tunnel online', ok: !!wizardNode?.tunnel_online, hint: 'Cloudflare Tunnel nije aktivan.' },
                { key: 'rtsp', label: 'RTSP connected', ok: wizardStreams?.find((s) => s.url === wizardSelectedStream)?.reachable ?? (wizardSelectedStream ? undefined : null), hint: 'Izaberi stream sa kamere.' },
                { key: 'hls', label: 'HLS active', ok: wizardPreviewReady, hint: 'HLS radi kada video počne da se reprodukuje.' },
                { key: 'token', label: 'Token auth OK', ok: wizardTokenOk, hint: '' },
              ].map((it) => (
                <div key={it.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12.5, padding: '2px 0' }}>
                  <span>{it.ok === true ? '🟢' : it.ok === false ? '🔴' : '⚪'}</span>
                  <span style={{ minWidth: 130 }}>{it.label}</span>
                  {it.ok === false && it.hint && <span style={{ color: 'var(--color-warn, #f59e0b)' }}>{it.hint}</span>}
                </div>
              ))}
              {wizardNodeError && <p style={{ color: 'var(--color-danger, #ef4444)', fontSize: 12, margin: '4px 0' }}>⚠️ {wizardNodeError}</p>}
              {wizardNode && !wizardNode.tunnel_online && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 4 }}>
                  <button className="ghost-button" type="button" onClick={startWizardTunnel} disabled={wizardTunnelBusy} style={{ padding: '3px 10px', fontSize: 12 }}>
                    {wizardTunnelBusy ? 'Starting…' : '🚀 Start Tunnel'}
                  </button>
                  <span style={{ fontSize: 11, opacity: 0.8 }}>HLS neće biti javno dostupan dok tunnel ne radi.</span>
                </div>
              )}
            </div>

            {wizardStep === 1 && (
              <>
                <p className="ls-desc">Skeniranje lokalne mreže se pokreće automatski. Izaberi pronađenu kameru ili unesi IP adresu ručno — bez RTSP putanja i bez konfiguracije.</p>
                {wizardScanning ? (
                  <p className="ls-desc" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>⏳ Scanning the local network for ONVIF cameras…</p>
                ) : (
                  <div className="wizard-fields">
                    {wizardScanResults?.cameras?.length > 0 ? (
                      <>
                        <span style={{ fontSize: 13 }}>Found {wizardScanResults.cameras.length} camera(s) on {wizardScanResults.subnet || 'LAN'}:</span>
                        <div className="wizard-found">
                          {wizardScanResults.cameras.map((cam, i) => (
                            <button key={i} type="button" className="wizard-found-item"
                              onClick={() => { setWizardSelectedCam(cam); setWizardManualIp(cam.ip); }}
                              style={{ textAlign: 'left', padding: 10, marginBottom: 6, borderRadius: 6, cursor: 'pointer', width: '100%' }}>
                              <div>📷 <strong>{cam.manufacturer || 'Unknown'} {cam.model || ''}</strong></div>
                              <div style={{ fontSize: 12, opacity: 0.8 }}>
                                {cam.ip}{cam.onvif_port ? ` :${cam.onvif_port}` : ''} · FW {cam.firmware_version || 'n/a'} · ONVIF ✓
                              </div>
                            </button>
                          ))}
                        </div>
                      </>
                    ) : (
                      <p className="ls-desc" style={{ color: 'var(--color-warn, #f59e0b)' }}>No cameras found automatically. Enter the camera IP manually below (e.g. 192.168.1.17).</p>
                    )}
                    <label className="search-field">
                      <span>Camera IP</span>
                      <input value={wizardManualIp} onChange={(e) => { setWizardManualIp(e.target.value); setWizardSelectedCam(null); }} placeholder="192.168.1.17" />
                    </label>
                    <label className="search-field"><span>Username (ONVIF)</span><input value={wizardUsername} onChange={(e) => setWizardUsername(e.target.value)} placeholder="admin" autoComplete="off" /></label>
                    <label className="search-field"><span>Password</span><input type="password" value={wizardPassword} onChange={(e) => setWizardPassword(e.target.value)} placeholder="••••••••" /></label>
                    <label className="search-field"><span>Camera name</span><input value={newCamera.name} onChange={(e) => setNewCamera((p) => ({ ...p, name: e.target.value }))} placeholder="South Entrance" /></label>
                  </div>
                )}
                {wizardError && <p className="ls-desc" style={{ color: 'var(--color-danger, #ef4444)' }}>⚠️ {wizardError}</p>}
                <div className="wizard-actions">
                  <button className="primary-button" type="button" onClick={testWizardConnection} disabled={wizardScanning || wizardProbing || !wizardNode}>
                    {wizardProbing ? 'Finding streams…' : 'Test Connection & Find Streams'}
                  </button>
                  <button className="ghost-button" type="button" onClick={startWizardScan} disabled={wizardScanning}>Rescan network</button>
                </div>
              </>
            )}

            {wizardStep === 2 && (
              <>
                <p className="ls-desc">Izaberi stream koji želiš da povežeš (Main je obično visoka rezolucija, Sub niža). Ako nema pronađenih streamova, unesi RTSP URL ručno.</p>
                {wizardStreams?.length > 0 ? (
                  <div className="wizard-found">
                    {wizardStreams.map((s, i) => (
                      <button key={i} type="button"
                        onClick={() => setWizardSelectedStream(s.url)}
                        style={{ textAlign: 'left', padding: 10, marginBottom: 6, borderRadius: 6, cursor: 'pointer', width: '100%',
                                 outline: wizardSelectedStream === s.url ? '2px solid var(--color-primary, #3b82f6)' : 'none' }}>
                        <div>🎥 <strong>{s.label}</strong> {s.reachable ? '🟢' : '🔴'}</div>
                        <div style={{ fontSize: 11, opacity: 0.75, wordBreak: 'break-all' }}>{s.url}</div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <label className="search-field">
                    <span>RTSP URL (manual)</span>
                    <input value={newCamera.rtsp_url} onChange={(e) => setNewCamera((p) => ({ ...p, rtsp_url: e.target.value }))} placeholder="rtsp://user:pass@192.168.1.17:554/Streaming/Channels/101" />
                  </label>
                )}
                {wizardError && <p className="ls-desc" style={{ color: 'var(--color-danger, #ef4444)' }}>⚠️ {wizardError}</p>}
                <div className="wizard-actions">
                  <button className="primary-button" type="button" onClick={connectWizardPreview} disabled={wizardSaving}>
                    {wizardSaving ? 'Connecting…' : 'Connect & Preview'}
                  </button>
                  <button className="ghost-button" type="button" onClick={() => setWizardStep(1)}>Back</button>
                </div>
              </>
            )}

            {wizardStep === 3 && (
              <>
                <p className="wizard-success">Camera <strong>{wizardPreview?.name || newCamera.name}</strong> is live. Klikni Save da je trajno dodaš.</p>
                {wizardPreview?.hlsUrl && (
                  <video
                    ref={wizardPreviewRef}
                    controls
                    autoPlay
                    muted
                    playsInline
                    onPlaying={() => setWizardPreviewReady(true)}
                    onError={() => setWizardError('Preview failed to play. Proveri health panel i probaj ponovo.')}
                    style={{ width: '100%', borderRadius: 8, background: '#000', aspectRatio: '16 / 9', marginBottom: 12 }}
                  />
                )}
                {wizardError && <p className="ls-desc" style={{ color: 'var(--color-danger, #ef4444)' }}>⚠️ {wizardError}</p>}
                <div className="wizard-actions">
                  <button className="primary-button" type="button" onClick={saveWizardCamera} disabled={!wizardPreviewReady}>
                    {wizardPreviewReady ? '💾 Save Camera' : 'Waiting for live preview…'}
                  </button>
                  <button className="ghost-button" type="button" onClick={closeWizard}>Cancel</button>
                </div>
              </>
            )}
          </section>
        </div>
      )}
      <aside className="sidebar">
        <div className="sidebar-scroll">
          <div>
            <div className="brand-mark">{brandInitial}</div>
            <h1 className="sidebar-title">{brandName}</h1>
            <p className="sidebar-copy">Security monitoring, detections, and camera intelligence.</p>
          </div>

          <nav className="sidebar-nav" aria-label="Dashboard navigation">
          {/* Monitoring group */}
          <div className="sidebar-group">
            <button className="sidebar-group-header" onClick={() => setSidebarSections(s => ({ ...s, monitoring: !s.monitoring }))}>
              <span className="sidebar-group-arrow" data-open={sidebarSections.monitoring}>▶</span>
              <span>Monitoring</span>
            </button>
            {sidebarSections.monitoring && (
              <div className="sidebar-group-items">
                <button className="sidebar-nav-item" onClick={() => navigate('/dashboard')}>Dashboard</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/cameras')}>Cameras</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/live-streams')}>Live Streams</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/video-playback')}>Video Playback</button>
              </div>
            )}
          </div>
          {/* Intelligence group */}
          <div className="sidebar-group">
            <button className="sidebar-group-header" onClick={() => setSidebarSections(s => ({ ...s, intelligence: !s.intelligence }))}>
              <span className="sidebar-group-arrow" data-open={sidebarSections.intelligence}>▶</span>
              <span>Intelligence</span>
            </button>
            {sidebarSections.intelligence && (
              <div className="sidebar-group-items">
                <button className="sidebar-nav-item" onClick={() => navigate('/ai-detection')}>AI Detection</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/alerts')}>Alerts</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/incidents')}>Incidents</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/map')}>Map</button>
              </div>
            )}
          </div>
          {/* Recognition group */}
          <div className="sidebar-group">
            <button className="sidebar-group-header" onClick={() => setSidebarSections(s => ({ ...s, recognition: !s.recognition }))}>
              <span className="sidebar-group-arrow" data-open={sidebarSections.recognition}>▶</span>
              <span>Recognition</span>
            </button>
            {sidebarSections.recognition && (
              <div className="sidebar-group-items">
                <button className="sidebar-nav-item" onClick={() => navigate('/face-recognition')}>Face Recognition</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/license-plates')}>LPR</button>
              </div>
            )}
          </div>
          {/* Operations group */}
          <div className="sidebar-group">
            <button className="sidebar-group-header" onClick={() => setSidebarSections(s => ({ ...s, operations: !s.operations }))}>
              <span className="sidebar-group-arrow" data-open={sidebarSections.operations}>▶</span>
              <span>Operations</span>
            </button>
            {sidebarSections.operations && (
              <div className="sidebar-group-items">
                <button className="sidebar-nav-item" onClick={() => navigate('/emergency')}>Emergency</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/reports')}>Reports</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/users')}>Users</button>
                <button className="sidebar-nav-item" onClick={() => navigate('/settings')}>Settings</button>
              </div>
            )}
          </div>
          </nav>
        </div>

        <div className="sidebar-footer">
          <span className={`status-pill ${systemStatus.tone}`}>{systemStatus.label}</span>
          <p>Live monitoring enabled</p>
        </div>
      </aside>

      <main className="dashboard-main" role="main">
        <header className="topbar">
          <div className="topbar-left">
            <button className="back-button" onClick={() => navigate(-1)} aria-label="Go back">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                <path d="M19 12H5" />
                <path d="M12 19l-7-7 7-7" />
              </svg>
            </button>
            <div>
              <p className="eyebrow">Security Command Center</p>
              <h2 id="overview">Dashboard</h2>
            </div>
          </div>
          <div className="topbar-actions">
            <div className="search-bar">
              <input
                type="text"
                placeholder="Global search..."
                className="search-input"
                value={globalSearchTerm}
                onChange={(e) => setGlobalSearchTerm(e.target.value)}
              />
              <button className="search-button" aria-label="Search">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <circle cx="11" cy="11" r="8" />
                  <path d="m21 21-4.35-4.35" />
                </svg>
              </button>
            </div>
            <div className="notifications-wrapper" style={{ position: 'relative' }}>
              <button
                className="icon-button"
                aria-label="Notifications"
                onClick={() => setShowNotifications((v) => !v)}
                style={{ position: 'relative' }}
              >
                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9" />
                  <path d="M13.73 21a2 2 0 0 1-3.46 0" />
                </svg>
                {incidents.filter((i) => i.status === 'New').length > 0 && (
                  <span className="notification-badge">{incidents.filter((i) => i.status === 'New').length}</span>
                )}
              </button>
              {showNotifications && (
                <div className="notifications-panel" style={{ position: 'absolute', right: 0, top: '100%', zIndex: 20, background: '#0d1b2a', border: '1px solid #1f3a52', borderRadius: '8px', padding: '0.75rem', minWidth: '260px', maxHeight: '320px', overflowY: 'auto' }}>
                  <p style={{ margin: '0 0 0.5rem', fontSize: '0.85rem', color: '#8ea3b8' }}>New incidents</p>
                  {incidents.filter((i) => i.status === 'New').length === 0 ? (
                    <p style={{ margin: 0, fontSize: '0.85rem', color: '#8ea3b8' }}>Nothing new right now.</p>
                  ) : (
                    incidents.filter((i) => i.status === 'New').map((i) => (
                      <div key={i.event_id} style={{ padding: '0.4rem 0', borderBottom: '1px solid #16293b', fontSize: '0.85rem' }}>
                        <strong>{i.camera_id}</strong> — {i.source || i.subtitle || 'Incident'}
                      </div>
                    ))
                  )}
                </div>
              )}
            </div>
            <button className="icon-button" aria-label="Settings" onClick={() => setShowBilling(true)}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.09a2 2 0 0 1-1-1.74v-.47a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.39a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z" />
                <circle cx="12" cy="12" r="3" />
              </svg>
            </button>
            <div className="user-profile">
              <div className="user-avatar">
                {currentUser?.email?.charAt(0).toUpperCase() || 'U'}
              </div>
            </div>
            <button className="primary-button" onClick={() => { setShowAddCam((v) => !v); setAddCamError(''); }}>
              + Add Camera
            </button>
            <button className="ghost-button" onClick={() => setWizardOpen(true)}>
              + Create Incident
            </button>
          </div>
        </header>

        {/* -- Subscription / Billing Panel -- */}
        {showBilling && (
          <section className="dashboard-panel billing-panel" id="billing">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">License Management</p>
                <h3>Client Plans &amp; Checkout</h3>
              </div>
              <button className="notif-dismiss" type="button" onClick={() => setShowBilling(false)}>&#x2715;</button>
            </div>

            <div className="billing-grid billing-grid-wide">
              <div className="billing-tier-card billing-plan-list">
                <p className="eyebrow">Available packages</p>
                <div className="plan-grid">
                  {PLAN_OPTIONS.map((plan) => (
                    <button
                      key={plan.id}
                      type="button"
                      role="button"
                      className={`plan-card${selectedPlanId === plan.id ? ' plan-card-active' : ''}`}
                      onClick={() => {
                        setSelectedPlanId(plan.id);
                        addAuditEntry(`Selected package ${plan.name}`);
                      }}
                    >
                      <div className="plan-card-top">
                        <strong>{plan.name}</strong>
                        <span>{plan.price}</span>
                      </div>
                      <ul className="plan-card-features">
                        {plan.features.map((feature) => (
                          <li key={feature}>{feature}</li>
                        ))}
                      </ul>
                    </button>
                  ))}
                </div>
                <div className="purchase-note">
                  <span className="status-pill neutral">Backend verified subscription</span>
                  <p>
                    Current plan: {subscriptionState?.planName || 'Loading...'} •
                    status: {subscriptionState?.status || 'pending'}.
                    PayPal and direct card payments are finalized server-side before plan activation.
                  </p>
                </div>
              </div>

              <div className="billing-upgrade-card">
                <p className="eyebrow">Billing controls</p>
                <h4>{selectedPlan.name}</h4>
                <p className="ls-desc">{selectedPlan.price}</p>

                <div className="checkout-stepper">
                  <span className={paymentStep === 'details' ? 'step-active' : ''}>1. Contacts</span>
                  <span className={paymentStep === 'checkout' ? 'step-active' : ''}>2. Payment</span>
                  <span className={paymentStep === 'complete' ? 'step-active' : ''}>3. Activated</span>
                </div>

                <div className="contact-grid">
                  <label className="search-field">
                    <span>District</span>
                    <input required value={emergencyDistrict} onChange={(e) => setEmergencyDistrict(e.target.value)} placeholder="District / county" />
                  </label>
                  <label className="search-field">
                    <span>Police station number</span>
                    <input required value={emergencyContacts.policeStation} onChange={(e) => setEmergencyContacts((prev) => ({ ...prev, policeStation: e.target.value }))} placeholder="110 / local number" />
                  </label>
                  <label className="search-field">
                    <span>Fire service number</span>
                    <input required value={emergencyContacts.fireService} onChange={(e) => setEmergencyContacts((prev) => ({ ...prev, fireService: e.target.value }))} placeholder="112 / local number" />
                  </label>
                  <label className="search-field">
                    <span>Ambulance / medical</span>
                    <input required value={emergencyContacts.ambulance} onChange={(e) => setEmergencyContacts((prev) => ({ ...prev, ambulance: e.target.value }))} placeholder="medical emergency number" />
                  </label>
                  <label className="search-field">
                    <span>Local command center</span>
                    <input required value={emergencyContacts.localCommand} onChange={(e) => setEmergencyContacts((prev) => ({ ...prev, localCommand: e.target.value }))} placeholder="district command / dispatch" />
                  </label>
                </div>

                <div style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setPaymentMethod('paypal')}
                    style={{
                      borderColor: paymentMethod === 'paypal' ? 'rgba(0,212,255,.7)' : undefined,
                      background: paymentMethod === 'paypal' ? 'rgba(0,212,255,.12)' : undefined,
                    }}
                  >
                    PayPal
                  </button>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => setPaymentMethod('card')}
                    style={{
                      borderColor: paymentMethod === 'card' ? 'rgba(0,212,255,.7)' : undefined,
                      background: paymentMethod === 'card' ? 'rgba(0,212,255,.12)' : undefined,
                    }}
                  >
                    Visa / Mastercard
                  </button>
                </div>

                <button className="ghost-button plan-cta" type="button" onClick={startCheckout}>
                  {paymentMethod === 'paypal' ? 'Start PayPal checkout' : 'Start card checkout'}
                </button>

                <div className="checkout-meta">
                  <span className={`status-pill ${requiredEmergencyFields ? 'good' : 'warning'}`}>
                    {requiredEmergencyFields ? 'Contacts complete' : 'Contacts required'}
                  </span>
                  {paypalClientId ? (
                    <span className="status-pill good">PayPal client ready</span>
                  ) : (
                    <span className="status-pill warning">Missing VITE_PAYPAL_CLIENT_ID</span>
                  )}
                  {stripePublishableKey ? (
                    <span className="status-pill good">Card key ready</span>
                  ) : (
                    <span className="status-pill warning">Missing VITE_STRIPE_PUBLISHABLE_KEY</span>
                  )}
                </div>

                {paymentStep === 'checkout' && paymentMethod === 'paypal' && selectedPlanSupportsPaypal && (
                  <div className="paypal-button-shell">
                    <div className="paypal-button-header">
                      <span className="status-pill good">PayPal secure checkout</span>
                      <span className="subtle-chip">{selectedPlan.name}</span>
                    </div>
                    <div className="paypal-buttons-host" ref={paypalButtonsRef} aria-live="polite" />
                    {(paypalMounting || paypalMountError) && (
                      <p className={`checkout-status ${paypalMountError ? 'checkout-status-error' : ''}`}>
                        {paypalMountError || 'Loading PayPal buttons...'}
                      </p>
                    )}
                  </div>
                )}

                {paymentStep === 'checkout' && paymentMethod === 'card' && (
                  <div className="paypal-button-shell">
                    <div className="paypal-button-header">
                      <span className="status-pill good">Card checkout</span>
                      <span className="subtle-chip">{selectedPlan.name}</span>
                    </div>
                    <div ref={cardElementRef} style={{ minHeight: 170, padding: '1rem', borderRadius: '18px', background: 'rgba(4,10,28,.72)', border: '1px solid rgba(87,125,196,.25)' }} />
                    <button className="ghost-button plan-cta" type="button" onClick={handleCardCheckout} disabled={cardSubmitting}>
                      {cardSubmitting ? 'Processing card...' : 'Pay with card'}
                    </button>
                    {(cardMounting || cardMountError) && (
                      <p className={`checkout-status ${cardMountError ? 'checkout-status-error' : ''}`}>
                        {cardMountError || 'Loading card checkout...'}
                      </p>
                    )}
                  </div>
                )}

                {checkoutStatus && <p className="checkout-status">{checkoutStatus}</p>}

                <div className="branding-group">
                  <p className="eyebrow" style={{marginBottom:'.6rem'}}>White-Label Mode</p>
                  <div className="branding-toggle-row">
                    <button
                      type="button"
                      className={`branding-option${brandMode === 'default' ? ' branding-active' : ''}`}
                      onClick={() => { setBrandMode('default'); addAuditEntry('Switched branding to D&D Security Default'); }}
                    >D&D Security Default</button>
                    <button
                      type="button"
                      className={`branding-option${brandMode === 'corporate' ? ' branding-active' : ''}`}
                      onClick={() => { setBrandMode('corporate'); addAuditEntry('Switched branding to Corporate White-Label mode'); }}
                    >Corporate White-Label</button>
                  </div>
                  <p className="ls-desc" style={{marginTop:'.6rem'}}>Active: <strong style={{color:'#85dfff'}}>{brandName}</strong></p>
                </div>
              </div>
            </div>
          </section>
        )}

        {/* -- Smart Search v2 + False Alarm controls -- */}
        <section className="search-panel dashboard-panel" id="search" aria-label="Smart search filters">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Smart Search v2</p>
              <h3>Filter Incidents</h3>
            </div>
            <label className="suppress-toggle">
              <input
                type="checkbox"
                checked={suppressEnabled}
                onChange={(e) => setSuppressEnabled(e.target.checked)}
              />
              <span>Suppress below {suppressThreshold}% confidence</span>
            </label>
          </div>

          {suppressEnabled && (
            <div className="suppress-slider-row">
              <span>50%</span>
              <input
                type="range" min="50" max="99" step="1"
                value={suppressThreshold}
                onChange={(e) => setSuppressThreshold(Number(e.target.value))}
                className="suppress-slider"
              />
              <span>{suppressThreshold}%</span>
            </div>
          )}

          <div className="search-grid">
            <label className="search-field">
              <span>Object Type</span>
              <input type="text" placeholder="Person, Vehicle..." value={filterObjectType} onChange={(e) => setFilterObjectType(e.target.value)} />
            </label>
            <label className="search-field">
              <span>Camera</span>
              <select value={filterCamera} onChange={(e) => setFilterCamera(e.target.value)}>
                <option value="">All cameras</option>
                {cameras && cameras.map((cam) => (
                  <option key={cam.id} value={cam.id}>{cam.name}</option>
                ))}
              </select>
            </label>
            <label className="search-field">
              <span>Zone / Location</span>
              <input type="text" placeholder="entrance, parking..." value={filterZone} onChange={(e) => setFilterZone(e.target.value)} />
            </label>
            <label className="search-field">
              <span>Direction</span>
              <select value={filterDirection} onChange={(e) => setFilterDirection(e.target.value)}>
                <option value="">Any direction</option>
                <option value="entering">Entering</option>
                <option value="exiting">Exiting</option>
                <option value="left">Left</option>
                <option value="right">Right</option>
              </select>
            </label>
            <label className="search-field">
              <span>Min. Dwell (seconds)</span>
              <input type="number" min="0" placeholder="0" value={filterDwellMin} onChange={(e) => setFilterDwellMin(e.target.value)} />
            </label>
            <label className="search-field">
              <span>Color Attribute</span>
              <input type="text" placeholder="Red, Black..." value={filterColor} onChange={(e) => setFilterColor(e.target.value)} />
            </label>
          </div>

          {(filterObjectType || filterCamera || filterZone || filterDirection || filterDwellMin || filterColor || suppressEnabled) && (
            <button
              type="button"
              className="ghost-button"
              style={{ marginTop: '0.75rem', fontSize: '0.8rem' }}
              onClick={() => {
                setFilterObjectType('');
                setFilterCamera('');
                setFilterZone('');
                setFilterDirection('');
                setFilterDwellMin('');
                setFilterColor('');
                setSuppressEnabled(false);
              }}
            >
              Clear all filters
            </button>
          )}
        </section>

        <section className="metrics-grid" aria-label="Key metrics">
          <article className="metric-card">
            <p className="metric-label">Active Cameras</p>
            {cameras === null ? (
              <div className="skeleton skeleton-number" />
            ) : (
              <strong>{cameras.length ? activeCameras : '-'}</strong>
            )}
            <span>{cameras === null ? <div className="skeleton skeleton-text short" /> : cameras.length ? `${cameras.length} total cameras` : 'No cameras configured'}</span>
          </article>
          <article className="metric-card">
            <p className="metric-label">Offline Cameras</p>
            {cameras === null ? (
              <div className="skeleton skeleton-number" />
            ) : (
              <strong>{cameras.length ? cameras.length - activeCameras : '-'}</strong>
            )}
            <span>{cameras === null ? <div className="skeleton skeleton-text short" /> : cameras.length ? 'Disabled streams' : 'No cameras configured'}</span>
          </article>
          <article className="metric-card">
            <p className="metric-label">Active Streams</p>
            {cameras === null ? (
              <div className="skeleton skeleton-number" />
            ) : (
              <strong>{cameras.length ? activeCameras : '-'}</strong>
            )}
            <span>{cameras === null ? <div className="skeleton skeleton-text short" /> : cameras.length ? 'Live HLS connections' : 'No cameras configured'}</span>
          </article>
          <article className="metric-card">
            <p className="metric-label">Open Alerts</p>
            {!incidentsLoaded ? (
              <div className="skeleton skeleton-number" />
            ) : (
              <strong>{recentAlerts}</strong>
            )}
            <span>{!incidentsLoaded ? <div className="skeleton skeleton-text short" /> : 'New & acknowledged'}</span>
          </article>
          <article className="metric-card">
            <p className="metric-label">Incidents Today</p>
            {!incidentsLoaded ? (
              <div className="skeleton skeleton-number" />
            ) : (
              <strong>{incidents.length}</strong>
            )}
            <span>{!incidentsLoaded ? <div className="skeleton skeleton-text short" /> : 'Total detections'}</span>
          </article>
          <article className="metric-card">
            <p className="metric-label">System Health</p>
            <strong className="metric-accent">{systemStatus.label}</strong>
            <span>Core services operational</span>
          </article>
          <article className="metric-card">
            <p className="metric-label">Storage Usage</p>
            <strong>-</strong>
            <span>Storage monitoring not configured</span>
          </article>
          <article className="metric-card">
            <p className="metric-label">API Status</p>
            <strong className="metric-accent">Online</strong>
            <span>Backend connected</span>
          </article>
        </section>

        <section className="dashboard-panel alarm-panel" id="alarm-map">
          <div className="panel-heading">
            <div>
              <p className="eyebrow">Alarm response</p>
              <h3>Map & Location</h3>
            </div>
            <button className="ghost-button" type="button" onClick={() => setShowBilling(true)}>Open Packages</button>
          </div>

          <div className="alarm-grid">
            <div className="alarm-map-card">
              <div className="alarm-map-header">
                <span className="status-pill warning">Active alarm</span>
                <span className="subtle-chip">{selectedAlarmEvent ? `Event #${selectedAlarmEvent.eventId}` : 'No active event'}</span>
              </div>
              {selectedAlarmCamera && (selectedAlarmGeo.lat !== 0 || selectedAlarmGeo.lng !== 0) ? (
                <div className="alarm-map">
                  <div className="map-grid-line map-grid-x" />
                  <div className="map-grid-line map-grid-y" />
                  <div
                    className="map-pin"
                    style={{ left: `${Math.min(Math.max(((selectedAlarmGeo.lng - 15.94) / 0.06) * 100, 8), 92)}%`, top: `${Math.min(Math.max((1 - ((selectedAlarmGeo.lat - 45.80) / 0.03)) * 100, 10), 90)}%` }}
                  />
                  <div className="map-callout">
                    <strong>{selectedAlarmGeo.label}</strong>
                    <p>{selectedAlarmGeo.note}</p>
                  </div>
                </div>
              ) : (
                <div className="alarm-map alarm-map-empty">
                  <div className="empty-state-content">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: '#8ea3b8', marginBottom: '1rem' }}>
                      <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z" />
                      <circle cx="12" cy="10" r="3" />
                    </svg>
                    <p style={{ color: '#8ea3b8', fontSize: '0.95rem', margin: 0 }}>No camera locations configured</p>
                    <p style={{ color: '#6a7a8a', fontSize: '0.85rem', margin: '0.5rem 0 0' }}>Add cameras with latitude/longitude coordinates to enable map view</p>
                  </div>
                </div>
              )}
              <div className="alarm-location-list">
                <div>
                  <span className="alarm-label">Exact location</span>
                  <strong>{selectedAlarmGeo.label}</strong>
                </div>
                <div>
                  <span className="alarm-label">Coordinates</span>
                  <strong>{selectedAlarmGeo.lat.toFixed(4)}, {selectedAlarmGeo.lng.toFixed(4)}</strong>
                </div>
                <div>
                  <span className="alarm-label">Explanation</span>
                  <strong>{reportSummary}</strong>
                </div>
              </div>
            </div>
          </div>
        </section>

        <section className="content-grid">
          <section className="dashboard-panel table-panel" id="events">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Activity feed</p>
                <h3>Recent Events</h3>
              </div>
              <span className="subtle-chip">Last 24h</span>
            </div>

            <div className="table-wrap">
              <table className="events-table">
                <thead>
                  <tr>
                    <th>Event</th>
                    <th>Source</th>
                    <th>Time</th>
                    <th>Status</th>
                    <th>Actions</th>
                    <th>Evidence</th>
                  </tr>
                </thead>
                <tbody>
                  {recentEvents.length ? (
                    recentEvents.map((event) => (
                      <tr key={event.id}>
                        <td>
                          <div className="table-title">{event.title}</div>
                          <div className="table-subtitle">{event.subtitle}</div>
                        </td>
                        <td>{event.source || event.subtitle}</td>
                        <td>{event.time}</td>
                        <td>
                          <span className={`status-pill ${statusClassName(event.status)}`}>
                            {event.status}
                          </span>
                        </td>
                        <td>
                          <div className="incident-actions">
                            {currentUser ? (
                              nextActionsForStatus(event.status).map((nextStatus) => (
                                <button
                                  key={`${event.id}-${nextStatus}`}
                                  type="button"
                                  className="ghost-button incident-action-button"
                                  onClick={() => updateIncidentStatus(event.eventId, nextStatus)}
                                  disabled={updatingIncidentId === event.eventId}
                                >
                                  {updatingIncidentId === event.eventId ? 'Updating...' : nextStatus}
                                </button>
                              ))
                            ) : (
                              <span className="table-subtitle">Login required</span>
                            )}
                          </div>
                        </td>
                        <td>
                          <button
                            type="button"
                            className="ghost-button incident-action-button export-btn"
                            onClick={() => { exportEvidence(event); setSelectedAlarmId(event.eventId); addAuditEntry(`Exported evidence package for Event #${event.eventId}`); }}
                            title="Download evidence package (JSON + video metadata)"
                          >
                            Export
                          </button>
                          <button
                            type="button"
                            className="ghost-button incident-action-button"
                            onClick={() => openAlarmMap(event)}
                          >
                            Show map
                          </button>
                        </td>
                      </tr>
                    ))
                  ) : (
                    <tr>
                      <td colSpan="6" className="empty-state">
                        {incidentsLoaded ? 'No incidents match the current filters.' : 'Loading incident queue...'}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
          </section>

          <section className="dashboard-panel cameras-panel" id="cameras">
            <div className="panel-heading">
              <div>
                <p className="eyebrow">Camera matrix</p>
                <h3>Streams</h3>
              </div>
              <button
                className="ghost-button"
                type="button"
                onClick={() => { setShowAddCam((v) => !v); setAddCamError(''); }}
              >
                {showAddCam ? 'Cancel' : '+ Add Camera'}
              </button>
            </div>

            {camerasError && (
              <p className="checkout-status checkout-status-error" role="alert">
                Camera list failed to load: {camerasError}
              </p>
            )}

            {showAddCam && (
              <form className="add-cam-form" onSubmit={submitAddCamera}>
                <label className="search-field">
                  <span>Camera Name</span>
                  <input
                    value={addCamForm.name}
                    onChange={(e) => setAddCamForm((p) => ({ ...p, name: e.target.value }))}
                    placeholder="e.g. Back Yard"
                    required
                    autoFocus
                  />
                </label>
                <label className="search-field">
                  <span>RTSP Stream URL</span>
                  <input
                    value={addCamForm.rtsp_url}
                    onChange={(e) => setAddCamForm((p) => ({ ...p, rtsp_url: e.target.value }))}
                    placeholder="rtsp://your-camera-ip:554/stream"
                    required
                  />
                </label>
                <label className="search-field">
                  <span>Location (optional)</span>
                  <input
                    value={addCamForm.location}
                    onChange={(e) => setAddCamForm((p) => ({ ...p, location: e.target.value }))}
                    placeholder="e.g. back_yard"
                  />
                </label>
                <label className="search-field">
                  <span>Latitude (optional)</span>
                  <input
                    type="number"
                    step="any"
                    value={addCamForm.lat}
                    onChange={(e) => setAddCamForm((p) => ({ ...p, lat: e.target.value }))}
                    placeholder="e.g. 45.8154"
                  />
                </label>
                <label className="search-field">
                  <span>Longitude (optional)</span>
                  <input
                    type="number"
                    step="any"
                    value={addCamForm.lng}
                    onChange={(e) => setAddCamForm((p) => ({ ...p, lng: e.target.value }))}
                    placeholder="e.g. 15.9819"
                  />
                </label>
                <div className="add-cam-actions">
                  {addCamError && <p className="checkout-status checkout-status-error">{addCamError}</p>}
                  <button
                    className="primary-button"
                    type="submit"
                    disabled={addCamSaving || !addCamForm.name.trim() || !addCamForm.rtsp_url.trim()}
                  >
                    {addCamSaving ? 'Saving...' : 'Add Camera'}
                  </button>
                </div>
              </form>
            )}

            <div className="camera-list">
              {visibleCameras && visibleCameras.length > 0 ? (
                visibleCameras.map((cam) => (
                  <article className="camera-card" key={cam.id}>
                    <div className="camera-card-header">
                      <div>
                        <h4>{cam.name}</h4>
                        <p>{cam.location || cam.rtsp_url}</p>
                      </div>
                      <span className={`status-pill ${cam.enabled !== false ? 'good' : 'neutral'}`}>
                        {cam.enabled !== false ? 'Live' : 'Disabled'}
                      </span>
                    </div>
                    <div className="camera-video-wrapper">
                      {streamErrors[cam.id] && (
                        <p className="checkout-status checkout-status-error" role="alert">
                          {streamErrors[cam.id]}
                        </p>
                      )}
                      <video id={`video-${cam.id}`} controls muted playsInline className="camera-video" />
                    </div>
                    {/* Snapshot + talkdown controls */}
                    <div className="talkdown-row">
                      <button
                        type="button"
                        className="talkdown-btn"
                        onClick={() => takeSnapshot(cam.id)}
                        disabled={snapshotStatus[cam.id] === 'capturing'}
                      >
                        {snapshotStatus[cam.id] === 'capturing' ? 'Capturing...' :
                          snapshotStatus[cam.id] === 'success' ? 'Snapshot saved' :
                          snapshotStatus[cam.id] === 'error' ? 'Snapshot failed' : 'Take Snapshot'}
                      </button>
                      <button
                        type="button"
                        className={`talkdown-btn${talkdownActive === cam.id ? ' talkdown-active' : ''}`}
                        onClick={() => triggerTalkdown(cam.id)}
                        disabled={talkdownActive === cam.id}
                      >
                        {talkdownActive === cam.id ? 'Warning Active...' : 'Trigger Talkdown'}
                      </button>
                      {talkdownActive === cam.id && (
                        <span className="talkdown-indicator" aria-live="polite">
                          <span className="talkdown-pulse" aria-hidden="true" /> Broadcasting warning to {cam.name}
                        </span>
                      )}
                    </div>
                  </article>
                ))
              ) : (
                <div className="empty-state">
                  <div className="empty-state-content">
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" style={{ color: '#8ea3b8', marginBottom: '1rem' }}>
                      <path d="M23 7l-7 5 7 5V7z" />
                      <rect x="1" y="5" width="15" height="14" rx="2" ry="2" />
                    </svg>
                    <p style={{ color: '#8ea3b8', fontSize: '0.95rem', margin: 0 }}>
                      {globalSearchNeedle ? `No cameras match "${globalSearchTerm}"` : 'No active streams connected'}
                    </p>
                    {!globalSearchNeedle && (
                    <button 
                      className="ghost-button" 
                      type="button"
                      onClick={() => { setShowAddCam((v) => !v); setAddCamError(''); }}
                      style={{ marginTop: '1rem' }}
                    >
                      Add Camera
                    </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </section>
        </section>

        {/* -- Operator Audit Trail -- */}
        <section className="dashboard-panel audit-panel" id="audit">
          <div className="panel-heading">
            <div><p className="eyebrow">Compliance &amp; traceability</p><h3>Operator Audit Trail</h3></div>
            <span className="subtle-chip">{auditLog.length} entries</span>
          </div>
          <div className="table-wrap">
            <table className="events-table audit-table">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Operator</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {(auditLog || []).map((entry) => (
                  <tr key={entry.id}>
                    <td><span className="audit-ts">{entry.ts}</span></td>
                    <td><span className="audit-user">{entry.user}</span></td>
                    <td>{entry.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      </main>
    </div>
  );
}
