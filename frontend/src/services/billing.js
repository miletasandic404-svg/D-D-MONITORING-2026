import api from './api';

export async function fetchPaymentCatalog() {
  const { data } = await api.get('/payments/catalog');
  return data.plans || [];
}

export async function fetchSubscriptionState() {
  const { data } = await api.get('/payments/status');
  return data;
}

export function findPlan(plans, planId) {
  return (plans || []).find((plan) => plan.id === planId) || null;
}
