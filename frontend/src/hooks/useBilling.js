import { useEffect, useRef, useState } from 'react';
import api from '../services/api';
import { fetchSubscriptionState } from '../services/billing';
import { loadPayPalSdk, loadStripeSdk } from '../services/payment-helpers';

const paypalClientId = import.meta.env.VITE_PAYPAL_CLIENT_ID || '';
const paypalCurrency = import.meta.env.VITE_PAYPAL_CURRENCY || 'USD';
const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '';

export const PLAN_OPTIONS = [
  {
    id: 'starter',
    name: 'Standard Global',
    price: '$500 / month',
    paypalAmount: '500',
    features: [
      'Global monitoring for up to 5 active locations/cameras',
      'Automated reports',
      'Standard support',
    ],
  },
  {
    id: 'growth',
    name: 'Business Global',
    price: '$950 / month',
    paypalAmount: '950',
    features: [
      'Advanced monitoring for up to 15 active locations/cameras',
      'Accelerated AI reporting',
      'Priority support',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise Global',
    price: '$1500 / month',
    paypalAmount: '1500',
    features: [
      'Maximum capacity',
      'Unlimited locations',
      'Dedicated AI analytics',
      '24/7 premium support',
    ],
  },
];

export function formatPlanOption(plan) {
  const amount = Number.parseFloat(plan?.amount || '0');
  const limit = Number(plan?.limits?.camera_limit || 0);
  return {
    id: plan.id,
    name: plan.name,
    price: Number.isFinite(amount) ? `$${amount.toLocaleString()} / month` : plan.amount,
    paypalAmount: Number.isFinite(amount) ? String(amount) : '',
    features: [
      `${limit > 0 ? `Up to ${limit}` : 'Unlimited'} cameras / locations`,
      plan.features?.aiDetection ? 'AI detection included' : 'AI detection unavailable',
      plan.features?.reports ? 'Reports included' : 'No reports included',
      plan.features?.apiAccess ? 'API access included' : 'No API access',
    ],
  };
}

/**
 * Encapsulates all billing/checkout state, effects, and handlers that used
 * to live inline in Dashboard.jsx (Phase 4 - Subscription). Pure UI stays
 * in components/dashboard/BillingPanel.jsx; this hook owns state + side
 * effects (PayPal/Stripe SDK loading, checkout submission, plan sync).
 *
 * `addAuditEntry` is accepted as a dependency because the audit log is
 * shared dashboard-wide state, not billing-specific.
 */
export function useBilling({ addAuditEntry } = {}) {
  const paypalButtonsRef = useRef(null);
  const cardElementRef = useRef(null);
  const stripeRef = useRef(null);
  const stripeElementsRef = useRef(null);

  const [showBilling, setShowBilling] = useState(false);
  const [selectedPlanId, setSelectedPlanId] = useState('growth');
  const [availablePlans, setAvailablePlans] = useState(PLAN_OPTIONS);
  const [subscriptionState, setSubscriptionState] = useState(null);
  const [checkoutStatus, setCheckoutStatus] = useState('');
  const [paymentStep, setPaymentStep] = useState('details');
  const [emergencyDistrict, setEmergencyDistrict] = useState('');
  const [emergencyContacts, setEmergencyContacts] = useState({
    policeStation: '',
    fireService: '',
    ambulance: '',
    localCommand: '',
  });
  const [paypalMountError, setPaypalMountError] = useState('');
  const [paypalMounting, setPaypalMounting] = useState(false);
  const [paymentMethod, setPaymentMethod] = useState('paypal');
  const [cardMountError, setCardMountError] = useState('');
  const [cardMounting, setCardMounting] = useState(false);
  const [cardSubmitting, setCardSubmitting] = useState(false);

  const selectedPlan = availablePlans.find((plan) => plan.id === selectedPlanId) || availablePlans[0] || PLAN_OPTIONS[1];
  const selectedPlanAmount = selectedPlan.paypalAmount;
  const selectedPlanSupportsPaypal = Boolean(selectedPlanAmount);

  const requiredEmergencyFields = [
    emergencyDistrict,
    emergencyContacts.policeStation,
    emergencyContacts.fireService,
    emergencyContacts.ambulance,
    emergencyContacts.localCommand,
  ].every((value) => String(value || '').trim().length > 0);

  const notifyAudit = (action) => {
    if (typeof addAuditEntry === 'function') {
      addAuditEntry(action);
    }
  };

  const loadBillingState = async () => {
    try {
      const state = await fetchSubscriptionState();
      setSubscriptionState(state.subscription || null);
      if (Array.isArray(state.plans) && state.plans.length > 0) {
        const planOptions = state.plans.map(formatPlanOption);
        setAvailablePlans(planOptions);
        setSelectedPlanId((currentPlanId) => {
          if (currentPlanId && planOptions.some((plan) => plan.id === currentPlanId)) {
            return currentPlanId;
          }
          return state.subscription?.planId || planOptions[0].id;
        });
      }
    } catch (err) {
      console.error('Failed to load billing state:', err);
    }
  };

  const startCheckout = () => {
    if (!requiredEmergencyFields) {
      setCheckoutStatus('Fill emergency contacts before checkout.');
      return;
    }

    if (paymentMethod === 'paypal' && !paypalClientId) {
      setCheckoutStatus('PayPal client ID is missing in VITE_PAYPAL_CLIENT_ID.');
      return;
    }

    if (paymentMethod === 'card' && !stripePublishableKey) {
      setCheckoutStatus('Stripe publishable key is missing in VITE_STRIPE_PUBLISHABLE_KEY.');
      return;
    }

    if (!selectedPlanSupportsPaypal) {
      setCheckoutStatus('Select a package to continue with PayPal checkout.');
      return;
    }

    setCheckoutStatus(`Opening ${paymentMethod === 'paypal' ? 'PayPal' : 'card'} checkout for ${selectedPlan.name}.`);
    setPaymentStep('checkout');
    notifyAudit(`Prepared ${paymentMethod} checkout for ${selectedPlan.name}`);
  };

  // Mount PayPal Buttons when checkout step is active and method is 'paypal'.
  useEffect(() => {
    if (paymentStep !== 'checkout' || paymentMethod !== 'paypal') {
      return undefined;
    }

    let cancelled = false;

    const mountButtons = async () => {
      if (!requiredEmergencyFields) {
        setCheckoutStatus('Fill emergency contacts before checkout.');
        return;
      }

      if (!selectedPlanSupportsPaypal) {
        setCheckoutStatus('Select a package to continue with PayPal checkout.');
        return;
      }

      if (!paypalButtonsRef.current) {
        return;
      }

      setPaypalMounting(true);
      setPaypalMountError('');

      try {
        const paypal = await loadPayPalSdk(paypalClientId, paypalCurrency);
        if (cancelled || !paypalButtonsRef.current) {
          return;
        }

        paypalButtonsRef.current.innerHTML = '';

        const buttons = paypal.Buttons({
          style: {
            layout: 'vertical',
            shape: 'rect',
            label: 'paypal',
            height: 48,
          },
          createOrder: async () => {
            const response = await api.post('/paypal/orders', {
              planId: selectedPlan.id,
              district: emergencyDistrict,
              contacts: emergencyContacts,
              idempotencyKey: window.crypto?.randomUUID?.(),
            });

            return response.data.id;
          },
          onApprove: async (data) => {
            setPaypalMounting(true);
            const response = await api.post(`/paypal/orders/${data.orderID}/capture`);

            if (cancelled) {
              return;
            }

            setPaymentStep('complete');
            setCheckoutStatus(`PayPal payment completed: ${response.data.status || 'COMPLETED'}.`);
            await loadBillingState();
            notifyAudit(`Activated ${selectedPlan.name} via PayPal order ${data.orderID}`);
          },
          onCancel: () => {
            if (!cancelled) {
              setCheckoutStatus('PayPal checkout canceled.');
            }
          },
          onError: (err) => {
            if (!cancelled) {
              setCheckoutStatus(err?.message || 'PayPal checkout failed.');
            }
          },
        });

        if (!buttons.isEligible()) {
          setCheckoutStatus('PayPal buttons are not eligible in this browser.');
          return;
        }

        await buttons.render(paypalButtonsRef.current);

        if (!cancelled) {
          setCheckoutStatus(`PayPal checkout ready for ${selectedPlan.name}.`);
        }
      } catch (err) {
        if (!cancelled) {
          setPaypalMountError(err?.message || 'Failed to load PayPal checkout.');
          setCheckoutStatus(err?.message || 'Failed to load PayPal checkout.');
        }
      } finally {
        if (!cancelled) {
          setPaypalMounting(false);
        }
      }
    };

    mountButtons();

    return () => {
      cancelled = true;
      if (paypalButtonsRef.current) {
        paypalButtonsRef.current.innerHTML = '';
      }
    };
  }, [paymentMethod, paymentStep, requiredEmergencyFields, selectedPlan.id, selectedPlan.name, selectedPlanAmount, selectedPlanSupportsPaypal, emergencyDistrict, emergencyContacts.policeStation, emergencyContacts.fireService, emergencyContacts.ambulance, emergencyContacts.localCommand]);

  // Mount Stripe Payment Element when checkout step is active and method is 'card'.
  useEffect(() => {
    if (paymentStep !== 'checkout' || paymentMethod !== 'card') {
      return undefined;
    }

    let cancelled = false;
    let paymentElement = null;

    const mountCard = async () => {
      if (!requiredEmergencyFields) {
        setCheckoutStatus('Fill emergency contacts before checkout.');
        return;
      }

      if (!cardElementRef.current) {
        return;
      }

      setCardMounting(true);
      setCardMountError('');

      try {
        const intent = await api.post('/payments/card/intent', {
          planId: selectedPlan.id,
          district: emergencyDistrict,
          contacts: emergencyContacts,
          idempotencyKey: window.crypto?.randomUUID?.(),
        });
        const stripe = await loadStripeSdk(stripePublishableKey);
        if (cancelled || !cardElementRef.current) {
          return;
        }

        stripeRef.current = stripe;
        stripeElementsRef.current = stripe.elements({
          clientSecret: intent.data.client_secret,
          appearance: { theme: 'night' },
        });

        cardElementRef.current.innerHTML = '';
        paymentElement = stripeElementsRef.current.create('payment');
        paymentElement.mount(cardElementRef.current);
        setCheckoutStatus(`Card checkout ready for ${selectedPlan.name}.`);
      } catch (err) {
        if (!cancelled) {
          const message = err?.response?.data?.error || err?.message || 'Failed to load card checkout.';
          setCardMountError(message);
          setCheckoutStatus(message);
        }
      } finally {
        if (!cancelled) {
          setCardMounting(false);
        }
      }
    };

    mountCard();

    return () => {
      cancelled = true;
      if (paymentElement) paymentElement.unmount();
      stripeElementsRef.current = null;
      stripeRef.current = null;
      if (cardElementRef.current) {
        cardElementRef.current.innerHTML = '';
      }
    };
  }, [paymentMethod, paymentStep, requiredEmergencyFields, selectedPlan.id, selectedPlan.name, emergencyDistrict, emergencyContacts.policeStation, emergencyContacts.fireService, emergencyContacts.ambulance, emergencyContacts.localCommand]);

  const handleCardCheckout = async () => {
    if (!stripeRef.current || !stripeElementsRef.current) {
      setCardMountError('Card checkout is still loading.');
      return;
    }

    setCardSubmitting(true);
    setCardMountError('');

    try {
      const result = await stripeRef.current.confirmPayment({
        elements: stripeElementsRef.current,
        redirect: 'if_required',
      });

      if (result.error) {
        throw new Error(result.error.message || 'Card payment failed.');
      }

      const response = await api.post('/payments/card/confirm', {
        paymentIntentId: result.paymentIntent?.id,
      });

      setPaymentStep('complete');
      setCheckoutStatus(`Card payment completed: ${response.data.status || 'SUCCEEDED'}.`);
      await loadBillingState();
      notifyAudit(`Activated ${selectedPlan.name} via card payment ${result.paymentIntent?.id}`);
    } catch (err) {
      const message = err?.response?.data?.error || err?.message || 'Card payment failed.';
      setCardMountError(message);
      setCheckoutStatus(message);
    } finally {
      setCardSubmitting(false);
    }
  };

  return {
    // refs (for BillingPanel to attach to DOM nodes)
    paypalButtonsRef,
    cardElementRef,
    // state
    showBilling, setShowBilling,
    selectedPlanId, setSelectedPlanId,
    availablePlans,
    subscriptionState,
    checkoutStatus,
    paymentStep,
    emergencyDistrict, setEmergencyDistrict,
    emergencyContacts, setEmergencyContacts,
    paypalMountError, paypalMounting,
    paymentMethod, setPaymentMethod,
    cardMountError, cardMounting, cardSubmitting,
    // derived
    selectedPlan,
    selectedPlanSupportsPaypal,
    requiredEmergencyFields,
    // config flags (so the panel can show "missing env var" warnings)
    paypalClientId,
    stripePublishableKey,
    // actions
    startCheckout,
    handleCardCheckout,
    loadBillingState,
  };
}
