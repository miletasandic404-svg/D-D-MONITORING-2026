import React from 'react';

export const DEFAULT_PLANS = {
  starter: {
    id: 'starter',
    name: 'Standard Global',
    amount: '500.00',
    currency: 'USD',
    free: false,
    limits: { camera_limit: 5, site_limit: 1 },
    features: {
      cameras: 5,
      users: 5,
      aiDetection: true,
      faceRecognition: false,
      lpr: false,
      emergencyDispatch: false,
      videoPlayback: true,
      reports: true,
      apiAccess: false,
      priority: 'standard',
    },
  },
  growth: {
    id: 'growth',
    name: 'Business Global',
    amount: '950.00',
    currency: 'USD',
    free: false,
    limits: { camera_limit: 15, site_limit: 3 },
    features: {
      cameras: 15,
      users: 20,
      aiDetection: true,
      faceRecognition: true,
      lpr: true,
      emergencyDispatch: true,
      videoPlayback: true,
      reports: true,
      apiAccess: true,
      priority: 'high',
    },
  },
  enterprise: {
    id: 'enterprise',
    name: 'Enterprise Global',
    amount: '1500.00',
    currency: 'USD',
    free: false,
    limits: { camera_limit: 50, site_limit: 10 },
    features: {
      cameras: 50,
      users: 50,
      aiDetection: true,
      faceRecognition: true,
      lpr: true,
      emergencyDispatch: true,
      videoPlayback: true,
      reports: true,
      apiAccess: true,
      priority: 'critical',
    },
  },
};

function toPlanMap(plans) {
  if (!Array.isArray(plans)) return DEFAULT_PLANS;
  return Object.fromEntries(plans.map((plan) => [plan.id, plan]));
}

export const getUserPlan = (subscription, plans) => {
  const planMap = toPlanMap(plans);
  if (!subscription?.planId) {
    return planMap.starter || DEFAULT_PLANS.starter;
  }
  return planMap[subscription.planId] || planMap.starter || DEFAULT_PLANS.starter;
};

export const isFeatureAvailable = (subscription, feature, plans) => {
  const plan = getUserPlan(subscription, plans);
  return plan.features?.[feature] === true || plan.features?.[feature] === -1;
};

export const canAddCamera = (subscription, currentCount, plans) => {
  const plan = getUserPlan(subscription, plans);
  const limit = Number(plan.limits?.camera_limit ?? plan.features?.cameras ?? 0);
  return limit < 0 || currentCount < limit;
};

export const canAddUser = (subscription, currentCount, plans) => {
  const plan = getUserPlan(subscription, plans);
  const limit = Number(plan.features?.users ?? 0);
  return limit < 0 || currentCount < limit;
};

export const UpgradePrompt = ({ feature, requiredPlan }) => (
  <div style={{
    padding: '3rem 2rem',
    textAlign: 'center',
    background: 'rgba(10,18,38,.95)',
    border: '2px solid rgba(255,180,50,.3)',
    borderRadius: '16px',
    margin: '2rem 0',
  }}>
    <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>🔒</div>
    <h2 style={{ color: '#ffb432', fontSize: '1.5rem', marginBottom: '1rem', fontFamily: 'Orbitron, sans-serif' }}>
      Premium Feature Locked
    </h2>
    <p style={{ color: '#8ab0c9', marginBottom: '1.5rem', maxWidth: '500px', margin: '0 auto 1.5rem' }}>
      The <strong style={{ color: '#00d4ff' }}>{feature}</strong> feature requires the
      <strong style={{ color: '#00d450' }}> {requiredPlan}</strong> plan.
    </p>
    <div style={{ marginTop: '1.5rem' }}>
      <button
        onClick={() => { window.location.href = '/subscription'; }}
        style={{
          background: 'linear-gradient(135deg,#00d4ff,#8c4dff)',
          border: 'none',
          color: '#03101c',
          padding: '1rem 2rem',
          borderRadius: '12px',
          fontSize: '1rem',
          fontWeight: 'bold',
          cursor: 'pointer',
        }}
      >
        Upgrade Now 💳
      </button>
    </div>
  </div>
);

