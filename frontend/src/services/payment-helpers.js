export const PENDING_PAYMENT_KEY = 'dnd-pending-payment';

let paypalSdkPromise = null;
let stripeSdkPromise = null;

export function loadPayPalSdk(clientId, currency = 'USD') {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('PayPal SDK can only load in the browser.'));
  }
  if (window.paypal) {
    return Promise.resolve(window.paypal);
  }
  if (!clientId) {
    return Promise.reject(new Error('Missing PayPal client ID.'));
  }

  if (!paypalSdkPromise) {
    paypalSdkPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-paypal-sdk="true"]');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.paypal));
        existing.addEventListener('error', () => reject(new Error('Failed to load PayPal SDK.')));
        return;
      }

      const script = document.createElement('script');
      script.src = `https://www.paypal.com/sdk/js?client-id=${encodeURIComponent(clientId)}&currency=${encodeURIComponent(currency)}&intent=capture&components=buttons`;
      script.async = true;
      script.defer = true;
      script.dataset.paypalSdk = 'true';
      script.onload = () => resolve(window.paypal);
      script.onerror = () => reject(new Error('Failed to load PayPal SDK.'));
      document.body.appendChild(script);
    }).finally(() => {
      paypalSdkPromise = null;
    });
  }

  return paypalSdkPromise;
}

export function loadStripeSdk(publishableKey) {
  if (typeof window === 'undefined') {
    return Promise.reject(new Error('Stripe SDK can only load in the browser.'));
  }
  if (!publishableKey) {
    return Promise.reject(new Error('Missing Stripe publishable key.'));
  }
  if (window.Stripe) {
    return Promise.resolve(window.Stripe(publishableKey));
  }

  if (!stripeSdkPromise) {
    stripeSdkPromise = new Promise((resolve, reject) => {
      const existing = document.querySelector('script[data-stripe-sdk="true"]');
      if (existing) {
        existing.addEventListener('load', () => resolve(window.Stripe(publishableKey)));
        existing.addEventListener('error', () => reject(new Error('Failed to load Stripe SDK.')));
        return;
      }

      const script = document.createElement('script');
      script.src = 'https://js.stripe.com/v3/';
      script.async = true;
      script.defer = true;
      script.dataset.stripeSdk = 'true';
      script.onload = () => resolve(window.Stripe(publishableKey));
      script.onerror = () => reject(new Error('Failed to load Stripe SDK.'));
      document.body.appendChild(script);
    }).finally(() => {
      stripeSdkPromise = null;
    });
  }

  return stripeSdkPromise;
}

export function storePendingPayment(data) {
  if (typeof window === 'undefined') {
    return;
  }
  window.localStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify({
    ...data,
    savedAt: new Date().toISOString(),
  }));
}

export function readPendingPayment() {
  if (typeof window === 'undefined') {
    return null;
  }

  try {
    const raw = window.localStorage.getItem(PENDING_PAYMENT_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export function clearPendingPayment() {
  if (typeof window !== 'undefined') {
    window.localStorage.removeItem(PENDING_PAYMENT_KEY);
  }
}
