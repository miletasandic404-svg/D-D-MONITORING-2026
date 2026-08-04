import React from 'react';
import { createRoot } from 'react-dom/client';
import * as Sentry from '@sentry/react';
import App from './App';
import './styles.css';

// ── Sentry initialization ───────────────────────────────────────
if (window._env_?.VITE_SENTRY_DSN || import.meta.env.VITE_SENTRY_DSN) {
  Sentry.init({
    dsn: window._env_?.VITE_SENTRY_DSN || import.meta.env.VITE_SENTRY_DSN,
    environment: import.meta.env.MODE || 'production',
    tracesSampleRate: 0.1,
    beforeSend(event) {
      // Never send sensitive data to Sentry
      if (event.request?.data) {
        try {
          const parsed = typeof event.request.data === 'string'
            ? JSON.parse(event.request.data)
            : event.request.data;
          const redact = (obj) => {
            if (!obj || typeof obj !== 'object') return;
            for (const key of Object.keys(obj)) {
              if (['password', 'token', 'streamToken', 'session', 'authorization', 'cookie']
                .some(s => key.toLowerCase().includes(s))) {
                obj[key] = '[REDACTED]';
              } else if (typeof obj[key] === 'object') {
                redact(obj[key]);
              }
            }
          };
          redact(parsed);
          event.request.data = parsed;
        } catch {
          // If parsing fails, redact entirely
          event.request.data = '[REDACTED]';
        }
      }
      return event;
    },
  });
}

// ── Fallback UI for ErrorBoundary ───────────────────────────────
function FallbackComponent({ error, resetError }) {
  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      background: 'radial-gradient(circle at 50% 50%,rgba(0,212,255,.08),transparent 40%),linear-gradient(180deg,#050b16,#040a14)',
      color: '#e5eef7',
      fontFamily: "'Space Grotesk', sans-serif",
      padding: '2rem',
      textAlign: 'center',
    }}>
      <div style={{
        background: 'rgba(255,80,80,0.08)',
        border: '1px solid rgba(255,80,80,0.25)',
        borderRadius: '12px',
        padding: '2rem',
        maxWidth: '480px',
        width: '100%',
      }}>
        <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>⚠️</div>
        <h2 style={{ margin: '0 0 0.5rem', fontWeight: 600, fontSize: '1.25rem' }}>
          Something went wrong
        </h2>
        <p style={{ margin: '0 0 1.5rem', color: '#8ab0c9', fontSize: '0.875rem', lineHeight: 1.5 }}>
          An unexpected error occurred. Our team has been notified.
        </p>
        <button
          onClick={() => { resetError(); window.location.reload(); }}
          style={{
            padding: '0.625rem 1.5rem',
            borderRadius: '8px',
            border: 'none',
            background: '#00d4ff',
            color: '#050b16',
            fontWeight: 600,
            cursor: 'pointer',
            fontSize: '0.875rem',
          }}
        >
          Reload page
        </button>
        <p style={{ marginTop: '1rem', fontSize: '0.75rem', color: '#6a8aaa' }}>
          Error: {error?.message || 'Unknown'}
        </p>
      </div>
    </div>
  );
}

// ── Mount app with ErrorBoundary ────────────────────────────────
const container = document.getElementById('root');
const root = createRoot(container);
root.render(
  <Sentry.ErrorBoundary fallback={(props) => <FallbackComponent {...props} />}>
    <App />
  </Sentry.ErrorBoundary>
);
