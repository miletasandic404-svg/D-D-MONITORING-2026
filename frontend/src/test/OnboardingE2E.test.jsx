/**
 * Onboarding end-to-end flow test.
 *
 * Validates the complete user journey without real PayPal/backend calls:
 *   Step 1 (Choose Plan)
 *     → Step 2 (Payment & Subscription) with mocked PayPal success
 *     → Step 3 (Emergency Contacts)
 *     → Step 4 (Account / Organization Data) → /api/onboarding/register
 *     → Step 5 (Camera Setup)
 *     → Step 6 (Secure Console) → navigate('/dashboard')
 *
 * All PayPal and API interactions are mocked via vi.mock().
 * This file lives under src/test/ so it is NOT included in production builds.
 */
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

import api from '../services/api';
import Onboarding from '../pages/Onboarding';
import { loadPayPalSdk, storePendingPayment } from '../services/payment-helpers';

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
vi.mock('../services/payment-helpers', () => {
  let storedPayment = null;
  return {
    PENDING_PAYMENT_KEY: 'dnd-pending-payment',
    loadPayPalSdk: vi.fn(),
    loadStripeSdk: vi.fn(),
    readPendingPayment: vi.fn().mockImplementation(() => storedPayment),
    clearPendingPayment: vi.fn().mockImplementation(() => { storedPayment = null; }),
    storePendingPayment: vi.fn().mockImplementation((data) => { storedPayment = data; }),
  };
});

const MOCK_PAYMENT_ID = 'PAY-E2E-12345';
const MOCK_ORDER_ID = 'ORDER-E2E-67890';

const mockPayPalButtons = () => ({
  render: vi.fn().mockResolvedValue(undefined),
  isEligible: vi.fn().mockReturnValue(true),
});

const createMockPayPalSdk = () => ({
  Buttons: vi.fn().mockImplementation((config) => {
    const buttons = mockPayPalButtons();
    buttons._createOrder = config.createOrder;
    buttons._onApprove = config.onApprove;
    buttons._onCancel = config.onCancel;
    buttons._onError = config.onError;
    setTimeout(() => {
      (async () => {
        try {
          const orderId = await config.createOrder?.();
          await config.onApprove?.({ orderID: orderId || MOCK_ORDER_ID });
        } catch (err) {
          config.onError?.(err);
        }
      })();
    }, 0);
    return buttons;
  }),
});

function setupApiMocks() {
  api.post.mockImplementation((url) => {
    if (url === '/paypal/orders') {
      return Promise.resolve({ data: { id: MOCK_ORDER_ID, status: 'CREATED' } });
    }
    if (url === `/paypal/orders/${MOCK_ORDER_ID}/capture`) {
      return Promise.resolve({
        data: {
          paymentId: MOCK_PAYMENT_ID,
          planId: 'starter',
          status: 'COMPLETED',
        },
      });
    }
    if (url === '/onboarding/register') {
      return Promise.resolve({ data: { success: true } });
    }
    if (url === '/onboarding/complete') {
      return Promise.resolve({ data: { success: true } });
    }
    if (url === '/cameras?path=setup-create') {
      return Promise.resolve({ data: { taskId: 'task-e2e-1' } });
    }
    return Promise.resolve({ data: {} });
  });

  api.get.mockImplementation((url) => {
    if (url.includes('setup-get')) {
      return Promise.resolve({
        data: {
          task: {
            status: 'done',
            result: {
              camera_id: 'CAM-E2E-1',
              camera_name: 'Test Camera',
              manufacturer: 'Test',
              model: 'E2E',
              hls_url: 'http://localhost:8888/test/stream.m3u8',
            },
          },
        },
      });
    }
    return Promise.resolve({ data: { task: { status: 'done', result: {} } } });
  });
}

