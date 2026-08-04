'use strict';

const {
  listPlanDefinitions,
  resolvePlanDefinition,
} = require('./payment_catalog');
const {
  activatePaymentForOrganization,
  ensureValidOnboardingPayment,
  getPaymentById,
  retryPendingActivations,
} = require('./payment_service');

const PLAN_LIMITS = Object.fromEntries(
  listPlanDefinitions().map((plan) => [plan.id, plan.limits]),
);

function getPlanLimits(planId) {
  return PLAN_LIMITS[planId] || null;
}

async function activateOrganizationPlan({ organizationId, userId, paymentId, req }) {
  return activatePaymentForOrganization({
    paymentId,
    organizationId,
    userId,
    req,
  });
}

async function validateRegistrationPayment({ paymentId, planId, organizationId, userId, req }) {
  return ensureValidOnboardingPayment({
    paymentId,
    planId,
    organizationId,
    userId,
    req,
  });
}

async function findSuccessfulRegistrationPayment({ paymentId }) {
  if (!paymentId) return null;
  const payment = await getPaymentById(paymentId);
  if (!payment || payment.status !== 'paid') return null;
  return payment;
}

async function linkRegistrationToOrganization({ paymentId, organizationId, userId, req }) {
  if (!paymentId) {
    throw new Error('paymentId is required');
  }
  return activatePaymentForOrganization({
    paymentId,
    organizationId,
    userId,
    req,
  });
}

async function retryOrganizationPaymentActivations({ organizationId, userId, req }) {
  return retryPendingActivations({
    organizationId,
    userId,
    req,
  });
}

module.exports = {
  PLAN_LIMITS,
  activateOrganizationPlan,
  findSuccessfulRegistrationPayment,
  getPlanLimits,
  linkRegistrationToOrganization,
  resolvePlanDefinition,
  retryOrganizationPaymentActivations,
  validateRegistrationPayment,
};