export const FeatureGuard = ({ subscription, plans, feature, children, fallback = null }) => {
  if (isFeatureAvailable(subscription, feature, plans)) {
    return children;
  }

  if (fallback) {
    return fallback;
  }

  const featureNames = {
    aiDetection: 'AI Detection',
    faceRecognition: 'Face Recognition',
    lpr: 'License Plate Recognition',
    emergencyDispatch: 'Emergency Dispatch',
    videoPlayback: 'Video Playback',
    reports: 'Reports',
    apiAccess: 'API Access',
  };

  const planMap = toPlanMap(plans);
  const requiredPlan = Object.values(planMap).find((plan) => plan.features?.[feature] === true)?.name || 'Business Global';
  return <UpgradePrompt feature={featureNames[feature] || feature} requiredPlan={requiredPlan} />;
};

export const CameraLimitGuard = ({ subscription, plans, currentCount, children }) => {
  if (canAddCamera(subscription, currentCount, plans)) {
    return children;
  }

  const plan = getUserPlan(subscription, plans);
  return (
    <div style={{
      padding: '2rem',
      textAlign: 'center',
      background: 'rgba(255,80,80,.1)',
      border: '1px solid rgba(255,80,80,.3)',
      borderRadius: '12px',
    }}>
      <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>📹</div>
      <h3 style={{ color: '#ff5050' }}>Camera Limit Reached</h3>
      <p style={{ color: '#8ab0c9', marginBottom: '1rem' }}>
        Your {plan.name} plan includes {plan.limits?.camera_limit ?? plan.features?.cameras} cameras.
      </p>
      <button
        onClick={() => { window.location.href = '/subscription'; }}
        style={{
          background: 'linear-gradient(135deg,#00d4ff,#8c4dff)',
          border: 'none',
          color: '#03101c',
          padding: '.8rem 1.5rem',
          borderRadius: '10px',
          fontWeight: 'bold',
          cursor: 'pointer',
        }}
      >
        Upgrade to Add More Cameras
      </button>
    </div>
  );
};

export const PaymentRequired = ({ onClose }) => (
  <div style={{
    position: 'fixed',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    background: 'rgba(0,0,0,.8)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  }}>
    <div style={{
      background: 'rgba(10,18,38,.95)',
      border: '2px solid rgba(255,80,80,.5)',
      borderRadius: '20px',
      padding: '3rem',
      maxWidth: '500px',
      textAlign: 'center',
    }}>
      <div style={{ fontSize: '4rem', marginBottom: '1rem' }}>💳</div>
      <h2 style={{ color: '#ff5050', fontSize: '1.5rem', marginBottom: '1rem', fontFamily: 'Orbitron' }}>
        Payment Required
      </h2>
      <p style={{ color: '#8ab0c9', marginBottom: '2rem' }}>
        This feature requires an active subscription.
        Please select a plan to continue using all features.
      </p>
      <div style={{ display: 'flex', gap: '1rem', justifyContent: 'center', flexWrap: 'wrap' }}>
        <button
          onClick={() => { window.location.href = '/subscription'; }}
          style={{
            background: 'linear-gradient(135deg,#00d4ff,#8c4dff)',
            border: 'none',
            color: '#03101c',
            padding: '1rem 2rem',
            borderRadius: '12px',
            fontWeight: 'bold',
            cursor: 'pointer',
          }}
        >
          View Plans
        </button>
        <button
          onClick={onClose}
          style={{
            background: 'rgba(87,125,196,.2)',
            border: '1px solid rgba(87,125,196,.3)',
            color: '#8ab0c9',
            padding: '1rem 2rem',
            borderRadius: '12px',
            cursor: 'pointer',
          }}
        >
          Maybe Later
        </button>
      </div>
    </div>
  </div>
);

export default {
  DEFAULT_PLANS,
  getUserPlan,
  isFeatureAvailable,
  canAddCamera,
  canAddUser,
  FeatureGuard,
  CameraLimitGuard,
  UpgradePrompt,
  PaymentRequired,
};
