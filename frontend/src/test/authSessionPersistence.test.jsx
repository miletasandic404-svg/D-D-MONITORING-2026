import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';
import { getSession, signOut } from '../services/auth-client';

vi.mock('../services/auth-client');

function ProtectedRoute() {
  const { authChecked, currentUser } = useAuth();
  if (!authChecked) return <div data-testid="loading">Loading</div>;
  return currentUser ? <div data-testid="protected">Dashboard</div> : <div data-testid="login">Login</div>;
}

describe('authenticated session persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('hydrates a valid server session after protected-route reload', async () => {
    getSession.mockResolvedValue({ user: { id: 'user-1', user_type: 'operator' } });

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<ProtectedRoute />} />
          <Route path="/" element={<div data-testid="login">Login</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('protected')).toBeTruthy());
    expect(getSession).toHaveBeenCalled();
  });

  it('does not call sign-out when session hydration reports no session', async () => {
    getSession.mockResolvedValue(null);

    render(
      <MemoryRouter initialEntries={['/dashboard']}>
        <Routes>
          <Route path="/dashboard" element={<ProtectedRoute />} />
          <Route path="/" element={<div data-testid="login">Login</div>} />
        </Routes>
      </MemoryRouter>,
    );

    await waitFor(() => expect(screen.getByTestId('login')).toBeTruthy());
    expect(getSession).toHaveBeenCalled();
    expect(signOut).not.toHaveBeenCalled();
  });
});
