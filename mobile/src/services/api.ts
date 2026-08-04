import { createClient, SupabaseClient, User as SupabaseUser, Session } from '@supabase/supabase-js';
import * as SecureStore from 'expo-secure-store';
import { Camera, Incident, User, DashboardStats, AIDetection, LoginCredentials, AuthResponse, StreamToken } from '../types';

// SUPABASE CONFIGURATION
const SUPABASE_URL = 'https://qskedgnkckgmwwxtduqt.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InFza2VkZ25rY2tnbXd3eHRkdXF0Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTEwNjU2MDAsImV4cCI6MjAyNjY0MTYwMH0.K3kJm3dqNLOiV1j7y4y9jH5z1L8cR5vF6eB2aW4xQcM';

// API Configuration
const API_BASE_URL = 'https://d-d-monitoring-2026-hhkwk6m39-miletasandic7s-projects.vercel.app/api';

class ApiService {
  private supabase: SupabaseClient;
  private apiBaseUrl: string;

  constructor() {
    this.supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
    this.apiBaseUrl = API_BASE_URL;
  }

  // ==================== AUTH ====================

  async login(credentials: LoginCredentials): Promise<AuthResponse> {
    try {
      const { data, error } = await this.supabase.auth.signInWithPassword({
        email: credentials.email,
        password: credentials.password,
      });

      if (error) {
        throw new Error(error.message);
      }

      if (!data.session || !data.user) {
        throw new Error('Login failed - no session returned');
      }

      const user: User = {
        id: data.user.id,
        email: data.user.email || credentials.email,
        display_name: data.user.user_metadata?.display_name || data.user.email?.split('@')[0] || 'User',
        user_type: 'org_admin',
      };

      await SecureStore.setItemAsync('auth_token', data.session.access_token);
      await SecureStore.setItemAsync('user', JSON.stringify(user));

      return {
        token: data.session.access_token,
        user,
      };
    } catch (error) {
      console.error('Login error:', error);
      throw error;
    }
  }

  async register(email: string, password: string, displayName?: string): Promise<AuthResponse> {
    try {
      const { data, error } = await this.supabase.auth.signUp({
        email,
        password,
        options: {
          data: {
            display_name: displayName || email.split('@')[0],
          },
        },
      });

      if (error) {
        throw new Error(error.message);
      }

      if (!data.session || !data.user) {
        throw new Error('Registration failed - no session returned');
      }

      const user: User = {
        id: data.user.id,
        email: data.user.email || email,
        display_name: displayName || email.split('@')[0],
        user_type: 'org_admin',
      };

      await SecureStore.setItemAsync('auth_token', data.session.access_token);
      await SecureStore.setItemAsync('user', JSON.stringify(user));

      return {
        token: data.session.access_token,
        user,
      };
    } catch (error) {
      console.error('Registration error:', error);
      throw error;
    }
  }

  async logout(): Promise<void> {
    await this.supabase.auth.signOut();
    await SecureStore.deleteItemAsync('auth_token');
    await SecureStore.deleteItemAsync('user');
  }

  async getCurrentUser(): Promise<User | null> {
    const userJson = await SecureStore.getItemAsync('user');
    if (userJson) {
      try {
        return JSON.parse(userJson);
      } catch {
        return null;
      }
    }
    return null;
  }

  async isAuthenticated(): Promise<boolean> {
    const token = await SecureStore.getItemAsync('auth_token');
    return !!token;
  }

  async getAccessToken(): Promise<string | null> {
    return await SecureStore.getItemAsync('auth_token');
  }

  // ==================== API CALLS WITH AUTH ====================

  private async apiCall(endpoint: string, options: RequestInit = {}): Promise<any> {
    const token = await this.getAccessToken();
    
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(options.headers as Record<string, string> || {}),
    };

    if (token) {
      headers['Authorization'] = `Bearer ${token}`;
    }

    const response = await fetch(`${this.apiBaseUrl}${endpoint}`, {
      ...options,
      headers,
    });

    if (response.status === 401) {
      await this.logout();
      throw new Error('Unauthorized - please login again');
    }

    const data = await response.json();
    
    if (!response.ok) {
      throw new Error(data.error || 'API request failed');
    }

    return data;
  }

  // ==================== DASHBOARD ====================

  async getDashboardStats(): Promise<DashboardStats> {
    try {
      const data = await this.apiCall('/dashboard/stats');
      return data;
    } catch (error) {
      console.error('Dashboard stats error:', error);
      throw error;
    }
  }

  // ==================== CAMERAS ====================

  async getCameras(): Promise<Camera[]> {
    try {
      const data = await this.apiCall('/cameras');
      return data;
    } catch (error) {
      console.error('Get cameras error:', error);
      throw error;
    }
  }

  async getCamera(id: string): Promise<Camera> {
    try {
      const data = await this.apiCall(`/cameras/${id}`);
      return data;
    } catch (error) {
      console.error('Get camera error:', error);
      throw error;
    }
  }

  async getCameraStreamToken(cameraId: string): Promise<StreamToken> {
    try {
      const data = await this.apiCall(`/cameras/${cameraId}/stream-token`);
      return data;
    } catch (error) {
      console.error('Get stream token error:', error);
      throw error;
    }
  }

  // ==================== INCIDENTS ====================

  async getIncidents(status?: string): Promise<Incident[]> {
    try {
      const endpoint = status ? `/incidents?status=${status}` : '/incidents';
      const data = await this.apiCall(endpoint);
      return data;
    } catch (error) {
      console.error('Get incidents error:', error);
      throw error;
    }
  }

  async getIncident(id: string): Promise<Incident> {
    try {
      const data = await this.apiCall(`/incidents/${id}`);
      return data;
    } catch (error) {
      console.error('Get incident error:', error);
      throw error;
    }
  }

  async updateIncidentStatus(id: string, status: string): Promise<Incident> {
    try {
      const data = await this.apiCall(`/incidents/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      return data;
    } catch (error) {
      console.error('Update incident error:', error);
      throw error;
    }
  }

  async createIncident(data: Partial<Incident>): Promise<Incident> {
    try {
      const response = await this.apiCall('/incidents', {
        method: 'POST',
        body: JSON.stringify(data),
      });
      return response;
    } catch (error) {
      console.error('Create incident error:', error);
      throw error;
    }
  }

  // ==================== AI DETECTIONS ====================

  async getAIDetections(limit = 20): Promise<AIDetection[]> {
    try {
      const data = await this.apiCall(`/ai-detections?limit=${limit}`);
      return data;
    } catch (error) {
      console.error('Get AI detections error:', error);
      throw error;
    }
  }

  // ==================== HEALTH CHECK ====================

  async healthCheck(): Promise<boolean> {
    try {
      const data = await this.apiCall('/health');
      return data.success === true;
    } catch (error) {
      console.error('Health check error:', error);
      return false;
    }
  }
}

export const api = new ApiService();
export default api;
