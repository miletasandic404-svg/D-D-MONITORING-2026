import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Subscription from '../pages/Subscription';

vi.mock('../services/billing', () => ({
  fetchSubscriptionState: vi.fn(),
}));

import { fetchSubscriptionState } from '../services/billing';

describe('Subscription', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    fetchSubscriptionState.mockReturnValue(new Promise(() => {}));
    render(
      <MemoryRouter>
        <Subscription />
      </MemoryRouter>
    );
    expect(screen.getByText('Loading plan...')).toBeInTheDocument();
  });

  it('renders plan cards and subscription info when API returns data', async () => {
    fetchSubscriptionState.mockResolvedValue({
      subscription: { planName: 'Business Global', status: 'active', organizationName: 'Test Org', limits: { camera_limit: 15 } },
      plans: [
        { id: 'starter', name: 'Standard Global', amount: '500', limits: { camera_limit: 5 }, features: { aiDetection: true, reports: false, apiAccess: false } },
        { id: 'growth', name: 'Business Global', amount: '950', limits: { camera_limit: 15 }, features: { aiDetection: true, reports: true, apiAccess: true } },
      ],
    });

    render(
      <MemoryRouter>
        <Subscription />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Standard Global')).toBeInTheDocument();
    });
    expect(screen.getByText('active')).toBeInTheDocument();
    expect(screen.getByText(/Test Org/)).toBeInTheDocument();
    expect(screen.getByText(/\$500/)).toBeInTheDocument();
    expect(screen.getByText(/\$950/)).toBeInTheDocument();
  });

  it('handles API failure gracefully', async () => {
    fetchSubscriptionState.mockRejectedValue(new Error('Network error'));
    render(
      <MemoryRouter>
        <Subscription />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Loading plan...')).toBeInTheDocument();
    });
  });
});
