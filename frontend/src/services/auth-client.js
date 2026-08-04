/**
 * Better Auth — Frontend client.
 *
 * Provides functions for sign-in, sign-up, sign-out, and session
 * checking that call the backend `/api/auth/*` endpoints (which
 * are handled by better-auth on the server).
 *
 * Usage:
 *   import { signIn, signOut, getSession, getCurrentUser } from '../services/auth-client';
 */

const API_BASE = '/api/auth';

/**
 * Sign in with email and password.
 * On success, the server sets a session cookie and returns the user + session.
 */
export async function signIn(email, password) {
  const res = await fetch(`${API_BASE}/sign-in/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password }),
    credentials: 'include',
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || data.message || 'Sign in failed');
  }

  // Store user info in localStorage for quick access
  if (data.user) {
    localStorage.setItem('currentUser', JSON.stringify(data.user));
  }

  return data;
}

/**
 * Sign up a new account.
 */
export async function signUp(email, password, name) {
  const res = await fetch(`${API_BASE}/sign-up/email`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password, name }),
    credentials: 'include',
  });

  const data = await res.json();

  if (!res.ok) {
    throw new Error(data.error || data.message || 'Sign up failed');
  }

  return data;
}

/**
 * Sign out — destroys the session on the server and clears local state.
 */
export async function signOut() {
  try {
    await fetch(`${API_BASE}/sign-out`, {
      method: 'POST',
      credentials: 'include',
    });
  } catch {
    // Best-effort: even if the server call fails, clear local state
  }

  localStorage.removeItem('currentUser');
}

/**
 * Check current session status.
 * Returns the session object with user data if logged in, or null otherwise.
 */
export async function getSession() {
  try {
    const res = await fetch(`${API_BASE}/get-session`, {
      method: 'GET',
      credentials: 'include',
    });

    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Get the currently logged-in user from local state (fast, no network).
 * Returns null if no user is stored.
 */
export function getCurrentUser() {
  try {
    return JSON.parse(localStorage.getItem('currentUser'));
  } catch {
    return null;
  }
}
