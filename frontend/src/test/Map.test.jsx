import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import Map from '../pages/Map';

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(),
  },
}));

import api from '../services/api';

describe('Map', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows loading state initially', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<Map />);
    expect(screen.getByText('Loading map...')).toBeInTheDocument();
  });

  it('shows error state when API fails', async () => {
    api.get.mockRejectedValue(new Error('Network error'));
    render(<Map />);
    await waitFor(() => {
      expect(screen.getByText('Error Loading Map')).toBeInTheDocument();
    });
    expect(screen.getAllByText('Failed to load camera data. Please try again.').length).toBeGreaterThan(0);
  });

  it('shows empty state when no cameras have locations', async () => {
    api.get.mockResolvedValue({
      data: {
        cameras: [
          { id: 1, name: 'Camera 1', enabled: true, lat: null, lng: null },
        ],
      },
    });
    render(<Map />);
    await waitFor(() => {
      expect(screen.getByText('No Camera Locations')).toBeInTheDocument();
    });
  });

  it('shows camera list when cameras are loaded', async () => {
    api.get.mockResolvedValue({
      data: {
        cameras: [
          { id: 1, name: 'Camera 1', enabled: true, lat: 40.7128, lng: -74.006, location: 'NYC' },
          { id: 2, name: 'Camera 2', enabled: false, lat: 34.0522, lng: -118.2437, location: 'LA' },
        ],
      },
    });
    render(<Map />);
    await waitFor(() => {
      expect(screen.getAllByText('Camera 1').length).toBeGreaterThan(0);
      expect(screen.getAllByText('Camera 2').length).toBeGreaterThan(0);
    });
  });

  it('shows sidebar error message when API fails', async () => {
    api.get.mockRejectedValue(new Error('Network error'));
    render(<Map />);
    await waitFor(() => {
      const sidebar = screen.getByText('Camera Locations').parentElement;
      expect(sidebar).toHaveTextContent('Failed to load camera data. Please try again.');
    });
  });

  it('shows sidebar empty state when no cameras exist', async () => {
    api.get.mockResolvedValue({ data: { cameras: [] } });
    render(<Map />);
    await waitFor(() => {
      const sidebar = screen.getByText('Camera Locations').parentElement;
      expect(sidebar).toHaveTextContent('No cameras configured.');
    });
  });

  it('retry button refetches cameras', async () => {
    api.get.mockRejectedValueOnce(new Error('Network error'));
    render(<Map />);
    await waitFor(() => {
      expect(screen.getByText('Error Loading Map')).toBeInTheDocument();
    });

    api.get.mockResolvedValueOnce({
      data: {
        cameras: [{ id: 1, name: 'Camera 1', enabled: true, lat: 40.7128, lng: -74.006 }],
      },
    });

    fireEvent.click(screen.getByText('Retry'));
    await waitFor(() => {
      expect(screen.getAllByText('Camera 1').length).toBeGreaterThan(0);
    });
  });
});
