import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Login from '../pages/Login';

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import api from '../services/api';

describe('Login', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('does not crash when /payments/catalog returns empty plans', async () => {
    api.get.mockResolvedValue({ data: { plans: [] } });

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Loading plans...')).toBeInTheDocument();
    });

    await waitFor(() => {
      expect(screen.queryByText('Loading plans...')).not.toBeInTheDocument();
    });

    expect(screen.queryByText('Failed to load plans.')).not.toBeInTheDocument();
    expect(screen.getByText('Choose your monitoring plan')).toBeInTheDocument();
  });

  it('renders plan cards when catalog returns plans', async () => {
    const mockPlans = [
      { id: 'starter', name: 'Standard Global', amount: '500', limits: { camera_limit: 5 }, features: { aiDetection: true, reports: false, apiAccess: false } },
      { id: 'growth', name: 'Business Global', amount: '950', limits: { camera_limit: 15 }, features: { aiDetection: true, reports: true, apiAccess: true } },
    ];
    api.get.mockResolvedValue({ data: { plans: mockPlans } });

    render(
      <MemoryRouter>
        <Login />
      </MemoryRouter>
    );

    await waitFor(() => {
      expect(screen.getByText('Standard Global')).toBeInTheDocument();
    });
    expect(screen.getByText('Business Global')).toBeInTheDocument();
    expect(screen.getByText('500 / month')).toBeInTheDocument();
    expect(screen.getByText('950 / month')).toBeInTheDocument();
  });
});
