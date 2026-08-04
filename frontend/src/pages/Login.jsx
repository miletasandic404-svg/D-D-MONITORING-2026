import React, { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { signIn } from '../services/auth-client';
import api from '../services/api';
import {
  clearPendingPayment,
  loadPayPalSdk,
  loadStripeSdk,
  storePendingPayment,
} from '../services/payment-helpers';

const PAGE_CSS = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  .pg{position:relative;min-height:100vh;width:100%;overflow-x:hidden;font-family:'Space Grotesk',sans-serif;color:var(--text-primary, #e5eef7);background:radial-gradient(circle at 16% 18%,rgba(0,212,255,.15),transparent 24%),radial-gradient(circle at 82% 14%,rgba(52,120,255,.12),transparent 22%),linear-gradient(180deg,#050b16 0%,#040914 60%,#030710 100%);}
  .pg::before{content:'';position:fixed;inset:0;background:linear-gradient(rgba(87,125,196,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(87,125,196,.05) 1px,transparent 1px);background-size:68px 68px;opacity:.18;pointer-events:none;z-index:0;}
  .pg-header{position:relative;z-index:1;text-align:center;padding:2.5rem 1.5rem 1.5rem;}
  .pg-emblem{display:inline-flex;align-items:center;justify-content:center;width:72px;height:72px;border-radius:50%;border:1.5px solid rgba(0,203,255,.45);box-shadow:0 0 20px rgba(0,173,255,.16);margin-bottom:1rem;font-size:2rem;}
  .pg-kicker{font-size:.7rem;letter-spacing:.36em;text-transform:uppercase;color:#8ee8ff;margin-bottom:.4rem;}
  .pg-title{font-family:'Orbitron',sans-serif;font-size:clamp(1.8rem,4vw,2.8rem);font-weight:900;text-transform:uppercase;letter-spacing:.1em;color:var(--text-primary, #dff5ff);}
  .pg-tagline{font-size:.95rem;color:var(--text-secondary, #8ab0c9);margin-top:.55rem;line-height:1.6;}
  .pg-grid{position:relative;z-index:1;max-width:1200px;margin:0 auto;padding:1.5rem 2rem 4rem;display:grid;grid-template-columns:1fr minmax(300px,390px);gap:2rem;align-items:start;}
  .lc{border-radius:24px;padding:2.25rem 2rem;background:linear-gradient(160deg,rgba(10,14,32,.97),rgba(4,7,18,.98));border:1px solid rgba(128,165,255,.2);box-shadow:0 8px 40px rgba(0,0,0,.5),0 0 30px rgba(135,62,255,.1);}
  .lc-kicker{font-size:.7rem;letter-spacing:.34em;text-transform:uppercase;color:#8ee8ff;margin-bottom:.3rem;}
  .lc h3{font-family:'Orbitron',sans-serif;font-size:1.05rem;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:var(--text-primary, #dff7ff);margin-bottom:.5rem;}
  .lc-desc{color:var(--text-secondary, #8ab0c9);line-height:1.65;font-size:.88rem;margin-bottom:1.6rem;}
  .lc-form{display:grid;gap:1.1rem;}
  .lc-field{display:grid;gap:.45rem;}
  .lc-field span{font-size:.7rem;text-transform:uppercase;letter-spacing:.18em;color:#8ccfff;}
  .lc-field input{width:100%;border-radius:12px;border:1px solid rgba(109,162,255,.22);background:rgba(4,10,28,.86);color:#ecf7ff;padding:.9rem 1rem;outline:none;font-family:inherit;font-size:1rem;transition:border-color 180ms,box-shadow 180ms;}
  .lc-field input::placeholder{color:var(--text-muted, #6a8aaa);}
  .lc-field input:focus{border-color:rgba(80,208,255,.75);box-shadow:0 0 0 1px rgba(67,206,255,.18),0 0 22px rgba(63,181,255,.18);}
  .lc-btn{margin-top:.4rem;width:100%;border:0;border-radius:12px;padding:1.05rem;cursor:pointer;font-family:'Orbitron',sans-serif;font-weight:700;font-size:.82rem;text-transform:uppercase;letter-spacing:.2em;color:#03101c;background:linear-gradient(135deg,var(--accent-primary, #00d4ff) 0%,var(--accent-secondary, #8c4dff) 52%,#ff55cc 100%);box-shadow:0 4px 20px rgba(0,212,255,.2);transition:transform 180ms,filter 180ms;}
  .lc-btn:hover{transform:translateY(-2px);filter:brightness(1.10);}
  .lc-remember{display:flex;align-items:center;gap:.6rem;margin-top:.3rem;}
  .lc-remember input[type="checkbox"]{width:18px;height:18px;accent-color:var(--accent-primary, #00d4ff);cursor:pointer;border-radius:4px;}
  .lc-remember label{font-size:.8rem;color:var(--text-secondary, #8ab0c9);cursor:pointer;user-select:none;}
  .lc-remember label:hover{color:#8ee8ff;}
  .pr{display:flex;flex-direction:column;gap:1.5rem;}
  .pr-eyebrow{font-size:.7rem;letter-spacing:.34em;text-transform:uppercase;color:#8ee8ff;margin-bottom:.35rem;}
  .pr-heading{font-family:'Orbitron',sans-serif;font-size:clamp(1rem,2vw,1.4rem);font-weight:900;text-transform:uppercase;letter-spacing:.08em;color:var(--text-primary, #dff5ff);margin-bottom:.45rem;}
  .pr-sub{color:var(--text-secondary, #8ab0c9);font-size:.88rem;line-height:1.6;margin-bottom:.25rem;}
  .pr-cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:1rem;}
  .pr-card{border-radius:18px;padding:1.5rem 1.4rem;background:rgba(10,18,38,.85);border:1px solid rgba(87,140,255,.18);text-align:left;cursor:pointer;color:var(--text-primary, #e5eef7);transition:border-color 200ms,transform 200ms,box-shadow 200ms;width:100%;}
  .pr-card:hover{border-color:rgba(80,190,255,.5);transform:translateY(-2px);box-shadow:0 0 22px rgba(0,172,255,.14);}
  .pr-card-sel{border-color:rgba(0,210,255,.8)!important;box-shadow:0 0 0 2px rgba(0,210,255,.22),0 0 26px rgba(0,172,255,.18)!important;}
  .pr-card-rec{border-color:rgba(140,77,255,.42);}
  .pr-badge{display:inline-block;margin-bottom:.6rem;padding:.18rem .6rem;border-radius:999px;background:rgba(140,77,255,.18);border:1px solid rgba(140,77,255,.42);font-size:.65rem;letter-spacing:.1em;text-transform:uppercase;color:#c580ff;}
  .pr-name{display:block;font-family:'Orbitron',sans-serif;font-size:.8rem;font-weight:700;text-transform:uppercase;letter-spacing:.08em;color:var(--text-primary, #dff7ff);margin-bottom:.3rem;}
  .pr-price{display:block;font-size:1.25rem;font-weight:700;color:var(--accent-primary, #00d4ff);margin-bottom:.8rem;}
  .pr-features{list-style:none;margin-bottom:1.1rem;display:grid;gap:.35rem;}
  .pr-features li{font-size:.82rem;color:var(--text-secondary, #8ab0c9);padding-left:1.1rem;position:relative;}
  .pr-features li::before{content:'→';position:absolute;left:0;color:var(--accent-primary, #00d4ff);font-size:.8rem;}
  .pr-sel-label{display:inline-block;padding:.28rem .75rem;border-radius:8px;background:rgba(0,210,255,.08);border:1px solid rgba(0,210,255,.25);font-size:.72rem;letter-spacing:.06em;color:#8ee8ff;}
  .pr-card-sel .pr-sel-label{background:rgba(0,210,255,.18);border-color:rgba(0,210,255,.55);color:var(--accent-primary, #00d4ff);font-weight:600;}
  .pr-checkout{background:rgba(8,14,32,.93);border:1px solid rgba(80,140,255,.2);border-radius:18px;padding:1.6rem 1.5rem;}
  .pr-checkout h3{font-size:.95rem;font-weight:600;color:var(--text-primary, #dff7ff);margin-bottom:.35rem;}
  .pr-checkout-note{font-size:.82rem;color:var(--text-muted, #6a8aaa);margin-bottom:1.2rem;line-height:1.55;}
  .pr-contact-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(200px,1fr));gap:.75rem;margin-bottom:1.1rem;}
  .pr-cfield{display:grid;gap:.3rem;}
  .pr-cfield span{font-size:.65rem;text-transform:uppercase;letter-spacing:.16em;color:#8ccfff;}
  .pr-cfield input{border-radius:10px;border:1px solid rgba(100,160,255,.2);background:rgba(4,10,28,.85);color:#ecf7ff;padding:.6rem .85rem;outline:none;font-family:inherit;font-size:.84rem;transition:border-color 180ms;}
  .pr-cfield input:focus{border-color:rgba(80,208,255,.55);}
  .pr-proceed-btn{padding:.8rem 1.8rem;border:0;border-radius:10px;cursor:pointer;font-family:'Orbitron',sans-serif;font-weight:700;font-size:.76rem;text-transform:uppercase;letter-spacing:.14em;color:#03101c;background:linear-gradient(135deg,var(--accent-primary, #00d4ff) 0%,var(--accent-secondary, #8c4dff) 52%,#ff55cc 100%);box-shadow:0 0 16px rgba(0,212,255,.22);transition:transform 160ms,filter 160ms;}
  .pr-proceed-btn:hover{transform:translateY(-2px);filter:brightness(1.1);}
  .pr-pp-wrap{min-height:60px;margin-top:1rem;}
  .pr-error{color:#ff7676;font-size:.83rem;margin-top:.75rem;}
  .pr-status-msg{color:#8ee8ff;font-size:.83rem;margin-top:.75rem;}
  .pr-success{text-align:center;padding:2.5rem 1.5rem;background:rgba(0,212,80,.07);border:1px solid rgba(0,212,80,.28);border-radius:18px;}
  .pr-success-icon{display:block;font-size:2.4rem;color:var(--accent-success, #00d450);margin-bottom:.8rem;}
  .pr-success h3{font-family:'Orbitron',sans-serif;font-size:1.15rem;color:var(--text-primary, #dff7ff);margin-bottom:.55rem;}
  .pr-success p{color:var(--text-secondary, #8ab0c9);line-height:1.6;font-size:.88rem;}
  @media(max-width:860px){.pg-grid{grid-template-columns:1fr;}.lc{order:-1;}}
  @media(max-width:520px){.pg-grid{padding:1rem 1rem 3rem;}.pg-header{padding:1.5rem 1rem 1rem;}.pr-cards{grid-template-columns:1fr;}}
  .pg-footer{position:relative;z-index:1;text-align:center;padding:1.4rem 2rem 2.2rem;border-top:1px solid rgba(87,125,196,.12);margin-top:auto;}
  .pg-footer-text{font-size:.78rem;color:var(--text-secondary, #8ab0c9);margin-bottom:.55rem;letter-spacing:.02em;}
  .pg-footer-links{display:flex;justify-content:center;gap:1.5rem;flex-wrap:wrap;}
  .pg-footer-links button{background:none;border:none;color:#5a9ec4;font-size:.78rem;cursor:pointer;text-decoration:underline;text-underline-offset:3px;font-family:inherit;transition:color 150ms;padding:0;}
  .pg-footer-links button:hover{color:#8ee8ff;}
  .leg-overlay{position:fixed;inset:0;z-index:2000;background:rgba(2,5,14,.90);display:flex;align-items:center;justify-content:center;padding:1.5rem;}
  .leg-modal{max-width:700px;width:100%;max-height:85vh;overflow-y:auto;background:linear-gradient(160deg,rgba(10,16,36,.97),rgba(4,8,22,.98));border:1px solid rgba(87,140,255,.22);border-radius:22px;padding:2.5rem 2.25rem;box-shadow:0 0 80px rgba(0,0,0,.6),0 0 40px rgba(0,170,255,.08);}
  .leg-modal h2{font-family:'Orbitron',sans-serif;font-size:1.1rem;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:var(--text-primary, #dff7ff);text-shadow:0 0 12px rgba(47,170,255,.4);margin-bottom:1.5rem;padding-bottom:.75rem;border-bottom:1px solid rgba(87,125,196,.18);}
  .leg-modal h3{font-size:.82rem;text-transform:uppercase;letter-spacing:.14em;color:#8ee8ff;margin:1.4rem 0 .45rem;}
  .leg-modal p{color:var(--text-secondary, #8ab0c9);font-size:.88rem;line-height:1.75;margin-bottom:.75rem;}
  .leg-modal strong{color:#c8dff5;}
  .leg-warn{color:#ff9a6c;font-size:.82rem;padding:.7rem 1rem;border-radius:8px;background:rgba(255,100,40,.07);border:1px solid rgba(255,100,40,.18);margin-bottom:.75rem;}
  .leg-close{float:right;background:none;border:1px solid rgba(109,162,255,.22);color:var(--text-secondary, #8ab0c9);padding:.35rem .9rem;border-radius:8px;cursor:pointer;font-size:.78rem;font-family:inherit;transition:border-color 150ms,color 150ms;}
  .leg-close:hover{border-color:rgba(80,208,255,.5);color:#8ee8ff;}
`;

const paypalClientId = import.meta.env.VITE_PAYPAL_CLIENT_ID || '';
const stripePublishableKey = import.meta.env.VITE_STRIPE_PUBLISHABLE_KEY || '';

const PLANS = [
  {
    id: 'starter',
    name: 'Standard Global',
    price: '$500 / month',
    amount: '500',
    features: ['Up to 5 cameras / locations', 'Automated incident reports', 'Standard support'],
  },
  {
    id: 'growth',
    name: 'Business Global',
    price: '$950 / month',
    amount: '950',
    features: ['Up to 15 cameras / locations', 'AI-accelerated reporting', 'Priority support'],
    recommended: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise Global',
    price: '$1,500 / month',
    amount: '1500',
    features: ['Unlimited cameras', 'Dedicated AI analytics', '24/7 premium SLA support'],
  },
];

export default function Login() {
  const navigate = useNavigate();
  const [email, setEmail] = useState(() => localStorage.getItem('rememberedEmail') || '');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(() => localStorage.getItem('rememberMe') === 'true');
  const ppRef = useRef(null);
  const cardRef = useRef(null);
  const stripeRef = useRef(null);
  const stripeElementsRef = useRef(null);
  const [planId, setPlanId] = useState('growth');
  const [step, setStep] = useState('plans');
  const [paymentMethod, setPaymentMethod] = useState('paypal');
  const [ppStatus, setPpStatus] = useState('');
  const [ppError, setPpError] = useState('');
  const [cardStatus, setCardStatus] = useState('');
  const [cardError, setCardError] = useState('');
  const [cardSubmitting, setCardSubmitting] = useState(false);
  const [district, setDistrict] = useState('');
  const [contacts, setContacts] = useState({ police: '', fire: '', ambulance: '', command: '' });
  const [legalModal, setLegalModal] = useState(null);

  const plan = PLANS.find((p) => p.id === planId) || PLANS[1];
  const checkoutContacts = {
    policeStation: contacts.police,
    fireService: contacts.fire,
    ambulance: contacts.ambulance,
    localCommand: contacts.command,
  };
  const contactsFilled = [district, contacts.police, contacts.fire, contacts.ambulance, contacts.command].every(
    (v) => String(v || '').trim().length > 0
  );

  useEffect(() => {
    if (step !== 'checkout' || !contactsFilled || paymentMethod !== 'paypal') return;
    let cancelled = false;
    setPpError('');

    (async () => {
      try {
        const paypal = await loadPayPalSdk(paypalClientId, 'USD');
        if (cancelled || !ppRef.current) return;
        ppRef.current.innerHTML = '';

        const buttons = paypal.Buttons({
          style: { layout: 'vertical', shape: 'rect', label: 'paypal', height: 48 },
          createOrder: async () => {
            const res = await api.post('/paypal/orders', {
              planId: plan.id,
              district,
              contacts: checkoutContacts,
              idempotencyKey: window.crypto?.randomUUID?.(),
            });
            return res.data.id;
          },
          onApprove: async (data) => {
            const res = await api.post(`/paypal/orders/${data.orderID}/capture`);
            if (!cancelled) {
              storePendingPayment({
                provider: 'paypal',
                paymentId: res.data.paymentId,
                paymentReference: data.orderID,
                planId: res.data.planId,
              });
              setStep('complete');
              setPpStatus(`Payment confirmed: ${res.data.status || 'COMPLETED'}`);
              navigate(`/onboarding?payment=${encodeURIComponent(res.data.paymentId)}`);
            }
          },
          onCancel: () => { if (!cancelled) setPpStatus('PayPal checkout cancelled.'); },
          onError: (err) => { if (!cancelled) setPpError(err?.message || 'PayPal checkout failed.'); },
        });

        if (!buttons.isEligible()) {
          if (!cancelled) setPpError('PayPal is not available in this browser.');
          return;
        }
        await buttons.render(ppRef.current);
      } catch (err) {
        if (!cancelled) setPpError(err?.message || 'Failed to load PayPal.');
      }
    })();

    return () => {
      cancelled = true;
      if (ppRef.current) ppRef.current.innerHTML = '';
    };
  }, [step, paymentMethod, plan.id, plan.name, plan.amount, district,
    checkoutContacts.policeStation, checkoutContacts.fireService, checkoutContacts.ambulance,
    checkoutContacts.localCommand, contactsFilled, navigate]);

  useEffect(() => {
    if (step !== 'checkout' || !contactsFilled || paymentMethod !== 'card') return;
    let cancelled = false;
    let paymentElement = null;
    setCardError('');
    setCardStatus('');

    (async () => {
      try {
        const intent = await api.post('/payments/card/intent', {
          planId: plan.id,
          district,
          contacts: checkoutContacts,
          idempotencyKey: window.crypto?.randomUUID?.(),
        });
        const stripe = await loadStripeSdk(stripePublishableKey);
        if (cancelled || !cardRef.current) return;

        stripeRef.current = stripe;
        stripeElementsRef.current = stripe.elements({
          clientSecret: intent.data.client_secret,
          appearance: { theme: 'night' },
        });

        cardRef.current.innerHTML = '';
        paymentElement = stripeElementsRef.current.create('payment');
        paymentElement.mount(cardRef.current);
        setCardStatus(`Card checkout ready for ${plan.name}.`);
      } catch (err) {
        if (!cancelled) {
          setCardError(err?.response?.data?.error || err?.message || 'Failed to load card checkout.');
        }
      }
    })();

    return () => {
      cancelled = true;
      if (paymentElement) paymentElement.unmount();
      stripeElementsRef.current = null;
      stripeRef.current = null;
      if (cardRef.current) cardRef.current.innerHTML = '';
    };
  }, [step, paymentMethod, plan.id, plan.name, district,
    checkoutContacts.policeStation, checkoutContacts.fireService, checkoutContacts.ambulance,
    checkoutContacts.localCommand, contactsFilled]);

  const handleCardCheckout = async () => {
    if (!stripeRef.current || !stripeElementsRef.current) {
      setCardError('Card checkout is still loading.');
      return;
    }

    setCardSubmitting(true);
    setCardError('');
    try {
      const result = await stripeRef.current.confirmPayment({
        elements: stripeElementsRef.current,
        redirect: 'if_required',
      });

      if (result.error) {
        throw new Error(result.error.message || 'Card payment failed.');
      }

      const paymentIntentId = result.paymentIntent?.id;
      const res = await api.post('/payments/card/confirm', {
        paymentIntentId,
      });

      storePendingPayment({
        provider: 'card',
        paymentId: res.data.paymentId,
        paymentReference: paymentIntentId,
        planId: res.data.planId,
      });
      setStep('complete');
      setCardStatus(`Payment confirmed: ${res.data.status || 'SUCCEEDED'}`);
      navigate(`/onboarding?payment=${encodeURIComponent(res.data.paymentId)}`);
    } catch (err) {
      setCardError(err?.response?.data?.error || err?.message || 'Card payment failed.');
    } finally {
      setCardSubmitting(false);
    }
  };

  const handleLogin = async (e) => {
    e.preventDefault();
    clearPendingPayment();
    try {
      // Handle Remember Me
      if (rememberMe) {
        localStorage.setItem('rememberedEmail', email);
        localStorage.setItem('rememberMe', 'true');
      } else {
        localStorage.removeItem('rememberedEmail');
        localStorage.setItem('rememberMe', 'false');
      }

      // Clear any stale session data first
      localStorage.removeItem('currentUser');

      const data = await signIn(email, password);
      if (data.user) {
        navigate('/dashboard');
      }
    } catch (err) {
      alert('Invalid credentials: ' + (err.message || 'Please check your email and password.'));
    }
  };

  return (
    <>
      <style>{PAGE_CSS}</style>
      <div className="pg">
        <header className="pg-header">
          <div className="pg-emblem" aria-hidden="true">&#x1F6E1;</div>
          <p className="pg-kicker">Global AI Surveillance</p>
          <h1 className="pg-title">D&amp;D SECURITY DASHBOARD</h1>
          <p className="pg-tagline">Neon-grade surveillance intelligence for cameras, detections and live threat awareness.</p>
        </header>

        <main className="pg-grid">
          {/* LEFT — Pricing plans */}
          <div className="pr">
            <div>
              <p className="pr-eyebrow">Transparent pricing</p>
              <h2 className="pr-heading">Choose your monitoring plan</h2>
              <p className="pr-sub">Activate your subscription via secure PayPal checkout &#x2014; no hidden fees, cancel anytime.</p>
            </div>

            {step !== 'complete' ? (
              <>
                <div className="pr-cards">
                  {PLANS.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      className={`pr-card${planId === p.id ? ' pr-card-sel' : ''}${p.recommended ? ' pr-card-rec' : ''}`}
                      onClick={() => {
                        setPlanId(p.id);
                        setStep('contacts');
                        setPpStatus('');
                        setPpError('');
                        setCardStatus('');
                        setCardError('');
                      }}
                    >
                      {p.recommended && <span className="pr-badge">Most popular</span>}
                      <strong className="pr-name">{p.name}</strong>
                      <span className="pr-price">{p.price}</span>
                      <ul className="pr-features" aria-label={`${p.name} features`}>
                        {p.features.map((f) => <li key={f}>{f}</li>)}
                      </ul>
                      <span className="pr-sel-label">{planId === p.id ? 'Selected' : 'Select plan'}</span>
                    </button>
                  ))}
                </div>

                {step !== 'plans' && (
                  <div className="pr-checkout">
                    <h3>Emergency contacts &#x2014; <strong>{plan.name}</strong></h3>
                    <p className="pr-checkout-note">Required for emergency dispatch integration. Stored securely with your subscription order.</p>
                    <div className="pr-contact-grid">
                      <label className="pr-cfield">
                        <span>District / Region</span>
                        <input value={district} onChange={(e) => setDistrict(e.target.value)} placeholder="District or county" required />
                      </label>
                      <label className="pr-cfield">
                        <span>Police station</span>
                        <input value={contacts.police} onChange={(e) => setContacts((c) => ({ ...c, police: e.target.value }))} placeholder="110 / local number" required />
                      </label>
                      <label className="pr-cfield">
                        <span>Fire service</span>
                        <input value={contacts.fire} onChange={(e) => setContacts((c) => ({ ...c, fire: e.target.value }))} placeholder="112 / local number" required />
                      </label>
                      <label className="pr-cfield">
                        <span>Ambulance / medical</span>
                        <input value={contacts.ambulance} onChange={(e) => setContacts((c) => ({ ...c, ambulance: e.target.value }))} placeholder="Medical emergency number" required />
                      </label>
                      <label className="pr-cfield">
                        <span>Local command center</span>
                        <input value={contacts.command} onChange={(e) => setContacts((c) => ({ ...c, command: e.target.value }))} placeholder="District dispatch" required />
                      </label>
                    </div>

                    {contactsFilled && (
                      <div style={{ display: 'flex', gap: '.75rem', flexWrap: 'wrap', marginBottom: '1rem' }}>
                        <button
                          type="button"
                          onClick={() => setPaymentMethod('paypal')}
                          style={{
                            padding: '.65rem 1rem',
                            borderRadius: '999px',
                            border: paymentMethod === 'paypal' ? '1px solid rgba(0,212,255,.7)' : '1px solid rgba(87,125,196,.3)',
                            background: paymentMethod === 'paypal' ? 'rgba(0,212,255,.15)' : 'rgba(4,10,28,.65)',
                            color: 'var(--text-primary, #dff7ff)',
                            cursor: 'pointer',
                          }}
                        >
                          PayPal
                        </button>
                        <button
                          type="button"
                          onClick={() => setPaymentMethod('card')}
                          style={{
                            padding: '.65rem 1rem',
                            borderRadius: '999px',
                            border: paymentMethod === 'card' ? '1px solid rgba(0,212,255,.7)' : '1px solid rgba(87,125,196,.3)',
                            background: paymentMethod === 'card' ? 'rgba(0,212,255,.15)' : 'rgba(4,10,28,.65)',
                            color: 'var(--text-primary, #dff7ff)',
                            cursor: 'pointer',
                          }}
                        >
                          Visa / Mastercard
                        </button>
                      </div>
                    )}

                    {contactsFilled && step === 'contacts' && (
                      <button
                        className="pr-proceed-btn"
                        type="button"
                        onClick={() => {
                          setPpStatus('');
                          setPpError('');
                          setCardStatus('');
                          setCardError('');
                          setStep('checkout');
                        }}
                      >
                        Continue to checkout
                      </button>
                    )}

                    {step === 'checkout' && paymentMethod === 'paypal' && (
                      <div className="pr-pp-wrap" ref={ppRef} aria-live="polite" />
                    )}

                    {step === 'checkout' && paymentMethod === 'card' && (
                      <div style={{ display: 'grid', gap: '.9rem', marginTop: '1rem' }}>
                        <div ref={cardRef} style={{ minHeight: 160, padding: '.9rem', borderRadius: '12px', border: '1px solid rgba(87,125,196,.25)', background: 'rgba(4,10,28,.72)' }} />
                        <button className="pr-proceed-btn" type="button" onClick={handleCardCheckout} disabled={cardSubmitting}>
                          {cardSubmitting ? 'Processing card...' : 'Pay with card'}
                        </button>
                      </div>
                    )}

                    {ppError && <p className="pr-error" role="alert">{ppError}</p>}
                    {ppStatus && <p className="pr-status-msg" role="status">{ppStatus}</p>}
                    {cardError && <p className="pr-error" role="alert">{cardError}</p>}
                    {cardStatus && <p className="pr-status-msg" role="status">{cardStatus}</p>}
                  </div>
                )}
              </>
            ) : (
              <div className="pr-success" role="status">
                <span className="pr-success-icon" aria-hidden="true">&#x2713;</span>
                <h3>Payment successful!</h3>
                <p>Your <strong>{plan.name}</strong> plan is now active. Sign in to access your security dashboard.</p>
              </div>
            )}
          </div>

          {/* RIGHT — Login form */}
          <section className="lc" aria-labelledby="lc-title">
            <p className="lc-kicker">Secure access</p>
            <h3 id="lc-title">ACCESS TERMINAL</h3>
            <p className="lc-desc">Sign in to continue into the secured monitoring console.</p>
            <form onSubmit={handleLogin} className="lc-form">
              <label className="lc-field">
                <span>Email</span>
                <input
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="operator@agency.com"
                  required
                  autoComplete="email"
                />
              </label>
              <label className="lc-field">
                <span>Password</span>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Enter your password"
                  required
                  autoComplete="current-password"
                />
              </label>
              <div className="lc-remember">
                <input
                  type="checkbox"
                  id="rememberMe"
                  checked={rememberMe}
                  onChange={(e) => setRememberMe(e.target.checked)}
                />
                <label htmlFor="rememberMe">Remember me</label>
              </div>
              <button type="submit" className="lc-btn">Enter Secure Console</button>
            </form>
          </section>
        </main>

        <footer className="pg-footer">
          <p className="pg-footer-text">&#xA9; 2026 D&amp;D Security Dashboard. All rights reserved.</p>
          <div className="pg-footer-links">
            <button type="button" onClick={() => setLegalModal('tos')}>Terms of Service</button>
            <button type="button" onClick={() => setLegalModal('pp')}>Privacy Policy</button>
          </div>
        </footer>
      </div>

      {legalModal && (
        <div className="leg-overlay" role="dialog" aria-modal="true" aria-labelledby="leg-modal-title" onClick={() => setLegalModal(null)}>
          <div className="leg-modal" onClick={(e) => e.stopPropagation()}>
            <button className="leg-close" type="button" onClick={() => setLegalModal(null)}>Close &#x2715;</button>

            {legalModal === 'tos' ? (
              <>
                <h2 id="leg-modal-title">Terms of Service</h2>
                <p><strong>Last updated: July 1, 2026</strong></p>

                <h3>1. Service Description</h3>
                <p>D&amp;D Security Dashboard is an auxiliary software tool based on AI detection and RTSP streaming. It provides real-time monitoring, automated incident reporting, and surveillance analytics for registered subscribers.</p>

                <h3>2. Limitation of Liability</h3>
                <p className="leg-warn"><strong>IMPORTANT &#x2014; PLEASE READ:</strong> D&amp;D Security bears NO legal, material or financial liability in the event of theft, burglary, property damage, or system failure caused by: interruption of the client&#x2019;s internet connection, server downtime, hardware malfunctions at the monitored location, or any other circumstances beyond our direct control.</p>
                <p>D&amp;D Security Dashboard is a monitoring aid, not a replacement for professional on-site security personnel, law enforcement, or physical security infrastructure. The platform does not guarantee the prevention of any criminal activity or unauthorized access.</p>

                <h3>3. User Responsibilities</h3>
                <p>The user is obligated to ensure a stable RTSP stream and provide accurate emergency service numbers through the Setup Wizard before accessing the dashboard. Failure to provide correct contact information may delay emergency response and absolves D&amp;D Security of any related liability.</p>
                <p>You are responsible for ensuring your use of this platform complies with all applicable laws and regulations in your jurisdiction, including data protection and surveillance laws.</p>

                <h3>4. Subscription &amp; Payments</h3>
                <p>Subscriptions are billed monthly through PayPal. Fees are non-refundable except where required by applicable law. D&amp;D Security reserves the right to modify pricing with 30 days&#x2019; notice to subscribers.</p>

                <h3>5. Service Availability</h3>
                <p>We strive for maximum uptime but do not guarantee uninterrupted service. Scheduled maintenance windows and force majeure events are excluded from any service level commitments.</p>

                <h3>6. Acceptable Use</h3>
                <p>You agree not to use the platform for unlawful surveillance, to monitor individuals without their consent where required by law, or to interfere with the platform&#x2019;s systems, infrastructure, or other users&#x2019; accounts.</p>

                <h3>7. Governing Law &amp; Disputes</h3>
                <p>These Terms are governed by applicable international commercial law. Any disputes shall be resolved through binding arbitration in the jurisdiction of D&amp;D Security&#x2019;s principal place of business.</p>

                <h3>8. Modifications</h3>
                <p>D&amp;D Security reserves the right to update these Terms at any time. Continued use of the platform following notification of changes constitutes acceptance of the updated Terms.</p>
              </>
            ) : (
              <>
                <h2 id="leg-modal-title">Privacy Policy</h2>
                <p><strong>Last updated: July 1, 2026</strong></p>

                <h3>1. Video &amp; Stream Data</h3>
                <p>Video streams from cameras are processed in real-time in server temporary memory exclusively for the purpose of AI analysis and security detections. <strong>The platform does not store, record, or share video footage with third parties</strong>, except in cases required by law or investigation by official government agencies (police, judiciary).</p>

                <h3>2. Personal Data We Collect</h3>
                <p>We collect the following data to provide our service: account email address, subscription payment records (processed by PayPal &#x2014; subject to PayPal&#x2019;s own Privacy Policy), emergency contact numbers provided during setup, and camera metadata (names, locations, RTSP endpoints).</p>

                <h3>3. How We Use Your Data</h3>
                <p>Collected data is used solely to: authenticate your account, process your subscription payment, display camera feeds and AI-generated incident alerts, and enable emergency service integration. We do not sell or rent your personal data to any third parties.</p>

                <h3>4. Data Storage &amp; Security</h3>
                <p>Account and subscription data is stored in encrypted databases hosted on secure cloud infrastructure. AI detection events and incident logs are retained for operational purposes and may be reviewed by authorized D&amp;D Security personnel for service improvement only.</p>

                <h3>5. Third-Party Services</h3>
                <p>We use the following third-party services: <strong>PayPal</strong> for payment processing, and <strong>Neon</strong> for authentication and database hosting. Each provider maintains their own data protection standards and privacy policies.</p>

                <h3>6. Law Enforcement Requests</h3>
                <p>In the event of a lawful request from official government authorities (police, judiciary, or regulatory bodies), we may be required to disclose relevant account information or incident data. We will notify affected users where legally permitted to do so.</p>

                <h3>7. Your Rights</h3>
                <p>You have the right to access, correct, or request deletion of your personal data held by D&amp;D Security. To exercise these rights, contact us through your dashboard account settings or via our support channel.</p>

                <h3>8. Contact</h3>
                <p>For privacy-related inquiries or data subject requests, please contact our data protection team through the platform&#x2019;s support channel.</p>
              </>
            )}
          </div>
        </div>
      )}
    </>
  );
}