describe('Onboarding E2E flow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupApiMocks();
    vi.mocked(loadPayPalSdk).mockResolvedValue(createMockPayPalSdk());
    vi.mocked(storePendingPayment).mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
    vi.mocked(loadPayPalSdk).mockResolvedValue(createMockPayPalSdk());
  });

  it('completes full onboarding: plan → payment → contacts → registration → camera → dashboard', async () => {
    render(<MemoryRouter><Onboarding /></MemoryRouter>);

    // ── STEP 1: Choose Plan ────────────────────────────────────────────────
    await waitFor(() => expect(screen.getByText('Choose Your Plan')).toBeInTheDocument());

    // 'starter' plan is selected by default; proceed to payment
    await userEvent.click(screen.getByRole('button', { name: /continue to payment/i }));

    // ── STEP 2: PayPal Payment ────────────────────────────────────────────
    await waitFor(() => expect(screen.getByText('Payment & Subscription')).toBeInTheDocument());

    // Verify PayPal SDK loaded
    expect(loadPayPalSdk).toHaveBeenCalledWith('test-paypal-client-id', 'USD');

    // Verify createOrder was called
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/paypal/orders', expect.objectContaining({
        planId: expect.any(String),
        district: '',
        contacts: {
          policeStation: '',
          fireService: '',
          ambulance: '',
          localCommand: '',
        },
        idempotencyKey: expect.any(String),
      }));
    }, { timeout: 5000 });

    // Verify capture was called
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith(`/paypal/orders/${MOCK_ORDER_ID}/capture`);
    }, { timeout: 5000 });

    // Verify paymentId was stored
    expect(storePendingPayment).toHaveBeenCalledWith({
      provider: 'paypal',
      paymentId: MOCK_PAYMENT_ID,
      paymentReference: MOCK_ORDER_ID,
      planId: 'starter',
    });

    // Verify payment confirmation message
    await waitFor(() =>
      expect(screen.getByText(/Payment confirmed/)).toBeInTheDocument(),
      { timeout: 5000 }
    );

    // Navigate to Step 3
    await waitFor(() => expect(screen.getByRole('button', { name: /continue/i })).not.toBeDisabled());
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    // ── STEP 3: Emergency Contacts ────────────────────────────────────────
    await waitFor(() => expect(screen.getByText('Emergency Contacts')).toBeInTheDocument());

    // Fill emergency contacts
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. Central District/i), 'Central District');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 911 or \+1 555 0001/i), '911');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 911 or \+1 555 0002/i), '911');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. 911 or \+1 555 0003/i), '911');
    await userEvent.type(screen.getByPlaceholderText(/e\.g\. \+1 555 0004/i), '911');

    // Navigate to Step 4
    await userEvent.click(screen.getByRole('button', { name: /continue/i }));

    // ── STEP 4: Account / Organization Data ──────────────────────────────
    await waitFor(() => expect(screen.getByText('Account & Organization')).toBeInTheDocument());

    // Fill registration form
    await userEvent.type(screen.getByPlaceholderText(/your company/i), 'Test Organization');
    await userEvent.type(screen.getByPlaceholderText(/you@company/i), 'admin@example.com');
    await userEvent.type(screen.getByPlaceholderText(/min\. 8 characters/i), 'password123');
    await userEvent.type(screen.getByPlaceholderText(/repeat password/i), 'password123');

    // Submit registration
    await userEvent.click(screen.getByRole('button', { name: /create account/i }));

    // Verify signUp was called
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/onboarding/register', expect.objectContaining({
        orgName: 'Test Organization',
        planTier: 'starter',
        paymentId: MOCK_PAYMENT_ID,
        emergencyDistrict: 'Central District',
        emergencyPolice: '911',
        emergencyFire: '911',
        emergencyAmbulance: '911',
        emergencyCommand: '911',
      }));
    }, { timeout: 5000 });

    // Wait for Step 5 to appear
    await waitFor(() => expect(screen.getByPlaceholderText(/e\.g\. 192/i)).toBeInTheDocument());

    // ── STEP 5: Camera Setup ──────────────────────────────────────────────
    await waitFor(() => expect(screen.getByText('Connect Your Camera')).toBeInTheDocument());

    // Skip camera setup (user can add later)
    await userEvent.click(screen.getByRole('button', { name: /skip for now/i }));

    // ── STEP 6: Secure Console ────────────────────────────────────────────
    await waitFor(() => expect(screen.getByText('Secure Console Ready')).toBeInTheDocument());

    // Complete onboarding and navigate to dashboard
    await userEvent.click(screen.getByRole('button', { name: /go to dashboard/i }));

    // Verify onboarding complete API call was triggered
    await waitFor(() => {
      expect(api.post).toHaveBeenCalledWith('/onboarding/complete');
    }, { timeout: 5000 });

    // Verify the dashboard navigation was initiated (button shows loading state)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /loading/i })).toBeInTheDocument();
    }, { timeout: 5000 });
  }, 30000);
});
