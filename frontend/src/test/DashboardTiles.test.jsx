/**
 * Dashboard tile semantics — verifies the four tiles rendered in the
 * "Security Command Center" header match the business meaning of
 * their labels. Specifically:
 *   - "Offline Cameras"  must count cameras whose heartbeat says
 *                         they are unreachable (c.status === 'offline'),
 *                         NOT cameras the operator has disabled.
 *   - "Open Alerts"      must include New, Acknowledged AND In Progress.
 *   - "Incidents Today"  must use the server-reported total (uncapped
 *                         by the 100-row page limit), and the sub-label
 *                         must read "Total incidents" (not "detections").
 *   - "Recent Events"    chip must say "Today" (the SQL is bounded by
 *                         CURRENT_DATE, not a rolling 24-hour window).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

const mocks = vi.hoisted(() => ({
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
  getSession: vi.fn(async () => ({ token: 'sess', user: { id: 'u1', name: 'Op' } })),
  signOut: vi.fn(async () => {}),
  fetchAuditLogs: vi.fn(async () => ({ entries: [], total: 0 })),
}));

vi.mock('../services/api', () => ({
  default: {
    get: mocks.apiGet,
    post: mocks.apiPost,
    patch: mocks.apiPatch,
  },
}));
vi.mock('../services/auth-client', () => ({
  getSession: mocks.getSession,
  getCurrentUser: () => ({ id: 'u1', name: 'Op' }),
  signOut: mocks.signOut,
}));
vi.mock('../services/audit-logs', () => ({
  fetchAuditLogs: mocks.fetchAuditLogs,
}));
vi.mock('../services/snapshot', () => ({
  captureSnapshot: vi.fn(async () => ({ id: 'snap1' })),
}));
vi.mock('../hooks/useBilling', () => ({
  useBilling: () => ({
    subscription: null, loading: false,
    showBilling: false, setShowBilling: vi.fn(),
    loadBillingState: vi.fn(async () => {}),
    startCheckout: vi.fn(),
    handleCardCheckout: vi.fn(),
    emergencyDistrict: '',
    emergencyContacts: {},
    selectedPlan: null,
    paypalButtonsRef: { current: null },
    cardElementRef: { current: null },
  }),
}));
const stableNavigate = vi.fn();
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => stableNavigate,
  };
});
vi.mock('hls.js', () => ({
  default: vi.fn().mockImplementation(() => ({
    loadSource: vi.fn(), attachMedia: vi.fn(), destroy: vi.fn(),
    on: vi.fn(), off: vi.fn(),
  })),
  isSupported: () => false,
}));

import React from 'react';
import Dashboard from '../pages/Dashboard.jsx';

function wireApiMock({ cameras, incidents, incidentsTotal, health }) {
  mocks.apiGet.mockImplementation(async (url) => {
    if (url === '/cameras') return { data: { cameras } };
    if (url === '/camera-setup/node') return { data: { node: null } };
    if (url === '/health/dashboard') return { data: health };
    if (url === '/incidents') return { data: { incidents, total: incidentsTotal } };
    return { data: {} };
  });
  mocks.apiPost.mockImplementation(async (url) => {
    if (url === '/camera-views') return { data: { streamToken: 'tok' } };
    return { data: {} };
  });
  mocks.apiPatch.mockImplementation(async () => ({ data: {} }));
}

async function renderDashboard() {
  let result;
  await act(async () => {
    result = render(<MemoryRouter><Dashboard /></MemoryRouter>);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
  return result;
}

describe('Dashboard tile semantics', () => {
  it('Offline Cameras = count of c.status === "offline" (NOT enabled === false)', async () => {
    wireApiMock({
      cameras: [
        { id: 'cam1', name: 'A', connection_type: 'dvrip', enabled: true,  status: 'online'  },
        { id: 'cam2', name: 'B', connection_type: 'dvrip', enabled: true,  status: 'offline' },
        { id: 'cam3', name: 'C', connection_type: 'dvrip', enabled: false, status: 'online'  },
        { id: 'cam4', name: 'D', connection_type: 'dvrip', enabled: true,  status: 'offline' },
        { id: 'cam5', name: 'E', connection_type: 'dvrip', enabled: true,  status: null      },
      ],
      incidents: [],
      incidentsTotal: 0,
      health: { streams: { active: 0 }, streams_diagnostics: { enabled_with_node: 0, enabled_total: 0, fresh_nodes: 0, fresh_threshold_seconds: 90 } },
    });
    await renderDashboard();
    await waitFor(() => {
      // Heading present.
      expect(screen.getByText('Offline Cameras')).toBeInTheDocument();
    });
    // The card with "Offline Cameras" heading must show the count 2
    // (cam2 + cam4 are offline; cam3 is disabled but online; cam5
    // has unknown status and is NOT counted as offline).
    const headings = screen.getAllByText('Offline Cameras');
    const card = headings[0].closest('article');
    expect(card).not.toBeNull();
    expect(card.querySelector('strong').textContent).toBe('2');
    // Sub-label must reflect the heartbeat-based definition.
    expect(card.textContent).toMatch(/[Uu]nreachable/);
    // Sub-label must NOT lie by saying "Disabled".
    expect(card.textContent).not.toMatch(/Disabled/);
  });

  it('Open Alerts = New + Acknowledged + In Progress (sub-label must say so)', async () => {
    wireApiMock({
      cameras: [],
      incidents: [
        { id: '1', event_id: 1, status: 'New',           object_type: 'person',  confidence: 0.9, camera_id: 'cam1', timestamp: '2026-01-01T00:00:00Z' },
        { id: '2', event_id: 2, status: 'Acknowledged',  object_type: 'person',  confidence: 0.8, camera_id: 'cam1', timestamp: '2026-01-01T00:01:00Z' },
        { id: '3', event_id: 3, status: 'In Progress',   object_type: 'vehicle', confidence: 0.7, camera_id: 'cam1', timestamp: '2026-01-01T00:02:00Z' },
        { id: '4', event_id: 4, status: 'Resolved',      object_type: 'person',  confidence: 0.9, camera_id: 'cam1', timestamp: '2026-01-01T00:03:00Z' },
        { id: '5', event_id: 5, status: 'False Alarm',   object_type: 'animal',  confidence: 0.5, camera_id: 'cam1', timestamp: '2026-01-01T00:04:00Z' },
      ],
      incidentsTotal: 5,
      health: { streams: { active: 0 }, streams_diagnostics: { enabled_with_node: 0, enabled_total: 0, fresh_nodes: 0, fresh_threshold_seconds: 90 } },
    });
    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Open Alerts')).toBeInTheDocument();
    });
    const card = screen.getAllByText('Open Alerts')[0].closest('article');
    expect(card.querySelector('strong').textContent).toBe('3');
    // Sub-label MUST include all three open states.
    const sub = card.querySelector('span');
    expect(sub.textContent).toMatch(/[Nn]ew/);
    expect(sub.textContent).toMatch(/[Aa]cknowledged/);
    expect(sub.textContent).toMatch(/[Ii]n [Pp]rogress/);
  });

  it('Incidents Today uses server-reported total, not the 100-row page cap', async () => {
    wireApiMock({
      cameras: [],
      // Simulate a high-volume day: 137 today, but the list only
      // returns 100 (LIMIT 100). The tile must show 137.
      incidents: Array.from({ length: 100 }, (_, i) => ({
        id: String(i), event_id: i, status: 'New', object_type: 'person',
        confidence: 0.9, camera_id: 'cam1', timestamp: '2026-01-01T00:00:00Z',
      })),
      incidentsTotal: 137,
      health: { streams: { active: 0 }, streams_diagnostics: { enabled_with_node: 0, enabled_total: 0, fresh_nodes: 0, fresh_threshold_seconds: 90 } },
    });
    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Incidents Today')).toBeInTheDocument();
    });
    const card = screen.getAllByText('Incidents Today')[0].closest('article');
    expect(card.querySelector('strong').textContent).toBe('137');
    // Sub-label must read "Total incidents", not "Total detections".
    const subText = card.textContent;
    expect(subText).toMatch(/Total incidents/);
    expect(subText).not.toMatch(/detections/);
  });

  it('Incidents Today falls back to incidents.length when server omits total', async () => {
    wireApiMock({
      cameras: [],
      incidents: [
        { id: '1', event_id: 1, status: 'New', object_type: 'person', confidence: 0.9, camera_id: 'cam1', timestamp: '2026-01-01T00:00:00Z' },
        { id: '2', event_id: 2, status: 'New', object_type: 'person', confidence: 0.9, camera_id: 'cam1', timestamp: '2026-01-01T00:01:00Z' },
      ],
      // No `total` field — older API.
      health: { streams: { active: 0 }, streams_diagnostics: { enabled_with_node: 0, enabled_total: 0, fresh_nodes: 0, fresh_threshold_seconds: 90 } },
    });
    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Incidents Today')).toBeInTheDocument();
    });
    const card = screen.getAllByText('Incidents Today')[0].closest('article');
    expect(card.querySelector('strong').textContent).toBe('2');
  });

  it('Recent Events chip says "Today" (not "Last 24h", which would imply a rolling window)', async () => {
    wireApiMock({
      cameras: [],
      incidents: [
        { id: '1', event_id: 1, status: 'New', object_type: 'person', confidence: 0.9, camera_id: 'cam1', timestamp: '2026-01-01T00:00:00Z' },
      ],
      incidentsTotal: 1,
      health: { streams: { active: 0 }, streams_diagnostics: { enabled_with_node: 0, enabled_total: 0, fresh_nodes: 0, fresh_threshold_seconds: 90 } },
    });
    await renderDashboard();
    await waitFor(() => {
      expect(screen.getByText('Recent Events')).toBeInTheDocument();
    });
    // Find the section header "Recent Events" and inspect the
    // sibling chip.
    const heading = screen.getByText('Recent Events');
    const section = heading.closest('section');
    expect(section).not.toBeNull();
    expect(section.textContent).toMatch(/Today/);
    expect(section.textContent).not.toMatch(/Last 24h/);
  });
});
