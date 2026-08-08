import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import BillingPanel from '../components/dashboard/BillingPanel';

const PLANS = [
  { id: 'starter', name: 'Standard Global', price: '$500 / month', paypalAmount: '500', features: ['Up to 5 cameras'] },
  { id: 'growth', name: 'Business Global', price: '$950 / month', paypalAmount: '950', features: ['Up to 15 cameras'] },
];

function makeBilling(overrides = {}) {
  return {
    paypalButtonsRef: { current: null },
    cardElementRef: { current: null },
    selectedPlanId: 'growth',
    setSelectedPlanId: vi.fn(),
    availablePlans: PLANS,
    subscriptionState: { planName: 'Business Global', status: 'active' },
    checkoutStatus: '',
    paymentStep: 'details',
    emergencyDistrict: '',
    setEmergencyDistrict: vi.fn(),
    emergencyContacts: { policeStation: '', fireService: '', ambulance: '', localCommand: '' },
    setEmergencyContacts: vi.fn(),
    paypalMountError: '',
    paypalMounting: false,
    paymentMethod: 'paypal',
    setPaymentMethod: vi.fn(),
    cardMountError: '',
    cardMounting: false,
    cardSubmitting: false,
    selectedPlan: PLANS[1],
    selectedPlanSupportsPaypal: true,
    requiredEmergencyFields: false,
    paypalClientId: 'test-paypal-client-id',
    stripePublishableKey: 'test-stripe-key',
    startCheckout: vi.fn(),
    handleCardCheckout: vi.fn(),
    ...overrides,
  };
}

function renderPanel(overrides = {}) {
  const billing = makeBilling(overrides);
  const onClose = vi.fn();
  const addAuditEntry = vi.fn();
  const setBrandMode = vi.fn();
  render(
    <BillingPanel
      billing={billing}
      onClose={onClose}
      addAuditEntry={addAuditEntry}
      brandMode="default"
      setBrandMode={setBrandMode}
      brandName="D&D Global AI Surveillance"
    />,
  );
  return { billing, onClose, addAuditEntry, setBrandMode };
}

