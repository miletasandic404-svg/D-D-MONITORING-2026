// API Types for D&D Monitoring Platform

export interface Camera {
  id: string;
  name: string;
  location: string;
  rtsp_url: string;
  enabled: boolean;
  status: 'online' | 'offline' | 'recording';
  thumbnail_url?: string;
  stream_url?: string;
  created_at: string;
}

export interface Incident {
  id: string;
  title: string;
  description: string;
  status: 'new' | 'acknowledged' | 'in_progress' | 'resolved' | 'false_alarm';
  priority: 'low' | 'medium' | 'high' | 'critical';
  camera_id?: string;
  camera_name?: string;
  created_at: string;
  updated_at: string;
}

export interface User {
  id: string;
  email: string;
  display_name: string;
  user_type: 'admin' | 'operator' | 'viewer' | 'org_admin' | 'platform_admin';
}

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: User;
}

export interface DashboardStats {
  total_cameras: number;
  online_cameras: number;
  offline_cameras: number;
  active_incidents: number;
  critical_incidents: number;
}

export interface AIDetection {
  id: string;
  camera_id: string;
  camera_name: string;
  detection_type: string;
  confidence: number;
  timestamp: string;
  snapshot_url?: string;
}

export interface StreamToken {
  camera_id: string;
  token: string;
  expires_at: string;
}
