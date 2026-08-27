/**
 * Onboarding wizard -> setup-create location flow tests.
 *
 * Goal: Onboarding.jsx must forward the optional location/lat/lng fields into
 * POST /api/cameras?path=setup-create so they enter the existing e1465d0
 * pipeline (camera_setup_tasks.result JSONB -> camera-setup-agent -> cameras).
 *
 * Backend location propagation is already covered by test/cameras_api.test.js
 * (cases F/B/D/E/H). These tests cover ONLY the Onboarding -> setup-create
 * payload, including null preservation and the manual Add Camera conventions
 * (empty => null, NaN/range rejected, decimal coordinates accepted).
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import api from '../services/api';
import Onboarding from '../pages/Onboarding';

vi.mock('../services/api', () => ({
  default: { post: vi.fn(), get: vi.fn() },
}));
vi.mock('../services/auth-client', () => ({
  signUp: vi.fn().mockResolvedValue({}),
  signIn: vi.fn(),
  signOut: vi.fn(),
  getSession: vi.fn().mockResolvedValue(null),
  getCurrentUser: vi.fn(),
}));
vi.mock('../services/payment-helpers', () => ({
  PENDING_PAYMENT_KEY: 'dnd-pending-payment',
  loadPayPalSdk: vi.fn(),
  loadStripeSdk: vi.fn(),
  readPendingPayment: vi.fn().mockReturnValue(null),
  clearPendingPayment: vi.fn(),
}));

const COMPLETE_TASK = {
  status: 'done',
  result: { camera_id: 'CAM-1', camera_name: 'Discovered Cam', manufacturer: 'X', model: 'Y', hls_url: null },
};

function setupApiMocks(task = COMPLETE_TASK) {
  api.post.mockImplementation((url) => {
    if (url === '/cameras?path=setup-create') return Promise.resolve({ data: { taskId: 'task-1' } });
    if (url === '/onboarding/register') return Promise.resolve({ data: {} });
    return Promise.resolve({ data: {} });
  });
  api.get.mockResolvedValue({ data: { task } });
}

function setupCreateCalls() {
  return api.post.mock.calls.filter(([url]) => url === '/cameras?path=setup-create');
}

// Drives the wizard from the welcome screen through the account form and into
// Step 3 (Connect Camera) so the Connect button can be exercised.
async function advanceToCameraStep() {
  await userEvent.click(await screen.findByRole('button', { name: /continue/i }));
  await userEvent.type(await screen.findByPlaceholderText(/your company/i), 'Test Org');
  await userEvent.type(await screen.findByPlaceholderText(/you@company/i), 'admin@example.com');
  await userEvent.type(await screen.findByPlaceholderText(/min\. 8 characters/i), 'password123');
  await userEvent.type(await screen.findByPlaceholderText(/repeat password/i), 'password123');
  await userEvent.click(await screen.findByRole('button', { name: /create account/i }));
  // Step 3 camera IP field appears after the account is registered.
  await screen.findByPlaceholderText(/e\.g\. 192/i);
}

async function waitForSetupCreate() {
  await waitFor(() => expect(setupCreateCalls().length).toBeGreaterThan(0), { timeout: 5000 });
}

describe('Onboarding -> setup-create location flow', () => {
  beforeEach(() => setupApiMocks());
  afterEach(() => vi.clearAllMocks());

  it('A) setup-create forwards location/lat/lng', async () => {
    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    await advanceToCameraStep();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 192/i), '192.168.1.50');
    await userEvent.type(screen.getByPlaceholderText(/front yard/i), 'Test Location');
    await userEvent.type(screen.getByPlaceholderText(/-90 to 90/i), '45.2671');
    await userEvent.type(screen.getByPlaceholderText(/-180 to 180/i), '19.8335');
    await userEvent.click(screen.getByRole('button', { name: /connect camera/i }));

    await waitForSetupCreate();

    // Let the polling setTimeout(2000) flush so state updates resolve before unmount.
    await new Promise((r) => setTimeout(r, 2300));

    expect(api.post).toHaveBeenCalledWith('/cameras?path=setup-create', expect.objectContaining({
      mode: 'onvif',
      ip: '192.168.1.50',
      onvif_port: 80,
      location: 'Test Location',
      lat: 45.2671,
      lng: 19.8335,
    }));
  });

  it('B) setup-create without location sends nulls (no 0 conversion)', async () => {
    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    await advanceToCameraStep();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 192/i), '192.168.1.50');
    await userEvent.click(screen.getByRole('button', { name: /connect camera/i }));

    await waitForSetupCreate();
    await new Promise((r) => setTimeout(r, 2300));

    const [, body] = setupCreateCalls()[0];
    expect(body.location).toBeNull();
    expect(body.lat).toBeNull();
    expect(body.lng).toBeNull();
  });

  it('C) invalid latitude is rejected before setup-create fires', async () => {
    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    await advanceToCameraStep();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 192/i), '192.168.1.50');
    await userEvent.type(screen.getByPlaceholderText(/-90 to 90/i), '95');
    await userEvent.click(screen.getByRole('button', { name: /connect camera/i }));

    expect(await screen.findByText(/latitude must be a number/i)).toBeInTheDocument();
    expect(setupCreateCalls().length).toBe(0);
  });

  it('D) invalid longitude is rejected before setup-create fires', async () => {
    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    await advanceToCameraStep();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 192/i), '192.168.1.50');
    await userEvent.type(screen.getByPlaceholderText(/-180 to 180/i), '200');
    await userEvent.click(screen.getByRole('button', { name: /connect camera/i }));

    expect(await screen.findByText(/longitude must be a number/i)).toBeInTheDocument();
    expect(setupCreateCalls().length).toBe(0);
  });

  it('E) decimal coordinates are accepted', async () => {
    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    await advanceToCameraStep();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 192/i), '192.168.1.50');
    await userEvent.type(screen.getByPlaceholderText(/-90 to 90/i), '45.1234');
    await userEvent.type(screen.getByPlaceholderText(/-180 to 180/i), '-75.9999');
    await userEvent.click(screen.getByRole('button', { name: /connect camera/i }));

    await waitForSetupCreate();
    await new Promise((r) => setTimeout(r, 2300));

    expect(api.post).toHaveBeenCalledWith('/cameras?path=setup-create', expect.objectContaining({
      lat: 45.1234,
      lng: -75.9999,
    }));
  });

  it('F) existing setup-create fields are preserved', async () => {
    render(<MemoryRouter><Onboarding /></MemoryRouter>);
    await advanceToCameraStep();
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 192/i), '192.168.1.50');
    await userEvent.click(screen.getByRole('button', { name: /connect camera/i }));

    await waitForSetupCreate();
    await new Promise((r) => setTimeout(r, 2300));

    expect(api.post).toHaveBeenCalledWith('/cameras?path=setup-create', expect.objectContaining({
      mode: 'onvif',
      ip: '192.168.1.50',
      onvif_port: 80,
    }));
  });
});
