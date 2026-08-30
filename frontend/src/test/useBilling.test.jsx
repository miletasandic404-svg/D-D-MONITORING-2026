import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../services/api', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
  },
}));

vi.mock('../services/billing', () => ({
  fetchSubscriptionState: vi.fn(),
}));

vi.mock('../services/payment-helpers', () => ({
  loadPayPalSdk: vi.fn(),
  loadStripeSdk: vi.fn(),
}));

import api from '../services/api';
import { fetchSubscriptionState } from '../services/billing';
import { useBilling, PLAN_OPTIONS, formatPlanOption } from '../hooks/useBilling';

describe('useBilling', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('defaults to the "growth" plan and paypal payment method', () => {
    const { result } = renderHook(() => useBilling());
    expect(result.current.selectedPlan.id).toBe('growth');
    expect(result.current.paymentMethod).toBe('paypal');
    expect(result.current.paymentStep).toBe('details');
  });

  it('emergencyFieldsComplete is false until all contact fields are filled', () => {
    const { result } = renderHook(() => useBilling());
    expect(result.current.emergencyFieldsComplete).toBe(false);

    act(() => {
      result.current.setEmergencyDistrict('Downtown');
      result.current.setEmergencyContacts({
        policeStation: '110',
        fireService: '112',
        ambulance: '194',
        localCommand: 'HQ-7',
      });
    });

    expect(result.current.emergencyFieldsComplete).toBe(true);
  });

  it('startCheckout blocks with a message when emergency contacts are incomplete', () => {
    const { result } = renderHook(() => useBilling());

    act(() => {
      result.current.startCheckout();
    });

    expect(result.current.checkoutStatus).toMatch(/Fill emergency contacts/);
    expect(result.current.paymentStep).toBe('details');
  });

  it('startCheckout advances to the checkout step once contacts are complete', () => {
    const { result } = renderHook(() => useBilling());

    act(() => {
      result.current.setEmergencyDistrict('Downtown');
      result.current.setEmergencyContacts({
        policeStation: '110',
        fireService: '112',
        ambulance: '194',
        localCommand: 'HQ-7',
      });
    });

    act(() => {
      result.current.startCheckout();
    });

    expect(result.current.paymentStep).toBe('checkout');
  });

  it('startCheckout calls addAuditEntry with the chosen payment method', () => {
    const addAuditEntry = vi.fn();
    const { result } = renderHook(() => useBilling({ addAuditEntry }));

    act(() => {
      result.current.setEmergencyDistrict('Downtown');
      result.current.setEmergencyContacts({
        policeStation: '110',
        fireService: '112',
        ambulance: '194',
        localCommand: 'HQ-7',
      });
    });

    act(() => {
      result.current.startCheckout();
    });

    expect(addAuditEntry).toHaveBeenCalledWith(expect.stringContaining('paypal'));
  });

  it('switching payment method is reflected in state', () => {
    const { result } = renderHook(() => useBilling());
    act(() => {
      result.current.setPaymentMethod('card');
    });
    expect(result.current.paymentMethod).toBe('card');
  });

  describe('loadBillingState', () => {
    it('syncs subscription state and available plans from the API', async () => {
      fetchSubscriptionState.mockResolvedValue({
        subscription: { planId: 'enterprise', planName: 'Enterprise Global', status: 'active' },
        plans: [
          { id: 'enterprise', name: 'Enterprise Global', amount: '1500', limits: { camera_limit: 0 }, features: {} },
        ],
      });

      const { result } = renderHook(() => useBilling());

      await act(async () => {
        await result.current.loadBillingState();
      });

      expect(result.current.subscriptionState).toEqual({ planId: 'enterprise', planName: 'Enterprise Global', status: 'active' });
      expect(result.current.selectedPlanId).toBe('enterprise');
      expect(result.current.availablePlans[0].name).toBe('Enterprise Global');
    });

    it('does not throw when the API call fails, and leaves prior state intact', async () => {
      fetchSubscriptionState.mockRejectedValue(new Error('network down'));
      const { result } = renderHook(() => useBilling());

      await act(async () => {
        await result.current.loadBillingState();
      });

      // Falls back to the default plan list rather than crashing.
      expect(result.current.availablePlans).toEqual(PLAN_OPTIONS);
    });
  });

  describe('formatPlanOption', () => {
    it('formats a backend plan object into UI-ready shape', () => {
      const formatted = formatPlanOption({
        id: 'growth',
        name: 'Business Global',
        amount: '950',
        limits: { camera_limit: 15 },
        features: { aiDetection: true, reports: true, apiAccess: false },
      });

      expect(formatted).toEqual({
        id: 'growth',
        name: 'Business Global',
        price: '$950 / month',
        paypalAmount: '950',
        features: [
          'Up to 15 cameras / locations',
          'AI detection included',
          'Reports included',
          'No API access',
        ],
      });
    });

    it('falls back to "Unlimited" when camera_limit is 0', () => {
      const formatted = formatPlanOption({
        id: 'enterprise',
        name: 'Enterprise Global',
        amount: '1500',
        limits: { camera_limit: 0 },
        features: {},
      });

      expect(formatted.features[0]).toBe('Unlimited cameras / locations');
    });
  });
});
