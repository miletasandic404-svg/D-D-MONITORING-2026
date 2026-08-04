import React, { useEffect, useState } from 'react';
import { fetchSubscriptionState } from '../services/billing';

const PAGE_CSS = `
  .sub-page { padding: 2rem; color: var(--text-primary, #e5eef7); }
  .sub-header { text-align: center; margin-bottom: 2rem; }
  .sub-title { font-family: 'Orbitron', sans-serif; font-size: 1.5rem; color: var(--text-primary, #dff5ff); margin-bottom: .5rem; }
  .sub-subtitle { color: var(--text-secondary, #8ab0c9); }
  .sub-current { background: rgba(0,212,80,.1); border: 1px solid rgba(0,212,80,.3); border-radius: 16px; padding: 1.5rem; margin-bottom: 2rem; display: flex; justify-content: space-between; align-items: center; gap: 1rem; flex-wrap: wrap; }
  .current-plan { display: flex; align-items: center; gap: 1rem; }
  .plan-icon { font-size: 2rem; }
  .plan-name { font-family: 'Orbitron', sans-serif; color: var(--accent-success, #00d450); font-size: 1.2rem; }
  .plan-desc { color: var(--text-secondary, #8ab0c9); font-size: .85rem; }
  .current-badge { background: rgba(0,212,80,.2); color: var(--accent-success, #00d450); padding: .5rem 1rem; border-radius: 20px; font-size: .85rem; font-weight: bold; text-transform: uppercase; }
  .plans-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 1.5rem; }
  .plan-card { background: rgba(10,18,38,.9); border: 1px solid rgba(87,140,255,.18); border-radius: 20px; padding: 2rem; transition: transform .2s, border-color .2s; }
  .plan-card:hover { transform: translateY(-4px); border-color: rgba(0,212,255,.5); }
  .plan-card.featured { border-color: rgba(0,212,255,.5); box-shadow: 0 0 30px rgba(0,212,255,.15); }
  .plan-name-card { font-family: 'Orbitron', sans-serif; font-size: 1.1rem; color: var(--text-primary, #dff7ff); margin-bottom: .5rem; }
  .plan-price { font-size: 2rem; font-weight: bold; color: var(--accent-primary, #00d4ff); margin-bottom: .25rem; }
  .plan-price span { font-size: .9rem; color: var(--text-secondary, #8ab0c9); font-weight: normal; }
  .plan-features { list-style: none; margin: 1.5rem 0; }
  .plan-features li { color: var(--text-secondary, #8ab0c9); padding: .5rem 0; font-size: .9rem; display: flex; align-items: center; gap: .5rem; }
  .plan-features li::before { content: '✓'; color: var(--accent-success, #00d450); font-weight: bold; }
  .plan-btn { width: 100%; padding: 1rem; border: none; border-radius: 12px; font-family: 'Orbitron', sans-serif; font-size: .85rem; text-transform: uppercase; letter-spacing: .1em; cursor: pointer; transition: all .2s; }
  .plan-btn-primary { background: linear-gradient(135deg,var(--accent-primary, #00d4ff),var(--accent-secondary, #8c4dff)); color: #03101c; }
  .plan-btn-secondary { background: rgba(87,125,196,.2); color: var(--text-secondary, #8ab0c9); border: 1px solid rgba(87,125,196,.3); }
  .featured-badge { background: linear-gradient(135deg,var(--accent-primary, #00d4ff),var(--accent-secondary, #8c4dff)); color: #03101c; padding: .3rem .8rem; border-radius: 20px; font-size: .75rem; font-weight: bold; margin-bottom: 1rem; display: inline-block; }
`;

function toPlanCard(plan, currentPlanId) {
  const amount = Number.parseFloat(plan.amount || '0');
  const price = Number.isFinite(amount) ? `$${amount.toLocaleString()}` : plan.amount;
  const cameraLimit = Number(plan?.limits?.camera_limit || 0);
  const siteLimit = Number(plan?.limits?.site_limit || 0);

  return {
    id: plan.id,
    name: plan.name,
    price,
    period: '/month',
    features: [
      `${cameraLimit > 0 ? `Up to ${cameraLimit}` : 'Unlimited'} active cameras / locations`,
      `${siteLimit > 0 ? `Up to ${siteLimit}` : 'Unlimited'} sites`,
      plan.features?.aiDetection ? 'AI detection included' : 'AI detection unavailable',
      plan.features?.apiAccess ? 'API access included' : 'API access unavailable',
    ],
    button: currentPlanId === plan.id ? 'Current Plan' : 'Upgrade via Billing',
    buttonClass: currentPlanId === plan.id ? 'plan-btn-secondary' : 'plan-btn-primary',
    disabled: currentPlanId === plan.id,
    featured: plan.id === 'growth',
  };
}

export default function Subscription() {
  const [catalog, setCatalog] = useState([]);
  const [subscription, setSubscription] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const state = await fetchSubscriptionState();
        setCatalog(state.plans || []);
        setSubscription(state.subscription || null);
      } catch (err) {
        console.error('Failed to load subscription state:', err);
      }
    })();
  }, []);

  const cards = catalog.map((plan) => toPlanCard(plan, subscription?.planId));

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="sub-page">
        <div className="sub-header">
          <h1 className="sub-title">Subscription & Billing</h1>
          <p className="sub-subtitle">Manage your monitoring plan using backend-verified billing data.</p>
        </div>

        <div className="sub-current">
          <div className="current-plan">
            <span className="plan-icon">🛡️</span>
            <div>
              <div className="plan-name">{subscription?.planName || 'Loading plan...'}</div>
              <div className="plan-desc">
                {subscription
                  ? `${subscription.organizationName} • camera limit: ${subscription.limits?.camera_limit ?? 'n/a'}`
                  : 'Loading subscription status from the API'}
              </div>
            </div>
          </div>
          <span className="current-badge">{subscription?.status || 'pending'}</span>
        </div>

        <div className="plans-grid">
          {cards.map((plan) => (
            <div key={plan.id} className={`plan-card ${plan.featured ? 'featured' : ''}`}>
              {plan.featured && <span className="featured-badge">MOST POPULAR</span>}
              <div className="plan-name-card">{plan.name}</div>
              <div className="plan-price">{plan.price}<span>{plan.period}</span></div>
              <ul className="plan-features">
                {plan.features.map((feature) => <li key={feature}>{feature}</li>)}
              </ul>
              <button
                className={`plan-btn ${plan.buttonClass}`}
                disabled={plan.disabled}
                onClick={() => { window.location.href = '/dashboard'; }}
              >
                {plan.button}
              </button>
            </div>
          ))}
        </div>
      </main>
    </>
  );
}
