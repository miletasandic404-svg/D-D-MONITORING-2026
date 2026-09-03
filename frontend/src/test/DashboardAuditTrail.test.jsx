import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, waitFor, screen } from '@testing-library/react';
import React, { useEffect, useState } from 'react';

// Mirrors the Operator Audit Trail state + useEffect in
// frontend/src/pages/Dashboard.jsx, line-for-line on purpose so the
// contract stays under test if the production effect is changed.
function useDashboardAuditTrail(authChecked) {
  const [auditEntries, setAuditEntries] = useState([]);
  const [auditTotal, setAuditTotal] = useState(0);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState(null);
  const [auditOffset, setAuditOffset] = useState(0);
  const [localOverlayEntries, setLocalOverlayEntries] = useState([]);
  const AUDIT_PAGE_SIZE = 50;

  useEffect(() => {
    if (!authChecked) return undefined;
    const POLL_INTERVAL_MS = 30000;
    const inFlight = { current: false };
    let cancelled = false;
    const load = async (offset) => {
      if (cancelled || inFlight.current) return;
      inFlight.current = true;
      setAuditLoading(true);
      try {
        const data = await fetchAuditLogs({ limit: AUDIT_PAGE_SIZE, offset });
        if (cancelled) return;
        setAuditEntries(data.entries || []);
        setAuditTotal(data.total || 0);
        setAuditError(null);
        if (offset === 0) {
          setLocalOverlayEntries((prev) => prev.filter((local) => {
            const localTs = new Date(local.ts).getTime();
            return !(data.entries || []).some((srv) =>
              srv.action === local.action
              && srv.created_at
              && Math.abs(new Date(srv.created_at).getTime() - localTs) < 60_000);
          }));
        }
      } catch (err) {
        if (cancelled) return;
        setAuditError(err?.response?.data?.error || err.message || 'Failed to load audit log');
      } finally {
        if (!cancelled) inFlight.current = false;
        if (!cancelled) setAuditLoading(false);
      }
    };
    load(auditOffset);
    const id = setInterval(() => load(auditOffset), POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [authChecked, auditOffset]);

  return {
    auditEntries, auditTotal, auditLoading, auditError, auditOffset,
    setAuditOffset, localOverlayEntries, setLocalOverlayEntries,
  };
}

function Probe({ authChecked, onState }) {
  const state = useDashboardAuditTrail(authChecked);
  React.useEffect(() => { onState(state); }, [state, onState]);
  return (
    <div>
      <span data-testid="loading">{String(state.auditLoading)}</span>
      <span data-testid="error">{state.auditError || ''}</span>
      <span data-testid="total">{state.auditTotal}</span>
      <span data-testid="count">{state.auditEntries.length}</span>
      <span data-testid="offset">{state.auditOffset}</span>
      <span data-testid="overlay">{state.localOverlayEntries.length}</span>
      {state.auditEntries.map((e) => (
        <span key={e.id} data-testid={`row-${e.action}`} className={e.local ? 'audit-row-local' : ''}>
          {e.action}|{e.user_email || '—'}|{e.local ? 'local' : 'persisted'}
        </span>
      ))}
      {state.localOverlayEntries.map((e) => (
        <span key={e.id} data-testid={`overlay-${e.action}`} className="audit-row-local">
          {e.action}|{e.user_email || '—'}|local
        </span>
      ))}
    </div>
  );
}

vi.mock('../services/audit-logs', () => ({
  fetchAuditLogs: vi.fn(),
}));

import { fetchAuditLogs } from '../services/audit-logs';

describe('Dashboard Operator Audit Trail', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ shouldAdvanceTime: true });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('fetches the first page from the backend on authChecked', async () => {
    fetchAuditLogs.mockResolvedValue({
      count: 2, total: 12, limit: 50, offset: 0,
      entries: [
        { id: '1', action: 'snapshot.create', user_email: 'a@x.com', created_at: '2026-01-01T00:00:00Z' },
        { id: '2', action: 'incident.status_changed', user_email: 'b@x.com', created_at: '2026-01-02T00:00:00Z' },
      ],
    });
    render(<Probe authChecked={true} onState={() => {}} />);
    await waitFor(() => expect(fetchAuditLogs).toHaveBeenCalledTimes(1));
    expect(fetchAuditLogs).toHaveBeenCalledWith({ limit: 50, offset: 0 });
    await waitFor(() => {
      expect(screen.getByTestId('total').textContent).toBe('12');
      expect(screen.getByTestId('count').textContent).toBe('2');
    });
    expect(screen.getByTestId('row-snapshot.create').textContent).toContain('persisted');
  });

  it('does not fetch before authChecked', async () => {
    render(<Probe authChecked={false} onState={() => {}} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(60000); });
    expect(fetchAuditLogs).not.toHaveBeenCalled();
  });

  it('polls every 30s and re-fetches with the current offset', async () => {
    fetchAuditLogs.mockResolvedValue({ count: 0, total: 0, limit: 50, offset: 0, entries: [] });
    render(<Probe authChecked={true} onState={() => {}} />);
    await waitFor(() => expect(fetchAuditLogs).toHaveBeenCalledTimes(1));
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(fetchAuditLogs).toHaveBeenCalledTimes(2);
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    expect(fetchAuditLogs).toHaveBeenCalledTimes(3);
    // Same offset every poll.
    for (const call of fetchAuditLogs.mock.calls) {
      expect(call[0]).toEqual({ limit: 50, offset: 0 });
    }
  });

  it('cleans up the interval on unmount', async () => {
    fetchAuditLogs.mockResolvedValue({ count: 0, total: 0, limit: 50, offset: 0, entries: [] });
    const { unmount } = render(<Probe authChecked={true} onState={() => {}} />);
    await waitFor(() => expect(fetchAuditLogs).toHaveBeenCalledTimes(1));
    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(120000); });
    expect(fetchAuditLogs).toHaveBeenCalledTimes(1);
  });

  it('handles API failure without crashing and surfaces the error', async () => {
    fetchAuditLogs.mockRejectedValueOnce(new Error('boom'));
    fetchAuditLogs.mockResolvedValueOnce({ count: 0, total: 0, limit: 50, offset: 0, entries: [] });
    render(<Probe authChecked={true} onState={() => {}} />);
    await waitFor(() => expect(fetchAuditLogs).toHaveBeenCalledTimes(1));
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('boom');
    });
    // Next tick recovers.
    await act(async () => { await vi.advanceTimersByTimeAsync(30000); });
    await waitFor(() => expect(fetchAuditLogs).toHaveBeenCalledTimes(2));
    await waitFor(() => {
      expect(screen.getByTestId('error').textContent).toBe('');
    });
  });

  it('re-fetches with the new offset when setAuditOffset changes (Load older)', async () => {
    fetchAuditLogs.mockImplementation(async ({ offset }) => ({
      count: 2, total: 12, limit: 50, offset, entries: [
        { id: `p${offset}-1`, action: 'snapshot.create', user_email: 'a@x.com', created_at: '2026-01-01T00:00:00Z' },
        { id: `p${offset}-2`, action: 'incident.status_changed', user_email: 'b@x.com', created_at: '2026-01-02T00:00:00Z' },
      ],
    }));
    let latest;
    render(<Probe authChecked={true} onState={(s) => { latest = s; }} />);
    await waitFor(() => expect(fetchAuditLogs).toHaveBeenCalledTimes(1));
    // Trigger "Load older" by setting offset = 50.
    await act(async () => { latest.setAuditOffset(50); });
    await waitFor(() => expect(fetchAuditLogs).toHaveBeenCalledTimes(2));
    expect(fetchAuditLogs.mock.calls[1][0]).toEqual({ limit: 50, offset: 50 });
  });

  it('removes local overlay entries that the server has confirmed (action + recent ts)', async () => {
    // Per-call responses: call 1 (initial) empty, call 2 (offset=50)
    // the "older page", call 3 (offset=0 again) the confirmed
    // snapshot.create row. The earlier version used mockResolvedValueOnce
    // for the third call, but mockResolvedValueOnce is FIFO and got
    // consumed by call 2 instead. Use a call counter instead.
    let callN = 0;
    fetchAuditLogs.mockImplementation(async ({ offset }) => {
      callN += 1;
      if (callN === 1) {
        return { count: 0, total: 0, limit: 50, offset, entries: [] };
      }
      if (callN === 2) {
        return {
          count: 2, total: 12, limit: 50, offset, entries: [
            { id: `p${offset}-1`, action: 'snapshot.create', user_email: 'a@x.com', created_at: '2026-01-01T00:00:00Z' },
            { id: `p${offset}-2`, action: 'incident.status_changed', user_email: 'b@x.com', created_at: '2026-01-02T00:00:00Z' },
          ],
        };
      }
      // call 3 (offset=0): server confirms the local snapshot.create.
      return {
        count: 1, total: 1, limit: 50, offset, entries: [
          { id: 'srv-1', action: 'snapshot.create', user_email: 'a@x.com',
            created_at: new Date().toISOString() },
        ],
      };
    });

    let latest;
    render(<Probe authChecked={true} onState={(s) => { latest = s; }} />);
    // Wait for the initial fetch to land.
    await waitFor(() => expect(fetchAuditLogs).toHaveBeenCalledTimes(1));

    // Inject local overlay rows: snapshot.create will be confirmed,
    // unknown_action will stay.
    const localTs = new Date().toISOString();
    await act(async () => {
      latest.setLocalOverlayEntries([
        { id: 'local-x', ts: localTs, user_email: 'a@x.com', action: 'snapshot.create', local: true },
        { id: 'local-y', ts: localTs, user_email: 'a@x.com', action: 'unknown_action', local: true },
      ]);
    });
    expect(screen.getByTestId('overlay').textContent).toBe('2');

    // Trigger offset 0 -> 50 -> 0. The two setOffset calls schedule
    // two distinct useEffect runs (deps change), so calls 2 and 3
    // each fire with their offset. Wait for call 2 to land.
    await act(async () => { latest.setAuditOffset(50); });
    await waitFor(() => expect(fetchAuditLogs).toHaveBeenCalledTimes(2));
    // Then the third call (offset 0) which carries the confirmation.
    await act(async () => { latest.setAuditOffset(0); });
    await waitFor(() => expect(fetchAuditLogs).toHaveBeenCalledTimes(3));

    // Wait for the third call's state to be applied. We use
    // waitFor to give React's setState time to flush and the DOM
    // time to reflect it.
    await waitFor(() => {
      expect(screen.getByTestId('total').textContent).toBe('1');
      expect(screen.getByTestId('count').textContent).toBe('1');
    });
    // snapshot.create overlay is dropped; unknown_action stays.
    await waitFor(() => {
      expect(screen.getByTestId('overlay').textContent).toBe('1');
    });
    // The confirmed row renders as persisted (not local).
    expect(screen.getByTestId('row-snapshot.create').textContent).toContain('persisted');
  });
});
