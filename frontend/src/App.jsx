import React, { lazy, Suspense } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import Login from './pages/Login';
import ResetPassword from './pages/ResetPassword';
import { useAuth } from './hooks/useAuth';

const Dashboard = lazy(() => import('./pages/Dashboard'));

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

function AuthLoader() {
  return <div style={{ background: '#050b16', minHeight: '100vh' }} />;
}

function RequireAuth({ children }) {
  const { authChecked, currentUser } = useAuth();

  if (!authChecked) {
    return <AuthLoader />;
  }

  if (!currentUser) {
    return <Navigate to="/" replace />;
  }

  return children;
}

function RequireRole({ children, allowedRoles }) {
  const { authChecked, currentUser } = useAuth();

  if (!authChecked) {
    return <AuthLoader />;
  }

  if (!currentUser) {
    return <Navigate to="/" replace />;
  }

  const userType = currentUser?.user_type;
  if (!userType || !allowedRoles.includes(userType)) {
    return <Navigate to="/dashboard" replace />;
  }

  return children;
}

function App() {
  return (
    <Router>
      <Suspense fallback={<AuthLoader />}>
        <Routes>
          <Route path="/" element={<Login />} />
          <Route path="/login" element={<Login />} />
          <Route path="/reset-password" element={<ResetPassword />} />
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/dashboard" element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin', 'operator']}>
                <Dashboard />
              </RequireRole>
            } />
          <Route
            path="/users"
            element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin']}>
                <Users />
              </RequireRole>
            }
          />
          <Route path="/settings" element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin']}>
                <Settings />
              </RequireRole>
            } />
          <Route path="/subscription" element={<RequireAuth><Subscription /></RequireAuth>} />
          <Route path="/reports" element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin', 'operator']}>
                <Reports />
              </RequireRole>
            } />
          <Route path="/map" element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin', 'operator']}>
                <Map />
              </RequireRole>
            } />
          <Route path="/ai-detection" element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin', 'operator']}>
                <AIDetection />
              </RequireRole>
            } />
          <Route path="/live-streams" element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin', 'operator']}>
                <LiveStreams />
              </RequireRole>
            } />
          <Route path="/alerts" element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin', 'operator']}>
                <Alerts />
              </RequireRole>
            } />
          <Route path="/incidents" element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin', 'operator']}>
                <Incidents />
              </RequireRole>
            } />
          <Route path="/cameras" element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin', 'operator']}>
                <Cameras />
              </RequireRole>
            } />
          <Route path="/video-playback" element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin', 'operator']}>
                <VideoPlayback />
              </RequireRole>
            } />
          <Route path="/face-recognition" element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin', 'operator']}>
                <FaceRecognition />
              </RequireRole>
            } />
          <Route path="/license-plates" element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin', 'operator']}>
                <LicensePlateRecognition />
              </RequireRole>
            } />
          <Route path="/emergency" element={
              <RequireRole allowedRoles={['platform_admin', 'org_admin', 'operator']}>
                <EmergencyDispatch />
              </RequireRole>
            } />
        </Routes>
      </Suspense>
    </Router>
  );
}

export default App;
