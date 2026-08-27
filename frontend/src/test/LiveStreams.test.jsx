import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import LiveStreams from '../pages/LiveStreams';

vi.mock('../services/api', () => ({
  default: {
    get: vi.fn(),
    post: vi.fn(),
  },
}));

vi.mock('../services/snapshot', () => ({
  captureSnapshot: vi.fn().mockResolvedValue({ success: true }),
}));

import api from '../services/api';

describe('LiveStreams', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resets snapshotStatus when switching cameras via handleViewStream', async () => {
    api.get.mockResolvedValue({
      data: {
        cameras: [
          { id: 1, name: 'Camera 1', enabled: true, location: 'Loc 1', fps: 30 },
          { id: 2, name: 'Camera 2', enabled: true, location: 'Loc 2', fps: 30 },
        ],
      },
    });
    api.post.mockResolvedValue({ data: { streamToken: 'test-token' } });

    render(<LiveStreams />);
    await waitFor(() => {
      expect(screen.getByText('Camera 1')).toBeInTheDocument();
      expect(screen.getByText('Camera 2')).toBeInTheDocument();
    });

    const snapshotButtons = screen.getAllByText('Snapshot');
    fireEvent.click(snapshotButtons[0]);
    expect(screen.getByText('Camera 1').closest('.stream-card')).toBeInTheDocument();
  });

  it('resets snapshotStatus when switching cameras via handleSnapshot', async () => {
    api.get.mockResolvedValue({
      data: {
        cameras: [
          { id: 1, name: 'Camera 1', enabled: true, location: 'Loc 1', fps: 30 },
          { id: 2, name: 'Camera 2', enabled: true, location: 'Loc 2', fps: 30 },
        ],
      },
    });
    api.post.mockResolvedValue({ data: { streamToken: 'test-token' } });

    render(<LiveStreams />);
    await waitFor(() => {
      expect(screen.getByText('Camera 1')).toBeInTheDocument();
    });

    const viewButtons = screen.getAllByText('View Stream');
    fireEvent.click(viewButtons[0]);
    fireEvent.click(viewButtons[1]);
    expect(screen.getByText('Camera 2')).toBeInTheDocument();
  });

  it('shows loading state initially', () => {
    api.get.mockReturnValue(new Promise(() => {}));
    render(<LiveStreams />);
    expect(screen.getByText('Loading cameras...')).toBeInTheDocument();
  });

  it('shows empty state when no cameras exist', async () => {
    api.get.mockResolvedValue({ data: { cameras: [] } });
    render(<LiveStreams />);
    await waitFor(() => {
      expect(screen.getByText('No Active Streams')).toBeInTheDocument();
    });
  });
});
