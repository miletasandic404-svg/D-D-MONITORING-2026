import React from 'react';

/**
 * Pure presentational billing/checkout panel. All state and side effects
 * (PayPal/Stripe SDK mounting, checkout submission) live in
 * hooks/useBilling.js -- this component only renders based on props and
 * forwards user actions upward.
 */
export default function BillingPanel({
  onClose,
  addAuditEntry,
  brandMode,
  setBrandMode,
  brandName,
  billing,
}) {
  const {
    paypalButtonsRef,
    cardElementRef,
    selectedPlanId,
    setSelectedPlanId,
    availablePlans,
    subscriptionState,
    checkoutStatus,
    paymentStep,
    emergencyDistrict,
    setEmergencyDistrict,
    emergencyContacts,
    setEmergencyContacts,
    paypalMountError,
    paypalMounting,
    paymentMethod,
    setPaymentMethod,
    cardMountError,
    cardMounting,
    cardSubmitting,
    selectedPlan,
    selectedPlanSupportsPaypal,
    requiredEmergencyFields,
    paypalClientId,
    stripePublishableKey,
    startCheckout,
    handleCardCheckout,
  } = billing;

  const notifyAudit = (action) => {
    if (typeof addAuditEntry === 'function') {
      addAuditEntry(action);
    }
  };

  return (
    <section className="dashboard-panel billing-panel" id="billing">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">License Management</p>
          <h3>Client Plans &amp; Checkout</h3>
        </div>
        <button className="notif-dismiss" type="button" onClick={onClose}>&#x2715;</button>
      </div>

      <div className="billing-grid billing-grid-wide">
        <div className="billing-tier-card billing-plan-list">
          <p className="eyebrow">Available packages</p>
          <div className="plan-grid">
            {availablePlans.map((plan) => (
              <button
                key={plan.id}
                type="button"
                role="button"
                className={`plan-card${selectedPlanId === plan.id ? ' plan-card-active' : ''}`}
                onClick={() => {
                  setSelectedPlanId(plan.id);
                  notifyAudit(`Selected package ${plan.name}`);
                }}
              >
                <div className="plan-card-top">
                  <strong>{plan.name}</strong>
                  <span>{plan.price}</span>
                </div>
                <ul className="plan-card-features">
                  {plan.features.map((feature) => (
                    <li key={feature}>{feature}</li>
                  ))}
                </ul>
              </button>
            ))}
          </div>
          <div className="purchase-note">
            <span className="status-pill neutral">Backend verified subscription</span>
            <p>
              Current plan: {subscriptionState?.planName || 'Loading...'} •
              status: {subscriptionState?.status || 'pending'}.
              PayPal and direct card payments are finalized server-side before plan activation.
            </p>
          </div>
        </div>

        <div className="billing-upgrade-card">
          <p className="eyebrow">Billing controls</p>
          <h4>{selectedPlan.name}</h4>
          <p className="ls-desc">{selectedPlan.price}</p>

          <div className="checkout-stepper">
            <span className={paymentStep === 'details' ? 'step-active' : ''}>1. Contacts</span>
            <span className={paymentStep === 'checkout' ? 'step-active' : ''}>2. Payment</span>
            <span className={paymentStep === 'complete' ? 'step-active' : ''}>3. Activated</span>
          </div>

          <div className="contact-grid">
            <label className="search-field">
              <span>District</span>
              <input required value={emergencyDistrict} onChange={(e) => setEmergencyDistrict(e.target.value)} placeholder="District / county" />
            </label>
            <label className="search-field">
              <span>Police station number</span>
              <input required value={emergencyContacts.policeStation} onChange={(e) => setEmergencyContacts((prev) => ({ ...prev, policeStation: e.target.value }))} placeholder="110 / local number" />
            </label>
            <label className="search-field">
              <span>Fire service number</span>
              <input required value={emergencyContacts.fireService} onChange={(e) => setEmergencyContacts((prev) => ({ ...prev, fireService: e.target.value }))} placeholder="112 / local number" />
            </label>
            <label className="search-field">
              <span>Ambulance / medical</span>
              <input required value={emergencyContacts.ambulance} onChange={(e) => setEmergencyContacts((prev) => ({ ...prev, ambulance: e.target.value }))} placeholder="medical emergency number" />
            </label>
            <label className="search-field">
              <span>Local command center</span>
              <input required value={emergencyContacts.localCommand} onChange={(e) => setEmergencyContacts((prev) => ({ ...prev, localCommand: e.target.value }))} placeholder="district command / dispatch" />
            </label>
          </div>

          <div style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setPaymentMethod('paypal')}
              style={{
                borderColor: paymentMethod === 'paypal' ? 'rgba(0,212,255,.7)' : undefined,
                background: paymentMethod === 'paypal' ? 'rgba(0,212,255,.12)' : undefined,
              }}
            >
              PayPal
            </button>
            <button
              type="button"
              className="ghost-button"
              onClick={() => setPaymentMethod('card')}
              style={{
                borderColor: paymentMethod === 'card' ? 'rgba(0,212,255,.7)' : undefined,
                background: paymentMethod === 'card' ? 'rgba(0,212,255,.12)' : undefined,
              }}
            >
              Visa / Mastercard
            </button>
          </div>

          <button className="ghost-button plan-cta" type="button" onClick={startCheckout}>
            {paymentMethod === 'paypal' ? 'Start PayPal checkout' : 'Start card checkout'}
          </button>

          <div className="checkout-meta">
            <span className={`status-pill ${requiredEmergencyFields ? 'good' : 'warning'}`}>
              {requiredEmergencyFields ? 'Contacts complete' : 'Contacts required'}
            </span>
            {paypalClientId ? (
              <span className="status-pill good">PayPal client ready</span>
            ) : (
              <span className="status-pill warning">Missing VITE_PAYPAL_CLIENT_ID</span>
            )}
            {stripePublishableKey ? (
              <span className="status-pill good">Card key ready</span>
            ) : (
              <span className="status-pill warning">Missing VITE_STRIPE_PUBLISHABLE_KEY</span>
            )}
          </div>

          {paymentStep === 'checkout' && paymentMethod === 'paypal' && selectedPlanSupportsPaypal && (
            <div className="paypal-button-shell">
              <div className="paypal-button-header">
                <span className="status-pill good">PayPal secure checkout</span>
                <span className="subtle-chip">{selectedPlan.name}</span>
              </div>
              <div className="paypal-buttons-host" ref={paypalButtonsRef} aria-live="polite" />
              {(paypalMounting || paypalMountError) && (
                <p className={`checkout-status ${paypalMountError ? 'checkout-status-error' : ''}`}>
                  {paypalMountError || 'Loading PayPal buttons...'}
                </p>
              )}
            </div>
          )}

          {paymentStep === 'checkout' && paymentMethod === 'card' && (
            <div className="paypal-button-shell">
              <div className="paypal-button-header">
                <span className="status-pill good">Card checkout</span>
                <span className="subtle-chip">{selectedPlan.name}</span>
              </div>
              <div ref={cardElementRef} style={{ minHeight: 170, padding: '1rem', borderRadius: '18px', background: 'rgba(4,10,28,.72)', border: '1px solid rgba(87,125,196,.25)' }} />
              <button className="ghost-button plan-cta" type="button" onClick={handleCardCheckout} disabled={cardSubmitting}>
                {cardSubmitting ? 'Processing card...' : 'Pay with card'}
              </button>
              {(cardMounting || cardMountError) && (
                <p className={`checkout-status ${cardMountError ? 'checkout-status-error' : ''}`}>
                  {cardMountError || 'Loading card checkout...'}
                </p>
              )}
            </div>
          )}

          {checkoutStatus && <p className="checkout-status">{checkoutStatus}</p>}

          <div className="branding-group">
            <p className="eyebrow" style={{ marginBottom: '.6rem' }}>White-Label Mode</p>
            <div className="branding-toggle-row">
              <button
                type="button"
                className={`branding-option${brandMode === 'default' ? ' branding-active' : ''}`}
                onClick={() => { setBrandMode('default'); notifyAudit('Switched branding to D&D Security Default'); }}
              >D&amp;D Security Default</button>
              <button
                type="button"
                className={`branding-option${brandMode === 'corporate' ? ' branding-active' : ''}`}
                onClick={() => { setBrandMode('corporate'); notifyAudit('Switched branding to Corporate White-Label mode'); }}
              >Corporate White-Label</button>
            </div>
            <p className="ls-desc" style={{ marginTop: '.6rem' }}>Active: <strong style={{ color: '#85dfff' }}>{brandName}</strong></p>
          </div>
        </div>
      </div>
    </section>
  );
}
