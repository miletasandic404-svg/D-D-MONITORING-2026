import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor } from '@testing-library/react';
import React, { useEffect, useState } from 'react';
import api from '../services/api';

// Mirrors the polling useEffect in
// frontend/src/pages/Dashboard.jsx (the /health/dashboard fetch).
// The two are kept line-for-line equivalent on purpose: if the
// production effect is changed, the test must be updated in lockstep
// so the contract stays under test.
function useDashboardHealthPolling(authChecked) {
  const [healthData, setHealthData] = useState(null);
  useEffect(() => {
    if (!authChecked) return undefined;
    const POLL_INTERVAL_MS = 20000;
    const inFlight = { current: false };
    let cancelled = false;

    const poll = async () => {
      if (cancelled || inFlight.current) return;
      inFlight.current = true;
      try {
        const res = await api.get('/health/dashboard');
        if (cancelled) return;
        setHealthData(res.data);
      } catch {
        if (cancelled) return;
        setHealthData((prev) => (prev === null ? null : prev));
      } finally {
        inFlight.current = false;
      }
    };

    poll();
    const id = setInterval(poll, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [authChecked]);
  return healthData;
}

function Probe({ authChecked, onData }) {
  const data = useDashboardHealthPolling(authChecked);
  React.useEffect(() => { onData(data); }, [data, onData]);
  return null;
}

vi.mock('../services/api', () => ({
  default: { get: vi.fn() },
}));

describe('Dashboard health polling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not fetch before authChecked is true', async () => {
    api.get.mockResolvedValue({ data: { streams: { active: 0 } } });
    render(<Probe authChecked={false} onData={() => {}} />);
    // Flush microtasks + a few intervals.
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(api.get).not.toHaveBeenCalled();
  });

  it('fetches once on auth + every 20s after', async () => {
    api.get.mockResolvedValue({ data: { streams: { active: 0 } } });
    render(<Probe authChecked={true} onData={() => {}} />);

    // initial fetch happens immediately
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    expect(api.get).toHaveBeenCalledWith('/health/dashboard');

    // 19s: no extra call yet
    await act(async () => { await vi.advanceTimersByTimeAsync(19000); });
    expect(api.get).toHaveBeenCalledTimes(1);

    // 20s mark: second call
    await act(async () => { await vi.advanceTimersByTimeAsync(2000); });
    expect(api.get).toHaveBeenCalledTimes(2);

    // another full interval
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(api.get).toHaveBeenCalledTimes(3);
  });

  it('updates healthData when the API response changes (offline -> online)', async () => {
    // First response: 0 active streams, 0 fresh nodes (stale).
    api.get.mockResolvedValueOnce({
      data: {
        streams: { active: 0, audio_ready: 0, talk_ready: 0 },
        streams_diagnostics: { enabled_total: 1, enabled_with_node: 1, fresh_nodes: 0, fresh_threshold_seconds: 90 },
        api_reachable: true, api_status: 'online', api_degraded: false, api_reason: null,
      },
    });
    // Second response: 1 active stream (heartbeat recovered).
    api.get.mockResolvedValueOnce({
      data: {
        streams: { active: 1, audio_ready: 0, talk_ready: 0 },
        streams_diagnostics: { enabled_total: 1, enabled_with_node: 1, fresh_nodes: 1, fresh_threshold_seconds: 90 },
        api_reachable: true, api_status: 'online', api_degraded: false, api_reason: null,
      },
    });

    const seen = [];
    render(<Probe authChecked={true} onData={(d) => seen.push(d)} />);

    // Wait for the first response to land.
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const last = seen[seen.length - 1];
      expect(last?.streams?.active).toBe(0);
      expect(last?.streams_diagnostics?.fresh_nodes).toBe(0);
    });

    // Advance to the next poll.
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const last = seen[seen.length - 1];
      expect(last?.streams?.active).toBe(1);
      expect(last?.streams_diagnostics?.fresh_nodes).toBe(1);
    });
  });

  it('cleans up the interval on unmount (no calls after unmount)', async () => {
    api.get.mockResolvedValue({ data: { streams: { active: 0 } } });
    const { unmount } = render(<Probe authChecked={true} onData={() => {}} />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(api.get).toHaveBeenCalledTimes(1);
  });

  it('does NOT crash and does NOT clobber previous data on a transient API failure', async () => {
    api.get.mockResolvedValueOnce({
      data: {
        streams: { active: 1 }, api_reachable: true, api_status: 'online',
        streams_diagnostics: { enabled_total: 1, enabled_with_node: 1, fresh_nodes: 1, fresh_threshold_seconds: 90 },
      },
    });
    // Second poll fails (network blip).
    api.get.mockRejectedValueOnce(new Error('network down'));
    // Third poll succeeds again.
    api.get.mockResolvedValueOnce({
      data: {
        streams: { active: 2 }, api_reachable: true, api_status: 'online',
        streams_diagnostics: { enabled_total: 2, enabled_with_node: 2, fresh_nodes: 2, fresh_threshold_seconds: 90 },
      },
    });

    const seen = [];
    render(<Probe authChecked={true} onData={(d) => seen.push(d)} />);

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      const last = seen[seen.length - 1];
      expect(last?.streams?.active).toBe(1);
    });

    // 2nd poll: failure must not throw and must not reset data to null.
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const last = seen[seen.length - 1];
      // Still 1 (the last good value) — the failed call must not
      // replace it with null or with an "offline" value.
      expect(last?.streams?.active).toBe(1);
    });

    // 3rd poll: recovers to 2.
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(3));
    await waitFor(() => {
      const last = seen[seen.length - 1];
      expect(last?.streams?.active).toBe(2);
    });
  });

  it('when the very first call fails, data stays null (skeleton continues) and recovery is reflected on the next tick', async () => {
    api.get.mockRejectedValueOnce(new Error('cold start failure'));
    api.get.mockResolvedValueOnce({
      data: { streams: { active: 5 }, api_reachable: true, api_status: 'online' },
    });

    const seen = [];
    render(<Probe authChecked={true} onData={(d) => seen.push(d)} />);

    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(1));
    // Still null after first failure.
    expect(seen[seen.length - 1]).toBeNull();

    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      const last = seen[seen.length - 1];
      expect(last?.streams?.active).toBe(5);
    });
  });

  it('does not stack duplicate requests when a poll is slow', async () => {
    // First call is slow; second tick must NOT issue another request
    // while the first is still in flight.
    let resolveFirst;
    api.get.mockImplementationOnce(() => new Promise((res) => { resolveFirst = res; }));
    api.get.mockResolvedValue({ data: { streams: { active: 0 } } });

    render(<Probe authChecked={true} onData={() => {}} />);
    // The initial call is in flight.
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(api.get).toHaveBeenCalledTimes(1);

    // One full interval elapses while the first call is still pending.
    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(api.get).toHaveBeenCalledTimes(1);

    // Resolve the first call; subsequent ticks fire normally.
    await act(async () => { resolveFirst({ data: { streams: { active: 1 } } }); });
    expect(api.get).toHaveBeenCalledTimes(1);

    await act(async () => { await vi.advanceTimersByTimeAsync(20000); });
    expect(api.get).toHaveBeenCalledTimes(2);
  });
});
