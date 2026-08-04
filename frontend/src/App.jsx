import React, { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route } from 'react-router-dom';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';

// Dashboard is code-split: HLS.js + all heavy libs only load after login
const Dashboard = lazy(() => import('./pages/Dashboard'));

// Lazy load new pages
const Users = lazy(() => import('./pages/Users'));
const Settings = lazy(() => import('./pages/Settings'));
const Subscription = lazy(() => import('./pages/Subscription'));
const Reports = lazy(() => import('./pages/Reports'));
const Map = lazy(() => import('./pages/Map'));
const AIDetection = lazy(() => import('./pages/AIDetection'));
const LiveStreams = lazy(() => import('./pages/LiveStreams'));
const Alerts = lazy(() => import('./pages/Alerts'));
const Incidents = lazy(() => import('./pages/Incidents'));
const Cameras = lazy(() => import('./pages/Cameras'));
const VideoPlayback = lazy(() => import('./pages/VideoPlayback'));
const FaceRecognition = lazy(() => import('./pages/FaceRecognition'));
const LicensePlateRecognition = lazy(() => import('./pages/LicensePlateRecognition'));
const EmergencyDispatch = lazy(() => import('./pages/EmergencyDispatch'));
const Onboarding = lazy(() => import('./pages/Onboarding'));

function App() {
  return (
    <Router>
      <Suspense fallback={<div style={{ background: '#050b16', minHeight: '100vh' }} />}>
        <Routes>
          <Route path="/" element={<Login />} />
          <Route path="/login" element={<Login />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/dashboard" element={<Dashboard />} />
          <Route path="/users" element={<Users />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/subscription" element={<Subscription />} />
          <Route path="/reports" element={<Reports />} />
          <Route path="/map" element={<Map />} />
          <Route path="/ai-detection" element={<AIDetection />} />
          <Route path="/live-streams" element={<LiveStreams />} />
          <Route path="/alerts" element={<Alerts />} />
          <Route path="/incidents" element={<Incidents />} />
          <Route path="/cameras" element={<Cameras />} />
          <Route path="/video-playback" element={<VideoPlayback />} />
          <Route path="/face-recognition" element={<FaceRecognition />} />
          <Route path="/license-plates" element={<LicensePlateRecognition />} />
          <Route path="/emergency" element={<EmergencyDispatch />} />
        </Routes>
      </Suspense>
    </Router>
  );
}

export default App;
