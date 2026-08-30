import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import BackToDashboard from '../components/BackToDashboard';

const mockNavigate = vi.fn();

vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual('react-router-dom');
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

describe('BackToDashboard', () => {
  it('renders the dashboard back button', () => {
    mockNavigate.mockClear();
    render(
      <MemoryRouter>
        <BackToDashboard />
      </MemoryRouter>
    );
    expect(screen.getByText('← Dashboard')).toBeInTheDocument();
  });

  it('navigates to /dashboard when clicked', () => {
    mockNavigate.mockClear();
    render(
      <MemoryRouter>
        <BackToDashboard />
      </MemoryRouter>
    );
    fireEvent.click(screen.getByText('← Dashboard'));
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard');
  });
});
