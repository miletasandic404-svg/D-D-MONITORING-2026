'use strict';

const PLAN_DEFINITIONS = {
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

function resolvePlanDefinition(planId) {
  return PLAN_DEFINITIONS[String(planId || '').trim().toLowerCase()] || null;
}

function listPlanDefinitions() {
  return Object.values(PLAN_DEFINITIONS).map((plan) => ({
    id: plan.id,
    name: plan.name,
    amount: plan.amount,
    currency: plan.currency,
    free: plan.free,
    limits: { ...plan.limits },
    features: { ...plan.features },
  }));
}

function getPlanAmountInMinorUnits(plan) {
  const amount = Number.parseFloat(plan?.amount);
  if (!Number.isFinite(amount) || amount < 0) {
    throw new Error('Invalid plan amount');
  }
  return Math.round(amount * 100);
}

function isFreePlan(planId) {
  return Boolean(resolvePlanDefinition(planId)?.free);
}

module.exports = {
  PLAN_DEFINITIONS,
  getPlanAmountInMinorUnits,
  isFreePlan,
  listPlanDefinitions,
  resolvePlanDefinition,
};
