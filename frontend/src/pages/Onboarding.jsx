import React, { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import Hls from 'hls.js';
import api from '../services/api';
import { signUp } from '../services/auth-client';
import { clearPendingPayment, readPendingPayment } from '../services/payment-helpers';

const PAGE_CSS = `
  @keyframes spin {
    to { transform: rotate(360deg); }
  }
  @keyframes fadeIn {
    from { opacity: 0; transform: translateY(8px); }
    to   { opacity: 1; transform: translateY(0); }
  }
  .onboarding-page {
    min-height: 100vh;
    background: linear-gradient(135deg, #050b16 0%, #0a1628 100%);
    padding: 2rem;
    display: flex;
    align-items: center;
    justify-content: center;
  }
  .onboarding-container {
    background: rgba(10, 18, 38, 0.95);
    border: 1px solid rgba(87, 140, 255, 0.25);
    border-radius: 24px;
    padding: 3rem;
    max-width: 700px;
    width: 100%;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.5);
  }
  .ob-header {
    text-align: center;
    margin-bottom: 2rem;
  }
  .ob-header h1 {
    font-family: 'Orbitron', sans-serif;
    font-size: 1.75rem;
    color: var(--text-primary, #dff5ff);
    margin-bottom: 0.5rem;
  }
  .ob-header p { color: var(--text-secondary, #8ab0c9); font-size: 0.95rem; }
  .ob-progress {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 2rem;
  }
  .ob-step-bar {
    flex: 1;
    height: 4px;
    border-radius: 2px;
    background: rgba(87, 125, 196, 0.2);
    transition: all 0.3s;
  }
  .ob-step-bar.active    { background: linear-gradient(90deg, var(--accent-primary, #00d4ff), var(--accent-secondary, #8c4dff)); }
  .ob-step-bar.completed { background: var(--accent-success, #00d450); }
  .ob-step-content { margin-bottom: 2rem; }
  .ob-step-title {
    font-family: 'Orbitron', sans-serif;
    font-size: 1.2rem;
    color: var(--text-primary, #dff7ff);
    margin-bottom: 1.5rem;
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }
  .ob-form-group { margin-bottom: 1.25rem; }
  .ob-label {
    display: block;
    color: var(--text-secondary, #8ab0c9);
    font-size: 0.875rem;
    margin-bottom: 0.4rem;
    font-weight: 500;
  }
  .ob-label.required::after { content: ' *'; color: var(--accent-danger, #ff5050); }
  .ob-input, .ob-select {
    width: 100%;
    padding: 0.85rem 1rem;
    background: rgba(87, 125, 196, 0.1);
    border: 1px solid rgba(87, 125, 196, 0.25);
    border-radius: 12px;
    color: var(--text-primary, #dff7ff);
    font-size: 0.95rem;
    box-sizing: border-box;
    transition: all 0.2s;
  }
  .ob-input:focus, .ob-select:focus {
    outline: none;
    border-color: var(--accent-primary, #00d4ff);
    box-shadow: 0 0 0 3px rgba(0, 212, 255, 0.15);
  }
  .ob-input::placeholder { color: rgba(138, 176, 201, 0.5); }
  .ob-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }
  .ob-plan-grid {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 1rem;
    margin-top: 0.5rem;
  }
  .ob-plan-card {
    padding: 1.25rem 1rem;
    background: rgba(87, 125, 196, 0.1);
    border: 2px solid rgba(87, 125, 196, 0.2);
    border-radius: 14px;
    cursor: pointer;
    text-align: center;
    transition: all 0.2s;
  }
  .ob-plan-card:hover {
    border-color: rgba(0, 212, 255, 0.4);
    background: rgba(0, 212, 255, 0.07);
  }
  .ob-plan-card.selected {
    border-color: var(--accent-primary, #00d4ff);
    background: rgba(0, 212, 255, 0.15);
  }
  .ob-plan-name { color: var(--text-primary, #dff7ff); font-weight: 700; font-size: 1rem; margin-bottom: 0.25rem; }
  .ob-plan-cams { color: var(--text-secondary, #8ab0c9); font-size: 0.8rem; margin-bottom: 0.4rem; }
  .ob-plan-price { color: var(--accent-success, #00d450); font-weight: 700; font-size: 0.95rem; }
  .ob-error {
    background: rgba(255, 80, 80, 0.1);
    border: 1px solid rgba(255, 80, 80, 0.3);
    border-radius: 10px;
    padding: 0.85rem 1rem;
    color: #ff8080;
    font-size: 0.9rem;
    margin-bottom: 1.25rem;
    animation: fadeIn 0.2s ease;
  }
  .ob-info {
    background: rgba(0, 212, 255, 0.07);
    border: 1px solid rgba(0, 212, 255, 0.2);
    border-radius: 10px;
    padding: 0.85rem 1rem;
    color: var(--text-secondary, #8ab0c9);
    font-size: 0.875rem;
    margin-bottom: 1.25rem;
  }
  /* Camera connection status */
  .ob-cam-status {
    margin-top: 1.5rem;
    background: rgba(87, 125, 196, 0.08);
    border: 1px solid rgba(87, 125, 196, 0.2);
    border-radius: 14px;
    padding: 1.25rem 1.5rem;
    animation: fadeIn 0.3s ease;
  }
  .ob-cam-step {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.6rem 0;
    font-size: 0.9rem;
    color: var(--text-secondary, #8ab0c9);
  }
  .ob-cam-step.done   { color: var(--accent-success, #00d450); }
  .ob-cam-step.active { color: var(--text-primary, #dff7ff); }
  .ob-cam-step.error  { color: #ff8080; }
  .ob-spinner {
    width: 16px;
    height: 16px;
    border: 2px solid rgba(0, 212, 255, 0.3);
    border-top-color: var(--accent-primary, #00d4ff);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
    flex-shrink: 0;
  }
  .ob-cam-icon { width: 20px; text-align: center; flex-shrink: 0; }
  .ob-cam-result {
    margin-top: 1.25rem;
    padding: 1rem 1.25rem;
    background: rgba(0, 212, 80, 0.08);
    border: 1px solid rgba(0, 212, 80, 0.3);
    border-radius: 12px;
    animation: fadeIn 0.3s ease;
  }
  .ob-cam-result h3 { color: var(--accent-success, #00d450); margin-bottom: 0.5rem; font-size: 1rem; }
  .ob-cam-result p  { color: var(--text-secondary, #8ab0c9); font-size: 0.875rem; margin: 0.2rem 0; }
  .ob-preview-wrap {
    margin-top: 1rem;
    border-radius: 12px;
    overflow: hidden;
    border: 1px solid rgba(87, 125, 196, 0.25);
    background: #000;
  }
  .ob-preview-video {
    width: 100%;
    min-height: 220px;
    background: #000;
    display: block;
  }
  .ob-preview-note {
    color: var(--text-secondary, #8ab0c9);
    font-size: 0.8rem;
    margin-top: 0.5rem;
  }
  /* Connected cameras list */
  .ob-connected-cam {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    background: rgba(0, 212, 80, 0.07);
    border: 1px solid rgba(0, 212, 80, 0.2);
    border-radius: 10px;
    margin-bottom: 0.5rem;
    animation: fadeIn 0.3s ease;
  }
  .ob-connected-cam .cam-name { color: var(--text-primary, #dff7ff); font-weight: 600; font-size: 0.9rem; }
  .ob-connected-cam .cam-model { color: var(--text-secondary, #8ab0c9); font-size: 0.8rem; }
  /* Summary card */
  .ob-summary {
    background: rgba(87, 125, 196, 0.1);
    border: 1px solid rgba(87, 125, 196, 0.2);
    border-radius: 16px;
    padding: 1.5rem;
    margin-bottom: 1.25rem;
  }
  .ob-summary h3 { color: var(--text-primary, #dff7ff); margin-bottom: 1rem; }
  .ob-summary-row {
    display: flex;
    justify-content: space-between;
    padding: 0.6rem 0;
    border-bottom: 1px solid rgba(87, 125, 196, 0.1);
    font-size: 0.9rem;
  }
  .ob-summary-row:last-child { border-bottom: none; }
  .ob-summary-row .label { color: var(--text-secondary, #8ab0c9); }
  .ob-summary-row .value { color: var(--text-primary, #dff7ff); font-weight: 500; }
  /* Navigation */
  .ob-nav {
    display: flex;
    gap: 1rem;
    justify-content: space-between;
    margin-top: 2rem;
  }
  .ob-btn {
    padding: 0.9rem 2rem;
    border-radius: 12px;
    font-weight: 600;
    font-size: 0.95rem;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    gap: 0.5rem;
    border: none;
    text-decoration: none;
  }
  .ob-btn-primary {
    background: linear-gradient(135deg, var(--accent-primary, #00d4ff), var(--accent-secondary, #8c4dff));
    color: #03101c;
    flex: 1;
    justify-content: center;
  }
  .ob-btn-primary:hover:not(:disabled) {
    transform: translateY(-2px);
    box-shadow: 0 8px 25px rgba(0, 212, 255, 0.3);
  }
  .ob-btn-secondary {
    background: rgba(87, 125, 196, 0.15);
    border: 1px solid rgba(87, 125, 196, 0.25) !important;
    color: var(--text-secondary, #8ab0c9);
  }
  .ob-btn-secondary:hover { background: rgba(87, 125, 196, 0.25); color: var(--text-primary, #dff7ff); }
  .ob-btn:disabled { opacity: 0.5; cursor: not-allowed; transform: none !important; }
  .ob-add-another {
    width: 100%;
    padding: 0.85rem;
    background: rgba(0, 212, 255, 0.07);
    border: 2px dashed rgba(0, 212, 255, 0.3);
    border-radius: 12px;
    color: var(--accent-primary, #00d4ff);
    cursor: pointer;
    margin-top: 1rem;
    font-weight: 600;
    font-size: 0.9rem;
    transition: all 0.2s;
  }
  .ob-add-another:hover {
    background: rgba(0, 212, 255, 0.12);
    border-color: rgba(0, 212, 255, 0.5);
  }
  .ob-success-icon { font-size: 4rem; text-align: center; margin-bottom: 1.25rem; }
  .ob-success-msg { text-align: center; color: var(--text-secondary, #8ab0c9); margin-bottom: 2rem; }
  .ob-success-msg h2 { font-family: 'Orbitron', sans-serif; color: var(--accent-success, #00d450); margin-bottom: 0.5rem; }
  @media (max-width: 600px) {
    .ob-row, .ob-plan-grid { grid-template-columns: 1fr; }
    .onboarding-container { padding: 1.5rem; }
  }
`;

const PLANS = {
  starter:    { name: 'Standard',    cameras: 5,  price: '$500/mo',  tier: 'starter' },
  growth:     { name: 'Business',    cameras: 15, price: '$950/mo',  tier: 'growth' },
  enterprise: { name: 'Enterprise',  cameras: 50, price: '$1,500/mo', tier: 'enterprise' },
};

// Maps the step-code returned by /api/onboarding/connect-camera to
// the furthest "done" step index in the animated progress list.
const STEP_INDEX = { discovered: 0, rtsp_validated: 1, mediamtx_registered: 2, online: 3 };

export default function Onboarding() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();

  // Wizard state
  const [step, setStep] = useState(1);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  // Step 1 – plan selection
  const urlPlan = searchParams.get('plan');
  const urlPaymentId = searchParams.get('payment');
  const [paymentId] = useState(() => urlPaymentId || readPendingPayment()?.paymentId || '');
  const [planTier, setPlanTier] = useState(
    PLANS[urlPlan] ? urlPlan : 'starter',
  );

  useEffect(() => {
    const pendingPayment = readPendingPayment();
    if (pendingPayment?.planId && PLANS[pendingPayment.planId]) {
      setPlanTier(pendingPayment.planId);
    }
    if (urlPaymentId && pendingPayment?.paymentId && pendingPayment.paymentId !== urlPaymentId) {
      clearPendingPayment();
    }
  }, [urlPaymentId]);

  // Step 2 – account + org
  const [orgName, setOrgName]     = useState('');
  const [email, setEmail]         = useState('');
  const [phone, setPhone]         = useState('');
  const [address, setAddress]     = useState('');
  const [password, setPassword]   = useState('');
  const [confirm, setConfirm]     = useState('');

  // Step 3 – camera connection
  const [camIp, setCamIp]         = useState('');
  const [camPort, setCamPort]     = useState('80');
  const [camUser, setCamUser]     = useState('');
  const [camPass, setCamPass]     = useState('');
  const [connecting, setConnecting] = useState(false);
  const [connectedCams, setConnectedCams] = useState([]);
  const [camProgress, setCamProgress] = useState(null); // null | 'discovering' | step code | 'error'
  const [camError, setCamError]     = useState('');
  const [lastConnectedCam, setLastConnectedCam] = useState(null);
  const [previewError, setPreviewError] = useState('');
  const [previewReady, setPreviewReady] = useState(false);
  const previewVideoRef = useRef(null);
  const hlsRef = useRef(null);

  // ── Helpers ─────────────────────────────────────────────────────────────────

  useEffect(() => {
    const video = previewVideoRef.current;
    const streamUrl = lastConnectedCam?.hls_url;
    setPreviewError('');
    setPreviewReady(false);

    if (!video || !streamUrl) return undefined;

    if (hlsRef.current) {
      hlsRef.current.destroy();
      hlsRef.current = null;
    }
    video.src = '';

    if (Hls.isSupported()) {
      const hls = new Hls({ lowLatencyMode: true });
      hlsRef.current = hls;

      hls.on(Hls.Events.MANIFEST_PARSED, () => {
        setPreviewReady(true);
        video.play().catch(() => {});
      });
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (data?.fatal) setPreviewError('Live preview is not available yet. Stream is still warming up.');
      });

      hls.loadSource(streamUrl);
      hls.attachMedia(video);
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = streamUrl;
      video.addEventListener('loadedmetadata', () => {
        setPreviewReady(true);
        video.play().catch(() => {});
      }, { once: true });
    } else {
      setPreviewError('Your browser does not support HLS playback preview.');
    }

    return () => {
      if (hlsRef.current) {
        hlsRef.current.destroy();
        hlsRef.current = null;
      }
      if (video) video.src = '';
    };
  }, [lastConnectedCam?.hls_url]);

  // ── Step 2: account + org setup ─────────────────────────────────────────────

  async function handleRegister() {
    setError('');
    if (!orgName.trim()) return setError('Organization name is required.');
    if (!email.trim())   return setError('Email address is required.');
    if (password.length < 8) return setError('Password must be at least 8 characters.');
    if (password !== confirm)  return setError('Passwords do not match.');

    setLoading(true);
    try {
      const pendingPayment = readPendingPayment();
      // 1. Create the Better Auth account (sets session cookie)
      await signUp(email.trim(), password, orgName.trim());

      // 2. Create the organization and link the user to it
      await api.post('/onboarding/register', {
        orgName: orgName.trim(),
        phone:   phone.trim() || undefined,
        address: address.trim() || undefined,
        planTier,
        paymentId: paymentId || pendingPayment?.paymentId || undefined,
      });

      clearPendingPayment();
      setStep(3);
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Registration failed. Please try again.';
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  // ── Step 3: camera connection ────────────────────────────────────────────────

  async function handleConnectCamera() {
    setCamError('');
    if (!camIp.trim()) { setCamError('Camera IP address is required.'); return; }

    setConnecting(true);
    setCamProgress('discovering');

    try {
      // Create a setup task — the local media node will pick it up and run ONVIF discovery
      const { data: createData } = await api.post('/cameras?path=setup-create', {
        mode: 'onvif',
        ip: camIp.trim(),
        onvif_port: camPort ? parseInt(camPort, 10) : 80,
        username: camUser || undefined,
        password: camPass || undefined,
      });
      const taskId = createData.taskId;

      // Poll for completion
      const deadline = Date.now() + 90000;
      let taskResult = null;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 2000));
        try {
          const { data: pollData } = await api.get(`/cameras?path=setup-get&id=${taskId}`);
          const task = pollData.task;
          if (task.status === 'done' || task.status === 'failed') {
            taskResult = task;
            break;
          }
        } catch { /* keep polling */ }
      }

      if (!taskResult) {
        throw new Error('Timed out waiting for the media node. Ensure it is online and connected.');
      }
      if (taskResult.status === 'failed') {
        throw new Error(taskResult.error || 'Camera discovery failed.');
      }

      const parsed = typeof taskResult.result === 'string' ? JSON.parse(taskResult.result) : taskResult.result;

      // Animate through discovered steps
      const step = 'online'; // task completed = camera is online
      const reachedIndex = STEP_INDEX[step] ?? 0;
      const steps = ['discovered', 'rtsp_validated', 'mediamtx_registered', 'online'];
      for (let i = 0; i <= reachedIndex; i++) {
        await new Promise((r) => setTimeout(r, 600));
        setCamProgress(steps[i] || step);
      }

      const newCam = {
        id:                  taskResult.camera_id || parsed?.camera_id,
        name:                parsed?.camera_name || `Camera ${camIp.trim()}`,
        manufacturer:        parsed?.manufacturer || 'Unknown',
        model:               parsed?.model || 'Unknown',
        hls_url:             parsed?.hls_url || null,
        hls_verified:        parsed?.hls_verified || false,
        mediamtx_registered: true,
        rtsp_reachable:      parsed?.rtsp_reachable !== false,
        step:                step,
      };

      setConnectedCams((prev) => [...prev, newCam]);
      setLastConnectedCam(newCam);

      // Clear form for potential additional camera
      setCamIp('');
      setCamPort('80');
      setCamUser('');
      setCamPass('');
      setCamProgress(step);
    } catch (err) {
      const msg = err?.response?.data?.error || err?.message || 'Camera connection failed.';
      setCamError(msg);
      setCamProgress('error');
    } finally {
      setConnecting(false);
    }
  }

  // ── Step 4: complete onboarding ──────────────────────────────────────────────

  async function handleComplete() {
    setLoading(true);
    try {
      await api.post('/onboarding/complete');
    } catch {
      // Non-fatal — redirect anyway
    }
    navigate('/dashboard');
  }

  // ── Status display helpers ──────────────────────────────────────────────────

  function CamStepRow({ index, label, currentIndex }) {
    const done  = currentIndex !== null && currentIndex !== 'discovering' && currentIndex !== 'error'
      && STEP_INDEX[currentIndex] >= index;
    const isErr = currentIndex === 'error' && index === 0;
    const active = currentIndex === 'discovering' && index === 0
      || (currentIndex !== null && !done && !isErr && STEP_INDEX[currentIndex] < index && index === STEP_INDEX[currentIndex] + 1);

    let icon;
    if (done)   icon = '✅';
    else if (isErr) icon = '❌';
    else if (active || (currentIndex === 'discovering' && index === 0)) icon = <span className="ob-spinner" />;
    else icon = '○';

    return (
      <div className={`ob-cam-step ${done ? 'done' : isErr ? 'error' : ''}`}>
        <span className="ob-cam-icon">{icon}</span>
        <span>{label}</span>
      </div>
    );
  }

  // ── Render ───────────────────────────────────────────────────────────────────

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="onboarding-page">
        <div className="onboarding-container">

          {/* Header */}
          <div className="ob-header">
            <h1>🚀 Setup Your Security System</h1>
            <p>Complete your account in a few simple steps</p>
          </div>

          {/* Progress bar — 4 steps */}
          <div className="ob-progress">
            {[1, 2, 3, 4].map((s) => (
              <div key={s} className={`ob-step-bar ${s < step ? 'completed' : s === step ? 'active' : ''}`} />
            ))}
          </div>

          <div className="ob-step-content">

            {/* ── STEP 1: Plan selection ────────────────────────────────── */}
            {step === 1 && (
              <>
                <h2 className="ob-step-title"><span>📦</span> Choose Your Plan</h2>

                <div className="ob-plan-grid">
                  {Object.entries(PLANS).map(([key, plan]) => (
                    <div
                      key={key}
                      className={`ob-plan-card ${planTier === key ? 'selected' : ''}`}
                      onClick={() => setPlanTier(key)}
                    >
                      <div className="ob-plan-name">{plan.name}</div>
                      <div className="ob-plan-cams">{plan.cameras} cameras</div>
                      <div className="ob-plan-price">{plan.price}</div>
                    </div>
                  ))}
                </div>

                <div className="ob-info" style={{ marginTop: '1.5rem' }}>
                  Selected plan: <strong style={{ color: 'var(--text-primary, #dff7ff)' }}>{PLANS[planTier].name}</strong> —
                  up to <strong style={{ color: 'var(--accent-primary, #00d4ff)' }}>{PLANS[planTier].cameras} cameras</strong>,
                  {' '}{PLANS[planTier].price}
                </div>
              </>
            )}

            {/* ── STEP 2: Account + Organization ───────────────────────── */}
            {step === 2 && (
              <>
                <h2 className="ob-step-title"><span>🏢</span> Account &amp; Organization</h2>

                {error && <div className="ob-error">⚠ {error}</div>}

                <div className="ob-form-group">
                  <label className="ob-label required">Organization Name</label>
                  <input className="ob-input" type="text"
                    placeholder="Your Company / Business Name"
                    value={orgName} onChange={(e) => setOrgName(e.target.value)} />
                </div>

                <div className="ob-row">
                  <div className="ob-form-group">
                    <label className="ob-label required">Email</label>
                    <input className="ob-input" type="email"
                      placeholder="you@company.com"
                      value={email} onChange={(e) => setEmail(e.target.value)} />
                  </div>
                  <div className="ob-form-group">
                    <label className="ob-label">Phone</label>
                    <input className="ob-input" type="tel"
                      placeholder="+1 555 123 4567"
                      value={phone} onChange={(e) => setPhone(e.target.value)} />
                  </div>
                </div>

                <div className="ob-form-group">
                  <label className="ob-label">Address / Location</label>
                  <input className="ob-input" type="text"
                    placeholder="123 Business Street, City"
                    value={address} onChange={(e) => setAddress(e.target.value)} />
                </div>

                <div className="ob-row">
                  <div className="ob-form-group">
                    <label className="ob-label required">Password</label>
                    <input className="ob-input" type="password"
                      placeholder="Min. 8 characters"
                      value={password} onChange={(e) => setPassword(e.target.value)} />
                  </div>
                  <div className="ob-form-group">
                    <label className="ob-label required">Confirm Password</label>
                    <input className="ob-input" type="password"
                      placeholder="Repeat password"
                      value={confirm} onChange={(e) => setConfirm(e.target.value)} />
                  </div>
                </div>
              </>
            )}

            {/* ── STEP 3: Connect Camera ────────────────────────────────── */}
            {step === 3 && (
              <>
                <h2 className="ob-step-title"><span>📹</span> Connect Your Camera</h2>

                <div className="ob-info">
                  Enter your camera's IP address and ONVIF credentials below.
                  The system automatically discovers the video stream — no RTSP URL needed.
                </div>

                {/* Previously connected cameras */}
                {connectedCams.length > 0 && (
                  <div style={{ marginBottom: '1.5rem' }}>
                    <p style={{ color: 'var(--text-secondary, #8ab0c9)', fontSize: '0.875rem', marginBottom: '0.5rem' }}>
                      ✅ Connected cameras ({connectedCams.length}):
                    </p>
                    {connectedCams.map((cam) => (
                      <div key={cam.id} className="ob-connected-cam">
                        <span style={{ fontSize: '1.2rem' }}>📷</span>
                        <div>
                          <div className="cam-name">{cam.name}</div>
                          <div className="cam-model">{cam.manufacturer} {cam.model} — {cam.id}</div>
                        </div>
                        <span style={{ marginLeft: 'auto', color: 'var(--accent-success, #00d450)', fontSize: '0.85rem' }}>
                          {cam.step === 'online' ? '🟢 Online' : cam.step === 'mediamtx_registered' ? '🟡 Registered' : '⚪ Found'}
                        </span>
                      </div>
                    ))}
                  </div>
                )}

                <div className="ob-form-group">
                  <label className="ob-label required">Camera IP Address</label>
                  <input className="ob-input" type="text"
                    placeholder="e.g. 192.168.1.50"
                    value={camIp}
                    onChange={(e) => { setCamIp(e.target.value); setCamError(''); setCamProgress(null); }}
                    disabled={connecting} />
                </div>

                <div className="ob-row">
                  <div className="ob-form-group">
                    <label className="ob-label">ONVIF Username</label>
                    <input className="ob-input" type="text"
                      placeholder="admin"
                      value={camUser} onChange={(e) => setCamUser(e.target.value)}
                      disabled={connecting} />
                  </div>
                  <div className="ob-form-group">
                    <label className="ob-label">ONVIF Password</label>
                    <input className="ob-input" type="password"
                      placeholder="Camera password"
                      value={camPass} onChange={(e) => setCamPass(e.target.value)}
                      disabled={connecting} />
                  </div>
                </div>

                <div className="ob-form-group">
                  <label className="ob-label">ONVIF Port</label>
                  <input className="ob-input" type="number"
                    placeholder="80"
                    value={camPort} onChange={(e) => setCamPort(e.target.value)}
                    disabled={connecting}
                    style={{ maxWidth: '140px' }} />
                </div>

                {/* Connection progress */}
                {(camProgress !== null || connecting) && (
                  <div className="ob-cam-status">
                    <div className={`ob-cam-step ${camProgress && camProgress !== 'discovering' && camProgress !== 'error' ? 'done' : camProgress === 'discovering' ? 'active' : camProgress === 'error' ? 'error' : ''}`}>
                      <span className="ob-cam-icon">
                        {camProgress === 'discovering' ? <span className="ob-spinner" /> :
                         camProgress === 'error' ? '❌' :
                         camProgress ? '✅' : '○'}
                      </span>
                      <span>🔍 Discovering camera via ONVIF...</span>
                    </div>
                    <div className={`ob-cam-step ${STEP_INDEX[camProgress] >= 1 ? 'done' : ''}`}>
                      <span className="ob-cam-icon">
                        {STEP_INDEX[camProgress] >= 1 ? '✅' : '○'}
                      </span>
                      <span>📡 Retrieving RTSP stream URI and validating stream reachability</span>
                    </div>
                    <div className={`ob-cam-step ${STEP_INDEX[camProgress] >= 2 ? 'done' : ''}`}>
                      <span className="ob-cam-icon">
                        {STEP_INDEX[camProgress] >= 2 ? '✅' : '○'}
                      </span>
                      <span>🎬 Registering with media server (MediaMTX)</span>
                    </div>
                    <div className={`ob-cam-step ${STEP_INDEX[camProgress] >= 3 ? 'done' : ''}`}>
                      <span className="ob-cam-icon">
                        {STEP_INDEX[camProgress] >= 3 ? '✅' : '○'}
                      </span>
                      <span>🟢 Verifying HLS playback and live state</span>
                    </div>
                  </div>
                )}

                {/* Success result */}
                {lastConnectedCam && camProgress && camProgress !== 'discovering' && camProgress !== 'error' && (
                  <div className="ob-cam-result">
                    <h3>✅ Camera Connected!</h3>
                    <p><strong style={{ color: 'var(--text-primary, #dff7ff)' }}>{lastConnectedCam.manufacturer} {lastConnectedCam.model}</strong></p>
                    <p>Camera ID: <code style={{ color: 'var(--accent-primary, #00d4ff)', fontFamily: 'monospace' }}>{lastConnectedCam.id}</code></p>
                    <p>
                      Stream validation: {lastConnectedCam.rtsp_reachable ? 'RTSP reachable' : 'RTSP endpoint discovered (reachability limited)'}
                    </p>
                    <p>
                      Media registration: {lastConnectedCam.mediamtx_registered ? 'Registered in MediaMTX' : 'Pending MediaMTX confirmation'}
                    </p>
                    <p>
                      HLS playback: {lastConnectedCam.hls_verified ? 'Verified' : 'Provisioned (warming up)'}
                    </p>

                    {lastConnectedCam.hls_url && (
                      <div className="ob-preview-wrap">
                        <video
                          ref={previewVideoRef}
                          className="ob-preview-video"
                          controls
                          muted
                          playsInline
                        />
                      </div>
                    )}
                    {previewError && <p className="ob-preview-note">⚠ {previewError}</p>}
                    {!previewError && lastConnectedCam.hls_url && !previewReady && (
                      <p className="ob-preview-note">Preparing live preview… this can take a few seconds.</p>
                    )}
                  </div>
                )}

                {/* Camera error */}
                {camError && (
                  <div className="ob-error" style={{ marginTop: '1rem' }}>
                    ⚠ {camError}
                    <br />
                    <small>You can skip this step and add cameras later from the dashboard.</small>
                  </div>
                )}

                <button
                  className="ob-btn ob-btn-primary"
                  onClick={handleConnectCamera}
                  disabled={connecting || !camIp.trim()}
                  style={{ marginTop: '1rem', width: '100%', justifyContent: 'center' }}
                >
                  {connecting ? <><span className="ob-spinner" style={{ width: 14, height: 14, borderTopColor: '#03101c' }} /> Connecting…</> : '🔗 Connect Camera'}
                </button>

                {connectedCams.length > 0 && (
                  <button
                    className="ob-add-another"
                    onClick={() => { setCamProgress(null); setCamError(''); }}
                  >
                    + Add Another Camera
                  </button>
                )}
              </>
            )}

            {/* ── STEP 4: Done ──────────────────────────────────────────── */}
            {step === 4 && (
              <>
                <div className="ob-success-icon">🎉</div>
                <div className="ob-success-msg">
                  <h2>You&apos;re All Set!</h2>
                  <p>Your security monitoring system has been configured and is ready to use.</p>
                </div>

                <div className="ob-summary">
                  <h3>📋 Setup Summary</h3>
                  <div className="ob-summary-row">
                    <span className="label">Organization</span>
                    <span className="value">{orgName}</span>
                  </div>
                  <div className="ob-summary-row">
                    <span className="label">Plan</span>
                    <span className="value" style={{ color: 'var(--accent-primary, #00d4ff)' }}>
                      {PLANS[planTier].name} — {PLANS[planTier].price}
                    </span>
                  </div>
                  <div className="ob-summary-row">
                    <span className="label">Cameras Connected</span>
                    <span className="value" style={{ color: 'var(--accent-success, #00d450)' }}>
                      {connectedCams.length} / {PLANS[planTier].cameras}
                    </span>
                  </div>
                  {email && (
                    <div className="ob-summary-row">
                      <span className="label">Account Email</span>
                      <span className="value">{email}</span>
                    </div>
                  )}
                </div>

                {connectedCams.length === 0 && (
                  <div className="ob-info">
                    No cameras were connected during setup. You can add cameras at any time from the
                    Cameras page in your dashboard.
                  </div>
                )}

                <button
                  className="ob-btn ob-btn-primary"
                  onClick={handleComplete}
                  disabled={loading}
                  style={{ width: '100%', justifyContent: 'center' }}
                >
                  {loading ? 'Loading…' : '🚀 Go to Dashboard'}
                </button>
              </>
            )}

          </div>{/* end step-content */}

          {/* ── Navigation buttons ────────────────────────────────────── */}
          {step < 4 && (
            <div className="ob-nav">
              {step > 1 && !loading && !connecting && (
                <button className="ob-btn ob-btn-secondary" onClick={() => { setError(''); setStep(step - 1); }}>
                  ← Back
                </button>
              )}

              {/* Step 1 → 2 */}
              {step === 1 && (
                <button className="ob-btn ob-btn-primary" onClick={() => setStep(2)}>
                  Continue →
                </button>
              )}

              {/* Step 2 → 3 (account + org registration) */}
              {step === 2 && (
                <button
                  className="ob-btn ob-btn-primary"
                  onClick={handleRegister}
                  disabled={loading || !orgName || !email || !password || !confirm}
                >
                  {loading ? 'Creating Account…' : 'Create Account →'}
                </button>
              )}

              {/* Step 3 → 4 */}
              {step === 3 && (
                <button
                  className="ob-btn ob-btn-primary"
                  onClick={() => setStep(4)}
                  disabled={connecting}
                >
                  {connectedCams.length > 0 ? 'Continue →' : 'Skip for now →'}
                </button>
              )}
            </div>
          )}

        </div>
      </main>
    </>
  );
}