describe('BillingPanel', () => {
  describe('plan list', () => {
    it('displays all available plans', () => {
      renderPanel();
      // Plan cards are <button role="button">, uniquely identifiable by
      // accessible name even though "Business Global" also appears
      // elsewhere on the panel (current-plan note, upgrade-card heading).
      expect(screen.getByRole('button', { name: /Standard Global/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /Business Global/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /\$500 \/ month/ })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /\$950 \/ month/ })).toBeInTheDocument();
    });

    it('marks the currently selected plan as active', () => {
      renderPanel({ selectedPlanId: 'growth' });
      const activeCard = screen.getByRole('button', { name: /Business Global/ });
      expect(activeCard.className).toContain('plan-card-active');
    });

    it('calls setSelectedPlanId when a different plan is clicked', () => {
      const { billing, addAuditEntry } = renderPanel();
      fireEvent.click(screen.getByRole('button', { name: /Standard Global/ }));
      expect(billing.setSelectedPlanId).toHaveBeenCalledWith('starter');
      expect(addAuditEntry).toHaveBeenCalledWith(expect.stringContaining('Standard Global'));
    });

    it('shows the active subscription plan name and status', () => {
      renderPanel({ subscriptionState: { planName: 'Business Global', status: 'active' } });
      const note = screen.getByText(/Current plan:/).closest('p');
      expect(note).toHaveTextContent('Business Global');
      expect(note).toHaveTextContent('active');
    });

    it('shows a pending/expired subscription status', () => {
      renderPanel({ subscriptionState: { planName: 'Business Global', status: 'expired' } });
      const note = screen.getByText(/Current plan:/).closest('p');
      expect(note).toHaveTextContent('expired');
    });

    it('falls back to "Loading..." when no subscription state is present', () => {
      renderPanel({ subscriptionState: null });
      expect(screen.getByText(/Loading\.\.\./)).toBeInTheDocument();
    });
  });

  describe('payment method selection', () => {
    it('calls setPaymentMethod("card") when the card button is clicked', () => {
      const { billing } = renderPanel();
      fireEvent.click(screen.getByText('Visa / Mastercard'));
      expect(billing.setPaymentMethod).toHaveBeenCalledWith('card');
    });

    it('calls setPaymentMethod("paypal") when the PayPal button is clicked', () => {
      const { billing } = renderPanel({ paymentMethod: 'card' });
      fireEvent.click(screen.getByText('PayPal'));
      expect(billing.setPaymentMethod).toHaveBeenCalledWith('paypal');
    });

    it('shows "Start PayPal checkout" label when method is paypal', () => {
      renderPanel({ paymentMethod: 'paypal' });
      expect(screen.getByText('Start PayPal checkout')).toBeInTheDocument();
    });

    it('shows "Start card checkout" label when method is card', () => {
      renderPanel({ paymentMethod: 'card' });
      expect(screen.getByText('Start card checkout')).toBeInTheDocument();
    });

    it('calls startCheckout when the checkout button is clicked', () => {
      const { billing } = renderPanel();
      fireEvent.click(screen.getByText('Start PayPal checkout'));
      expect(billing.startCheckout).toHaveBeenCalled();
    });
  });

  describe('emergency contact requirements', () => {
    it('shows "Contacts required" warning when fields are incomplete', () => {
      renderPanel({ requiredEmergencyFields: false });
      expect(screen.getByText('Contacts required')).toBeInTheDocument();
    });

    it('shows "Contacts complete" when all fields are filled', () => {
      renderPanel({ requiredEmergencyFields: true });
      expect(screen.getByText('Contacts complete')).toBeInTheDocument();
    });

    it('updates district field through setEmergencyDistrict', () => {
      const { billing } = renderPanel();
      const input = screen.getByPlaceholderText('District / county');
      fireEvent.change(input, { target: { value: 'Downtown' } });
      expect(billing.setEmergencyDistrict).toHaveBeenCalledWith('Downtown');
    });
  });

  describe('PayPal SDK / env readiness', () => {
    it('shows a warning when VITE_PAYPAL_CLIENT_ID is missing', () => {
      renderPanel({ paypalClientId: '' });
      expect(screen.getByText('Missing VITE_PAYPAL_CLIENT_ID')).toBeInTheDocument();
    });

    it('shows a warning when VITE_STRIPE_PUBLISHABLE_KEY is missing', () => {
      renderPanel({ stripePublishableKey: '' });
      expect(screen.getByText('Missing VITE_STRIPE_PUBLISHABLE_KEY')).toBeInTheDocument();
    });

    it('shows PayPal buttons host and mounting message during checkout', () => {
      renderPanel({ paymentStep: 'checkout', paymentMethod: 'paypal', paypalMounting: true });
      expect(screen.getByText('Loading PayPal buttons...')).toBeInTheDocument();
    });

    it('shows a PayPal mount error when present', () => {
      renderPanel({ paymentStep: 'checkout', paymentMethod: 'paypal', paypalMountError: 'Failed to load PayPal checkout.' });
      expect(screen.getByText('Failed to load PayPal checkout.')).toBeInTheDocument();
    });
  });

  describe('card checkout state', () => {
    it('shows card mount error text when present', () => {
      renderPanel({ paymentStep: 'checkout', paymentMethod: 'card', cardMountError: 'Failed to load Stripe' });
      expect(screen.getByText('Failed to load Stripe')).toBeInTheDocument();
    });

    it('disables the pay-with-card button while submitting and shows "Processing card..."', () => {
      renderPanel({ paymentStep: 'checkout', paymentMethod: 'card', cardSubmitting: true });
      const button = screen.getByText('Processing card...');
      expect(button).toBeDisabled();
    });

    it('enables the pay-with-card button once not submitting, labeled "Pay with card"', () => {
      renderPanel({ paymentStep: 'checkout', paymentMethod: 'card', cardSubmitting: false });
      const button = screen.getByText('Pay with card');
      expect(button).not.toBeDisabled();
    });

    it('calls handleCardCheckout when the pay-with-card button is clicked', () => {
      const { billing } = renderPanel({ paymentStep: 'checkout', paymentMethod: 'card' });
      fireEvent.click(screen.getByText('Pay with card'));
      expect(billing.handleCardCheckout).toHaveBeenCalled();
    });
  });

  describe('checkout status message', () => {
    it('renders the checkout status text when set', () => {
      renderPanel({ checkoutStatus: 'PayPal checkout canceled.' });
      expect(screen.getByText('PayPal checkout canceled.')).toBeInTheDocument();
    });

    it('renders nothing extra when checkout status is empty', () => {
      renderPanel({ checkoutStatus: '' });
      expect(screen.queryByText('PayPal checkout canceled.')).not.toBeInTheDocument();
    });
  });

  describe('branding controls', () => {
    it('switches to corporate branding and logs an audit entry', () => {
      const { setBrandMode, addAuditEntry } = renderPanel();
      fireEvent.click(screen.getByText('Corporate White-Label'));
      expect(setBrandMode).toHaveBeenCalledWith('corporate');
      expect(addAuditEntry).toHaveBeenCalledWith(expect.stringContaining('Corporate'));
    });

    it('displays the active brand name', () => {
      renderPanel();
      expect(screen.getByText('D&D Global AI Surveillance')).toBeInTheDocument();
    });
  });

  describe('panel controls', () => {
    it('calls onClose when the dismiss button is clicked', () => {
      const { onClose } = renderPanel();
      fireEvent.click(screen.getByRole('button', { name: '✕' }));
      expect(onClose).toHaveBeenCalled();
    });
  });
});
