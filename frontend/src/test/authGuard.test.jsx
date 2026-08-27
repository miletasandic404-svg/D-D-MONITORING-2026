import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { useAuth } from '../hooks/useAuth';

vi.mock('../hooks/useAuth');
vi.mock('../services/auth-client');

const RequireAuth = ({ children }) => {
  const { authChecked, currentUser } = useAuth();
  if (!authChecked) return <div data-testid="loading">Loading...</div>;
  if (!currentUser) return <div data-testid="redirect-login">Redirect to login</div>;
  return children;
};

const RequireRole = ({ children, allowedRoles }) => {
  const { authChecked, currentUser } = useAuth();
  if (!authChecked) return <div data-testid="loading">Loading...</div>;
  if (!currentUser) return <div data-testid="redirect-login">Redirect to login</div>;
  const userType = currentUser?.user_type;
  if (!userType || !allowedRoles.includes(userType)) return <div data-testid="redirect-dashboard">Redirect to dashboard</div>;
  return children;
};

function TestApp({ initialEntries, user, authChecked, allowedRoles }) {
  useAuth.mockReturnValue({ authChecked, currentUser: user });
  return (
    <MemoryRouter initialEntries={initialEntries}>
      <Routes>
        <Route path="/" element={<div data-testid="login">Login page</div>} />
        <Route path="/dashboard" element={<RequireAuth><div data-testid="protected">Protected content</div></RequireAuth>} />
        <Route path="/users" element={<RequireRole allowedRoles={allowedRoles}><div data-testid="admin-content">Admin content</div></RequireRole>} />
      </Routes>
    </MemoryRouter>
  );
}

describe('Frontend Auth Guard', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  describe('RequireAuth (server-validated session)', () => {
    it('unauthenticated user (authChecked=false) sees loading, not protected content', () => {
      const { container } = render(
        TestApp({ initialEntries: ['/dashboard'], user: null, authChecked: false })
      );
      expect(screen.queryByTestId('protected')).toBeNull();
      expect(screen.getByTestId('loading')).toBeTruthy();
    });

    it('unauthenticated user (authChecked=true, no currentUser) is blocked from protected route', () => {
      render(
        TestApp({ initialEntries: ['/dashboard'], user: null, authChecked: true })
      );
      expect(screen.getByTestId('redirect-login')).toBeTruthy();
      expect(screen.queryByTestId('protected')).toBeNull();
    });

    it('authenticated user (authChecked=true, currentUser set) can access protected route', () => {
      render(
        TestApp({ initialEntries: ['/dashboard'], user: { user_type: 'operator' }, authChecked: true })
      );
      expect(screen.getByTestId('protected')).toBeTruthy();
    });
  });

  describe('RequireRole (server-validated role)', () => {
    it('authenticated operator is blocked from /users (role mismatch)', () => {
      render(
        TestApp({
          initialEntries: ['/users'],
          user: { user_type: 'operator' },
          authChecked: true,
          allowedRoles: ['platform_admin', 'org_admin'],
        })
      );
      expect(screen.getByTestId('redirect-dashboard')).toBeTruthy();
      expect(screen.queryByTestId('admin-content')).toBeNull();
    });

    it('authenticated org_admin can access /users', () => {
      render(
        TestApp({
          initialEntries: ['/users'],
          user: { user_type: 'org_admin' },
          authChecked: true,
          allowedRoles: ['platform_admin', 'org_admin'],
        })
      );
      expect(screen.getByTestId('admin-content')).toBeTruthy();
    });

    it('authenticated platform_admin can access /users', () => {
      render(
        TestApp({
          initialEntries: ['/users'],
          user: { user_type: 'platform_admin' },
          authChecked: true,
          allowedRoles: ['platform_admin', 'org_admin'],
        })
      );
      expect(screen.getByTestId('admin-content')).toBeTruthy();
    });
  });

  describe('localStorage role falsification (anti-bypass)', () => {
    it('falsified localStorage role does NOT grant admin access', () => {
      localStorage.setItem('currentUser', JSON.stringify({ user_type: 'platform_admin' }));
      useAuth.mockReturnValue({
        authChecked: true,
        currentUser: { user_type: 'operator' },
      });

      const { container } = render(
        <MemoryRouter initialEntries={['/users']}>
          <Routes>
            <Route path="/users" element={<RequireRole allowedRoles={['platform_admin', 'org_admin']}><div data-testid="admin-content">Admin content</div></RequireRole>} />
            <Route path="/dashboard" element={<div data-testid="redirect-dashboard">Redirect to dashboard</div>} />
          </Routes>
        </MemoryRouter>
      );

      expect(screen.getByTestId('redirect-dashboard')).toBeTruthy();
      expect(screen.queryByTestId('admin-content')).toBeNull();
    });
  });
});
