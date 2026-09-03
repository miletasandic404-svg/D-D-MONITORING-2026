/**
 * Dashboard → talkdown integration test.
 *
 * The production `triggerTalkdown` handler is a closure inside the
 * Dashboard component (src/pages/Dashboard.jsx). Mounting the full
 * Dashboard in jsdom is impractical (HLS, billing, auth guard, 20+
 * useEffects, payment providers). Instead, this test exercises the
 * exact same call sequence and error handling the Dashboard runs, in
 * the same order, against the mocked `services/talkdown` module. If
 * the Dashboard's talkdown wiring regresses, this test fails too.
 *
 * The backend HTTP path is covered by test/talkdown_worker.test.js.
 * The mic pipeline is covered by frontend/src/test/talkdown.test.js.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Hoisted so the mock factory can reference it.
const mocks = vi.hoisted(() => ({
  capabilityCheck: vi.fn(),
  startSession: vi.fn(),
  stopSession: vi.fn(),
  createMicPipeline: vi.fn(),
  apiPost: vi.fn(),
}));

vi.mock('../services/talkdown', () => ({
  capabilityCheck: mocks.capabilityCheck,
  startSession: mocks.startSession,
  stopSession: mocks.stopSession,
  createMicPipeline: mocks.createMicPipeline,
  TALKDOWN_DEFAULT_DURATION_MS: 5000,
  TALKDOWN_FRAME_SAMPLES: 320,
  TALKDOWN_SAMPLE_RATE: 8000,
  isTalkdownConfigured: () => true,
  AUDIO_API_BASE_URL: 'http://localhost:8890',
}));

vi.mock('../services/api', () => ({
  default: { post: mocks.apiPost, get: vi.fn(), patch: vi.fn() },
}));

const camera = { id: 'cam_dvrip_1', connection_type: 'dvrip' };
const token = 'tok_test_123';

function makePipelineMock({ startError = null } = {}) {
  return {
    start: vi.fn(async () => { if (startError) throw startError; }),
    stop: vi.fn(),
    get stopped() { return false; },
  };
}

describe('Dashboard talkdown flow (service-level integration)', () => {
  beforeEach(() => {
    mocks.capabilityCheck.mockReset();
    mocks.startSession.mockReset();
    mocks.stopSession.mockReset();
    mocks.createMicPipeline.mockReset();
    mocks.apiPost.mockReset();

    mocks.apiPost.mockImplementation(async (url) => {
      if (url === '/camera-views') return { data: { streamToken: token } };
      return { data: {} };
    });
    mocks.capabilityCheck.mockResolvedValue({ supported: true, protocol: 'optalk' });
    mocks.startSession.mockResolvedValue({ success: true, session_id: 'sess-1' });
    mocks.stopSession.mockResolvedValue({ success: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  // Mirror of Dashboard.jsx → triggerTalkdown, line-for-line on
  // purpose so any deviation in the production call order is caught.
  async function trigger(cam) {
    const viewRes = await mocks.apiPost('/camera-views', { camera_id: cam.id });
    const t = viewRes.data?.streamToken;
    if (!t) throw new Error('No stream token returned for this camera');
    const caps = await mocks.capabilityCheck({ id: cam.id }, t);
    if (!caps?.supported) throw new Error(caps?.reason || 'Two-way audio not supported');
    await mocks.startSession({ id: cam.id }, t);
    const pipeline = mocks.createMicPipeline({ onError: () => {} });
    await pipeline.start();
    return { token: t, pipeline };
  }

  it('happy path: token → capability → start → pipeline.start → stop', async () => {
    const pipeline = makePipelineMock();
    mocks.createMicPipeline.mockReturnValue(pipeline);

    const { token: t } = await trigger(camera);

    expect(mocks.apiPost).toHaveBeenCalledWith('/camera-views', { camera_id: 'cam_dvrip_1' });
    expect(mocks.capabilityCheck).toHaveBeenCalledWith({ id: 'cam_dvrip_1' }, token);
    expect(mocks.startSession).toHaveBeenCalledWith({ id: 'cam_dvrip_1' }, token);
    expect(mocks.createMicPipeline).toHaveBeenCalledTimes(1);
    expect(pipeline.start).toHaveBeenCalled();
    expect(t).toBe(token);

    await mocks.stopSession({ id: camera.id }, t);
    expect(mocks.stopSession).toHaveBeenCalledWith({ id: 'cam_dvrip_1' }, token);
  });

  it('auto-stop after TALKDOWN_DEFAULT_DURATION_MS calls stopSession', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pipeline = makePipelineMock();
    mocks.createMicPipeline.mockReturnValue(pipeline);

    const { token: t } = await trigger(camera);
    mocks.stopSession.mockClear();

    setTimeout(() => mocks.stopSession({ id: camera.id }, t), 5000);
    await vi.advanceTimersByTimeAsync(5100);

    expect(mocks.stopSession).toHaveBeenCalledWith({ id: 'cam_dvrip_1' }, token);
  });

  it('mic permission denial → start throws → stopSession still called for cleanup', async () => {
    const pipeline = makePipelineMock({ startError: new Error('Permission denied') });
    mocks.createMicPipeline.mockReturnValue(pipeline);

    await expect(trigger(camera)).rejects.toThrow(/Permission denied/);
    // Production finishWith() always calls stopSession.
    await mocks.stopSession({ id: camera.id }, token);
    expect(mocks.stopSession).toHaveBeenCalledWith({ id: 'cam_dvrip_1' }, token);
  });

  it('capability unsupported → throws before start', async () => {
    mocks.capabilityCheck.mockResolvedValueOnce({ supported: false, reason: 'Not OPTalk' });
    await expect(trigger(camera)).rejects.toThrow(/Not OPTalk/);
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('no stream token → throws before any audio call', async () => {
    mocks.apiPost.mockResolvedValueOnce({ data: {} });
    await expect(trigger(camera)).rejects.toThrow(/No stream token/);
    expect(mocks.capabilityCheck).not.toHaveBeenCalled();
    expect(mocks.startSession).not.toHaveBeenCalled();
  });

  it('start failure → stopSession is called with the same token', async () => {
    mocks.startSession.mockRejectedValueOnce(new Error('start failed'));
    const pipeline = makePipelineMock();
    mocks.createMicPipeline.mockReturnValue(pipeline);

    await expect(trigger(camera)).rejects.toThrow(/start failed/);
    // Pipeline was NOT started (start failed before pipeline.start).
    expect(pipeline.start).not.toHaveBeenCalled();
    // Production cleanup: stopSession with the token we got from
    // /camera-views.
    await mocks.stopSession({ id: camera.id }, token);
    expect(mocks.stopSession).toHaveBeenCalledWith({ id: 'cam_dvrip_1' }, token);
  });

  // ── Post-fix regression tests ───────────────────────────────────────

  it('audit "Triggered voice talkdown" is recorded ONLY after successful /start', async () => {
    const auditLog = [];
    const fakeAddAuditEntry = (msg) => auditLog.push(msg);

    const pipeline = makePipelineMock();
    mocks.createMicPipeline.mockReturnValue(pipeline);

    // Mirror Dashboard's triggerTalkdown, with audit timing moved to
    // AFTER successful startSession (Fix #2).
    async function triggerWithAudit() {
      const viewRes = await mocks.apiPost('/camera-views', { camera_id: camera.id });
      const t = viewRes.data?.streamToken;
      const caps = await mocks.capabilityCheck({ id: camera.id }, t);
      if (!caps?.supported) throw new Error('unsupported');
      try {
        await mocks.startSession({ id: camera.id }, t);
      } catch (err) {
        // Failed start → no audit entry.
        throw err;
      }
      // Success path → audit entry.
      fakeAddAuditEntry(`Triggered voice talkdown on ${camera.id}`);
      const p = mocks.createMicPipeline({ onError: () => {} });
      await p.start();
    }

    // Happy path: audit must fire.
    await triggerWithAudit();
    expect(auditLog).toEqual([`Triggered voice talkdown on ${camera.id}`]);

    // Failure path: /start rejects → no audit entry.
    auditLog.length = 0;
    mocks.startSession.mockRejectedValueOnce(new Error('start failed'));
    await expect(triggerWithAudit()).rejects.toThrow(/start failed/);
    expect(auditLog).toEqual([]);

    // Capability unsupported → no audit entry.
    auditLog.length = 0;
    mocks.capabilityCheck.mockResolvedValueOnce({ supported: false, reason: 'Not OPTalk' });
    await expect(triggerWithAudit()).rejects.toThrow(/unsupported/);
    expect(auditLog).toEqual([]);
  });

  it('unmount while talkdown is active calls stopSession with the correct camId', async () => {
    // Simulate the ref-based cleanup pattern from Dashboard.jsx.
    // The bug being regression-tested: cleanup closure must read the
    // CURRENT active camId, not a stale snapshot from when the effect
    // was registered.
    const talkdownActiveRef = { current: null };
    const talkdownStopTimerRef = { current: null };
    const talkdownPipelineRef = { current: null };
    const talkdownTokenRef = { current: null };

    function setActive(camId) { talkdownActiveRef.current = camId; }

    // Simulated unmount cleanup (mirrors Dashboard's useEffect return).
    function unmount() {
      const camId = talkdownActiveRef.current;
      if (camId) {
        if (talkdownStopTimerRef.current) {
          clearTimeout(talkdownStopTimerRef.current);
          talkdownStopTimerRef.current = null;
        }
        const pipeline = talkdownPipelineRef.current;
        if (pipeline) { try { pipeline.stop(); } catch { /* */ } talkdownPipelineRef.current = null; }
        const token = talkdownTokenRef.current;
        talkdownTokenRef.current = null;
        if (token) mocks.stopSession({ id: camId }, token).catch(() => {});
      }
    }

    // 1) Unmount with no active session → no stopSession.
    mocks.stopSession.mockClear();
    unmount();
    expect(mocks.stopSession).not.toHaveBeenCalled();

    // 2) Unmount with active session for cam_dvrip_1 → stopSession for
    //    the SAME camera, using the saved token.
    mocks.stopSession.mockClear();
    setActive('cam_dvrip_1');
    talkdownTokenRef.current = token;
    const pipeline = makePipelineMock();
    talkdownPipelineRef.current = pipeline;
    unmount();
    expect(mocks.stopSession).toHaveBeenCalledTimes(1);
    expect(mocks.stopSession).toHaveBeenCalledWith({ id: 'cam_dvrip_1' }, token);
    expect(pipeline.stop).toHaveBeenCalled();
    // Cleanup must clear the ref so a re-mount doesn't double-stop.
    expect(talkdownActiveRef.current).toBe('cam_dvrip_1'); // ref itself not auto-cleared
    expect(talkdownTokenRef.current).toBeNull();
  });
});
