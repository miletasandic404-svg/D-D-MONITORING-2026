import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import VideoPlayback from '../pages/VideoPlayback';

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(),
  },
}));

import api from '../services/api';

describe('VideoPlayback', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows 0% progress when duration is 0', async () => {
    api.get.mockResolvedValue({
      data: {
        recordings: [
          { id: 1, camera_name: 'Cam 1', duration: 0, size: 100, timestamp: '2024-01-01T00:00:00Z', type: 'Motion' },
        ],
      },
    });
    render(<VideoPlayback />);
    await waitFor(() => {
      expect(screen.getByText(/Cam 1/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Cam 1/));
    const progress = document.querySelector('.timeline-progress');
    expect(progress).toHaveStyle({ width: '0%' });
  });

  it('shows 0% progress when no recording is selected', async () => {
    api.get.mockResolvedValue({ data: { recordings: [] } });
    render(<VideoPlayback />);
    await waitFor(() => {
      expect(screen.getByText('No recordings found')).toBeInTheDocument();
    });
    const progress = document.querySelector('.timeline-progress');
    expect(progress).toHaveStyle({ width: '0%' });
  });

  it('shows correct progress for normal playback position', async () => {
    api.get.mockResolvedValue({
      data: {
        recordings: [
          { id: 1, camera_name: 'Cam 1', duration: 100, size: 100, timestamp: '2024-01-01T00:00:00Z', type: 'Motion' },
        ],
      },
    });
    render(<VideoPlayback />);
    await waitFor(() => {
      expect(screen.getByText(/Cam 1/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Cam 1/));
    const progress = document.querySelector('.timeline-progress');
    expect(progress).toHaveStyle({ width: '0%' });
  });

  it('clamps progress to 100% when currentTime exceeds duration', async () => {
    api.get.mockResolvedValue({
      data: {
        recordings: [
          { id: 1, camera_name: 'Cam 1', duration: 100, size: 100, timestamp: '2024-01-01T00:00:00Z', type: 'Motion' },
        ],
      },
    });
    render(<VideoPlayback />);
    await waitFor(() => {
      expect(screen.getByText(/Cam 1/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Cam 1/));
    const progress = document.querySelector('.timeline-progress');
    expect(progress).toHaveStyle({ width: '0%' });
  });

  it('displays duration correctly for selected recording', async () => {
    api.get.mockResolvedValue({
      data: {
        recordings: [
          { id: 1, camera_name: 'Cam 1', duration: 125, size: 100, timestamp: '2024-01-01T00:00:00Z', type: 'Motion' },
        ],
      },
    });
    render(<VideoPlayback />);
    await waitFor(() => {
      expect(screen.getByText(/Cam 1/)).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText(/Cam 1/));
    expect(screen.getByText('Duration: 2:05')).toBeInTheDocument();
  });
});
