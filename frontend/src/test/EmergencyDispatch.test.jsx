import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import EmergencyDispatch from '../pages/EmergencyDispatch';

const mockContacts = {
  police: { name: 'Police', phone: '+1 555 0001', enabled: true },
  fire: { name: 'Fire Department', phone: '+1 555 0002', enabled: true },
  ambulance: { name: 'Ambulance', phone: '+1 555 0003', enabled: false },
  security: { name: 'Security', phone: '+1 555 0004', enabled: true },
};

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import api from '../services/api';

describe('EmergencyDispatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows configured emergency contacts from settings API', async () => {
    api.get.mockResolvedValueOnce({ data: { dispatches: [] } });
    api.get.mockResolvedValueOnce({ data: { settings: { emergency_contacts: mockContacts } } });

    render(<EmergencyDispatch />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));

    expect(screen.getByText('Police')).toBeDefined();
    expect(screen.getByText('+1 555 0001')).toBeDefined();
    expect(screen.getByText('Fire Department')).toBeDefined();
    expect(screen.getByText('+1 555 0002')).toBeDefined();
    expect(screen.queryByText('Ambulance')).toBeNull();
    expect(screen.getByText('Security')).toBeDefined();
  });

  it('shows empty state when no emergency contacts are configured', async () => {
    api.get.mockResolvedValueOnce({ data: { dispatches: [] } });
    api.get.mockResolvedValueOnce({ data: { settings: { emergency_contacts: {} } } });

    render(<EmergencyDispatch />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));

    expect(screen.getByText('Emergency contacts are not configured. Please configure them in Settings.')).toBeDefined();
  });

  it('does not expose contacts from other organizations', async () => {
    api.get.mockResolvedValueOnce({ data: { dispatches: [] } });
    api.get.mockResolvedValueOnce({ data: { settings: { emergency_contacts: mockContacts } } });

    render(<EmergencyDispatch />);
    await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));

    expect(screen.queryByText('+1 555 0003')).toBeNull();
  });
});
