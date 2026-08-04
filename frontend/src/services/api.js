import axios from 'axios';
import { getSession } from './auth-client';

const baseURL = import.meta.env.VITE_API_BASE_URL || '/api';

const api = axios.create({
  baseURL,
  headers: {
    'Content-Type': 'application/json',
  },
  timeout: 15000,
  withCredentials: true,
});

// Attach session token from Better Auth to every request.
// The backend (api/_auth.js) checks both Bearer tokens and cookies.
api.interceptors.request.use(async (config) => {
  try {
    const session = await getSession();
    if (session?.token) {
      config.headers.Authorization = `Bearer ${session.token}`;
      return config;
    }
  } catch {
    // Fall through — request will rely on cookie-based auth
  }

  return config;
});

export default api;
