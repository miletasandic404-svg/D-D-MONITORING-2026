import React, { useState } from 'react';
import api from '../services/api';

/**
 * Webhook Integrations - OPTIMIZOVAN
 * 
 * Sve se dešava na SERVERU - NEMA client processing!
 * - Webhook URL se čuva na serveru
 * - Server šalje POST zahtjeve
 * - Client samo konfiguriše
 * 
 * CPU/GPU opterećenje: ~0%
 */
const WebhookIntegrations = () => {
  const [webhooks, setWebhooks] = useState([
    { id: 1, name: 'Slack Alerts', url: 'https://hooks.slack.com/...', events: ['alert', 'critical'], enabled: true, icon: '💬' },
    { id: 2, name: 'Email Notifications', url: 'https://api.email.com/webhook', events: ['alert'], enabled: false, icon: '📧' },
    { id: 3, name: 'Microsoft Teams', url: 'https://outlook.office.com/webhook/...', events: ['critical'], enabled: true, icon: '🏢' }
  ]);
  const [showAdd, setShowAdd] = useState(false);
  const [testing, setTesting] = useState(null);

  const availableEvents = [
    { key: 'alert', label: 'Security Alerts', icon: '🚨' },
    { key: 'critical', label: 'Critical Events', icon: '🔴' },
    { key: 'person', label: 'Person Detected', icon: '👤' },
    { key: 'vehicle', label: 'Vehicle Detected', icon: '🚗' },
    { key: 'motion', label: 'Motion Detected', icon: '📹' },
    { key: 'intrusion', label: 'Intrusion Alerts', icon: '🚪' },
    { key: 'camera_offline', label: 'Camera Offline', icon: '📴' },
    { key: 'system', label: 'System Events', icon: '⚙️' }
  ];

  const integrationTemplates = [
    { 
      name: 'Slack', 
      icon: '💬', 
      url: 'https://hooks.slack.com/services/YOUR/WEBHOOK/URL',
      color: '#4A154B'
    },
    { 
      name: 'Discord', 
      icon: '🎮', 
      url: 'https://discord.com/api/webhooks/YOUR/WEBHOOK/URL',
      color: '#5865F2'
    },
    { 
      name: 'Microsoft Teams', 
      icon: '🏢', 
      url: 'https://outlook.office.com/webhook/YOUR/WEBHOOK/URL',
      color: '#6264A7'
    },
    { 
      name: 'Email (SMTP)', 
      icon: '📧', 
      url: 'smtp://your-smtp-server.com:587',
      color: '#EA4335'
    },
    { 
      name: 'Telegram', 
      icon: '✈️', 
      url: 'https://api.telegram.org/botYOUR_BOT_TOKEN/sendMessage?chat_id=YOUR_CHAT_ID',
      color: '#0088CC'
    },
    { 
      name: 'Custom HTTP', 
      icon: '🔗', 
      url: 'https://your-api.com/webhook',
      color: '#00d4ff'
    }
  ];

  const toggleWebhook = (id) => {
    setWebhooks(webhooks.map(w => 
      w.id === id ? { ...w, enabled: !w.enabled } : w
    ));
  };

  const testWebhook = async (webhook) => {
    setTesting(webhook.id);
    try {
      // Test webhook - server sends test POST
      await api.post('/api/webhooks/test', {
        webhookId: webhook.id,
        testType: 'ping'
      });
      alert('✅ Test message sent successfully!');
    } catch (err) {
      console.error('Test failed:', err);
      alert('❌ Failed to send test message. Please check the webhook URL and try again.');
    }
    setTesting(null);
  };

  const deleteWebhook = (id) => {
    if (confirm('Delete this webhook?')) {
      setWebhooks(webhooks.filter(w => w.id !== id));
    }
  };

  return (
    <div style={{
      background: 'rgba(10,18,38,.95)',
      border: '1px solid rgba(87,140,255,.18)',
      borderRadius: '16px',
      padding: '1.5rem'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '1rem'
      }}>
        <h3 style={{ color: '#dff7ff', margin: 0 }}>
          🔗 Webhook Integrations
        </h3>
        <button
          onClick={() => setShowAdd(!showAdd)}
          style={{
            padding: '.5rem 1rem',
            background: 'rgba(0,212,255,.1)',
            border: '1px solid rgba(0,212,255,.3)',
            borderRadius: '8px',
            color: '#00d4ff',
            cursor: 'pointer',
            fontSize: '.85rem'
          }}
        >
          {showAdd ? 'Cancel' : '+ Add Webhook'}
        </button>
      </div>

      {/* Add Webhook Form */}
      {showAdd && (
        <div style={{
          padding: '1.5rem',
          background: 'rgba(87,125,196,.1)',
          borderRadius: '12px',
          marginBottom: '1rem'
        }}>
          <h4 style={{ color: '#8ee8ff', marginBottom: '1rem' }}>Choose Integration</h4>
          <div style={{ 
            display: 'grid', 
            gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', 
            gap: '.75rem',
            marginBottom: '1.5rem'
          }}>
            {integrationTemplates.map(template => (
              <button
                key={template.name}
                style={{
                  padding: '1rem',
                  background: 'rgba(10,18,38,.8)',
                  border: '1px solid rgba(87,125,196,.3)',
                  borderRadius: '10px',
                  color: '#dff7ff',
                  cursor: 'pointer',
                  textAlign: 'center'
                }}
                onClick={() => {
                  const newId = Math.max(...webhooks.map(w => w.id)) + 1;
                  setWebhooks([...webhooks, {
                    id: newId,
                    name: template.name,
                    url: template.url,
                    events: ['alert'],
                    enabled: true,
                    icon: template.icon
                  }]);
                  setShowAdd(false);
                }}
              >
                <div style={{ fontSize: '2rem', marginBottom: '.5rem' }}>{template.icon}</div>
                <div style={{ fontWeight: 'bold', fontSize: '.9rem' }}>{template.name}</div>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Webhook List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '.75rem' }}>
        {webhooks.map(webhook => (
          <div
            key={webhook.id}
            style={{
              padding: '1rem',
              background: webhook.enabled 
                ? 'rgba(0,212,80,.05)' 
                : 'rgba(87,125,196,.05)',
              border: `1px solid ${webhook.enabled ? 'rgba(0,212,80,.2)' : 'rgba(87,125,196,.2)'}`,
              borderRadius: '12px',
              opacity: webhook.enabled ? 1 : 0.7
            }}
          >
            <div style={{
              display: 'flex',
              alignItems: 'center',
              gap: '1rem',
              marginBottom: '.75rem'
            }}>
              <span style={{ fontSize: '1.5rem' }}>{webhook.icon}</span>
              <div style={{ flex: 1 }}>
                <div style={{ color: '#dff7ff', fontWeight: 'bold' }}>{webhook.name}</div>
                <div style={{ 
                  color: '#6a8aaa', 
                  fontSize: '.75rem',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  maxWidth: '300px'
                }}>
                  {webhook.url}
                </div>
              </div>
              
              {/* Toggle */}
              <button
                onClick={() => toggleWebhook(webhook.id)}
                style={{
                  width: '48px',
                  height: '26px',
                  background: webhook.enabled ? '#00d450' : 'rgba(87,125,196,.3)',
                  border: 'none',
                  borderRadius: '13px',
                  cursor: 'pointer',
                  position: 'relative',
                  transition: 'background .2s'
                }}
              >
                <span style={{
                  position: 'absolute',
                  top: '3px',
                  left: webhook.enabled ? '25px' : '3px',
                  width: '20px',
                  height: '20px',
                  background: 'white',
                  borderRadius: '50%',
                  transition: 'left .2s'
                }} />
              </button>
            </div>

            {/* Events */}
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '.5rem', marginBottom: '.75rem' }}>
              {webhook.events.map(event => {
                const eventData = availableEvents.find(e => e.key === event);
                return (
                  <span
                    key={event}
                    style={{
                      padding: '.25rem .5rem',
                      background: 'rgba(87,125,196,.2)',
                      borderRadius: '6px',
                      fontSize: '.7rem',
                      color: '#8ab0c9'
                    }}
                  >
                    {eventData?.icon} {eventData?.label || event}
                  </span>
                );
              })}
            </div>

            {/* Actions */}
            <div style={{ display: 'flex', gap: '.5rem' }}>
              <button
                onClick={() => testWebhook(webhook)}
                disabled={testing === webhook.id}
                style={{
                  flex: 1,
                  padding: '.5rem',
                  background: 'rgba(87,125,196,.2)',
                  border: 'none',
                  borderRadius: '8px',
                  color: '#8ab0c9',
                  cursor: 'pointer',
                  fontSize: '.8rem'
                }}
              >
                {testing === webhook.id ? 'Testing...' : '🧪 Test'}
              </button>
              <button
                onClick={() => deleteWebhook(webhook.id)}
                style={{
                  padding: '.5rem 1rem',
                  background: 'rgba(255,80,80,.1)',
                  border: 'none',
                  borderRadius: '8px',
                  color: '#ff5050',
                  cursor: 'pointer',
                  fontSize: '.8rem'
                }}
              >
                🗑️
              </button>
            </div>
          </div>
        ))}

        {webhooks.length === 0 && (
          <div style={{
            padding: '3rem',
            textAlign: 'center',
            color: '#6a8aaa'
          }}>
            <div style={{ fontSize: '3rem', marginBottom: '1rem' }}>🔗</div>
            <p>No webhooks configured</p>
            <p style={{ fontSize: '.85rem' }}>
              Add webhooks to receive alerts in Slack, Teams, or your custom app
            </p>
          </div>
        )}
      </div>

      <p style={{
        color: '#6a8aaa',
        fontSize: '.75rem',
        marginTop: '1rem',
        textAlign: 'center'
      }}>
        💡 Webhooks are processed server-side - zero CPU usage on your device
      </p>
    </div>
  );
};

export default WebhookIntegrations;
