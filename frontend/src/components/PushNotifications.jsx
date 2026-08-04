import React, { useState, useEffect } from 'react';

/**
 * Push Notifications - OPTIMIZOVAN
 * 
 * Koristi Web Push API - NEMA CPU/GPU processing!
 * - Service Worker prima notifikacije u pozadini
 * - Notifikacije se prikazuju čak i kad je sajt zatvoren
 * - Server šalje push, browser samo prikazuje
 * 
 * CPU/GPU opterećenje: ~0%
 */
const PushNotifications = () => {
  const [permission, setPermission] = useState('default');
  const [notifications, setNotifications] = useState([]);
  const [settings, setSettings] = useState({
    motion: true,
    person: true,
    vehicle: true,
    face: true,
    intrusion: true,
    critical: true
  });

  useEffect(() => {
    // Check current permission
    if ('Notification' in window) {
      setPermission(Notification.permission);
    }
    
    // Load saved notifications
    const saved = localStorage.getItem('pushNotifications');
    if (saved) {
      setNotifications(JSON.parse(saved));
    }
  }, []);

  // Request permission
  const requestPermission = async () => {
    if (!('Notification' in window)) {
      alert('Your browser does not support push notifications');
      return;
    }

    try {
      const permission = await Notification.requestPermission();
      setPermission(permission);
      
      if (permission === 'granted') {
        // Register service worker
        if ('serviceWorker' in navigator) {
          const registration = await navigator.serviceWorker.register('/sw.js');
          console.log('Service Worker registered:', registration);
        }
      }
    } catch (err) {
      console.error('Permission error:', err);
    }
  };

  // Toggle notification type
  const toggleNotification = (type) => {
    const newSettings = { ...settings, [type]: !settings[type] };
    setSettings(newSettings);
    localStorage.setItem('notificationSettings', JSON.stringify(newSettings));
    
    // Update subscription
    updateSubscription(newSettings);
  };

  // Update push subscription
  const updateSubscription = async (newSettings) => {
    if (permission !== 'granted') return;
    
    try {
      const registration = await navigator.serviceWorker.ready;
      const subscription = await registration.pushManager.getSubscription();
      
      if (subscription) {
        // Update server with new settings
        await fetch('/api/push/subscribe', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            subscription: subscription.toJSON(),
            settings: newSettings
          })
        });
      }
    } catch (err) {
      console.error('Subscription update failed:', err);
    }
  };

  // Clear notification history
  const clearNotifications = () => {
    setNotifications([]);
    localStorage.setItem('pushNotifications', '[]');
  };

  return (
    <div style={{
      background: 'rgba(10,18,38,.95)',
      border: '1px solid rgba(87,140,255,.18)',
      borderRadius: '16px',
      padding: '1.5rem'
    }}>
      <h3 style={{ color: '#dff7ff', marginBottom: '1rem' }}>
        🔔 Push Notifications
      </h3>

      {/* Permission Status */}
      <div style={{
        padding: '1rem',
        background: permission === 'granted' 
          ? 'rgba(0,212,80,.1)' 
          : permission === 'denied'
            ? 'rgba(255,80,80,.1)'
            : 'rgba(255,180,50,.1)',
        borderRadius: '12px',
        marginBottom: '1rem',
        display: 'flex',
        alignItems: 'center',
        gap: '1rem'
      }}>
        <span style={{ fontSize: '2rem' }}>
          {permission === 'granted' ? '✅' : permission === 'denied' ? '❌' : '⚠️'}
        </span>
        <div>
          <div style={{ color: '#dff7ff', fontWeight: 'bold' }}>
            {permission === 'granted' 
              ? 'Notifications Enabled' 
              : permission === 'denied'
                ? 'Notifications Blocked'
                : 'Notifications Not Enabled'}
          </div>
          <div style={{ color: '#8ab0c9', fontSize: '.85rem' }}>
            {permission === 'granted' 
              ? 'You will receive alerts on this device' 
              : permission === 'denied'
                ? 'Please enable in browser settings'
                : 'Enable to receive security alerts'}
          </div>
        </div>
        {permission !== 'granted' && permission !== 'denied' && (
          <button
            onClick={requestPermission}
            style={{
              marginLeft: 'auto',
              padding: '.5rem 1rem',
              background: 'linear-gradient(135deg,#00d4ff,#8c4dff)',
              border: 'none',
              borderRadius: '8px',
              color: '#03101c',
              fontWeight: 'bold',
              cursor: 'pointer'
            }}
          >
            Enable
          </button>
        )}
      </div>

      {/* Notification Settings */}
      {permission === 'granted' && (
        <>
          <h4 style={{ color: '#8ee8ff', marginBottom: '.75rem', fontSize: '.9rem' }}>
            Alert Types
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem', marginBottom: '1rem' }}>
            {[
              { key: 'critical', label: '🔴 Critical Alerts', desc: 'Emergency situations' },
              { key: 'intrusion', label: '🚨 Intrusion Detected', desc: 'Unauthorized access' },
              { key: 'person', label: '👤 Person Detected', desc: 'Human detection' },
              { key: 'vehicle', label: '🚗 Vehicle Detected', desc: 'Vehicle movement' },
              { key: 'face', label: '👤 Unknown Face', desc: 'Face recognition alerts' },
              { key: 'motion', label: '📹 Motion Detected', desc: 'General motion alerts' }
            ].map(item => (
              <label
                key={item.key}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1rem',
                  padding: '.75rem',
                  background: 'rgba(87,125,196,.1)',
                  borderRadius: '10px',
                  cursor: 'pointer'
                }}
              >
                <input
                  type="checkbox"
                  checked={settings[item.key]}
                  onChange={() => toggleNotification(item.key)}
                  style={{ width: '20px', height: '20px', accentColor: '#00d4ff' }}
                />
                <div style={{ flex: 1 }}>
                  <div style={{ color: '#dff7ff', fontWeight: 'bold' }}>{item.label}</div>
                  <div style={{ color: '#6a8aaa', fontSize: '.8rem' }}>{item.desc}</div>
                </div>
              </label>
            ))}
          </div>
        </>
      )}

      {/* Recent Notifications */}
      {notifications.length > 0 && (
        <>
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '.75rem'
          }}>
            <h4 style={{ color: '#8ee8ff', margin: 0, fontSize: '.9rem' }}>
              Recent Alerts
            </h4>
            <button
              onClick={clearNotifications}
              style={{
                padding: '.25rem .5rem',
                background: 'transparent',
                border: '1px solid rgba(87,125,196,.3)',
                borderRadius: '6px',
                color: '#8ab0c9',
                fontSize: '.75rem',
                cursor: 'pointer'
              }}
            >
              Clear All
            </button>
          </div>
          <div style={{ maxHeight: '200px', overflowY: 'auto' }}>
            {notifications.slice(0, 5).map((notif, i) => (
              <div
                key={i}
                style={{
                  padding: '.75rem',
                  background: 'rgba(255,80,80,.05)',
                  borderLeft: '3px solid #ff5050',
                  borderRadius: '0 8px 8px 0',
                  marginBottom: '.5rem'
                }}
              >
                <div style={{ color: '#dff7ff', fontWeight: 'bold' }}>{notif.title}</div>
                <div style={{ color: '#8ab0c9', fontSize: '.8rem' }}>{notif.message}</div>
                <div style={{ color: '#6a8aaa', fontSize: '.7rem', marginTop: '.25rem' }}>
                  {new Date(notif.time).toLocaleString()}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
};

export default PushNotifications;
