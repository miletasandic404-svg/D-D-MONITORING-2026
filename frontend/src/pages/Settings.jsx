import api from '../services/api';
import React, { useState, useEffect } from 'react';

const PAGE_CSS = `
  .settings-page { padding: 2rem; color: var(--text-primary, #e5eef7); max-width: 800px; }
  .settings-title { font-family: 'Orbitron', sans-serif; font-size: 1.5rem; color: var(--text-primary, #dff5ff); margin-bottom: 2rem; }
  .settings-section { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; padding: 1.5rem; margin-bottom: 1.5rem; }
  .settings-section h2 { color: #8ee8ff; font-size: .9rem; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 1rem; }
  .setting-row { display: flex; justify-content: space-between; align-items: center; padding: 1rem 0; border-bottom: 1px solid rgba(87,125,196,.12); }
  .setting-row:last-child { border-bottom: none; }
  .setting-label { color: var(--text-primary, #dff7ff); }
  .setting-desc { color: var(--text-secondary, #8ab0c9); font-size: .85rem; margin-top: .25rem; }
  .toggle { width: 50px; height: 26px; background: rgba(87,125,196,.3); border-radius: 13px; position: relative; cursor: pointer; transition: background .2s; }
  .toggle.active { background: linear-gradient(135deg,var(--accent-primary, #00d4ff),var(--accent-secondary, #8c4dff)); }
   .toggle::after { content: ''; position: absolute; width: 20px; height: 20px; background: white; border-radius: 50%; top: 3px; left: 3px; transition: transform .2s; }
   .toggle.active::after { transform: translateX(24px); }
   .version { color: var(--text-muted, #6a8aaa); font-size: .8rem; margin-top: 2rem; text-align: center; }
   .emergency-contact-row { display: flex; gap: 1rem; align-items: flex-start; padding: 1rem 0; border-bottom: 1px solid rgba(87,125,196,.12); }
   .emergency-contact-row:last-child { border-bottom: none; }
   .emergency-contact-fields { flex: 1; display: flex; flex-direction: column; gap: .5rem; }
   .emergency-contact-fields input { width: 100%; padding: .6rem .8rem; background: rgba(87,125,196,.1); border: 1px solid rgba(87,125,196,.3); border-radius: 8px; color: var(--text-primary, #dff7ff); font-size: .9rem; }
   .emergency-contact-fields input:focus { outline: none; border-color: rgba(0,212,255,.6); }
   .emergency-contact-name { color: var(--text-primary, #dff7ff); font-weight: 600; margin-bottom: .25rem; }
   .emergency-save-btn { margin-top: 1rem; padding: .8rem 1.5rem; border: 0; border-radius: 10px; cursor: pointer; font-family: 'Orbitron', sans-serif; font-weight: 700; font-size: .8rem; text-transform: uppercase; letter-spacing: .12em; color: #03101c; background: linear-gradient(135deg,var(--accent-primary, #00d4ff),var(--accent-secondary, #8c4dff)); box-shadow: 0 0 16px rgba(0,212,255,.22); transition: transform 160ms,filter 160ms; }
   .emergency-save-btn:hover { transform: translateY(-2px); filter: brightness(1.1); }
   .emergency-save-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
   .emergency-status { margin-top: .75rem; font-size: .85rem; }
`;

export default function Settings() {
  const [settings, setSettings] = useState({
    email_alerts: true,
    push_notifications: true,
    auto_reports: false,
    weekly_summary: false,
    map_overlays: true,
    dark_mode: true,
  });
  const [emergencyContacts, setEmergencyContacts] = useState({
    police: { name: 'Police', phone: '', enabled: false },
    fire: { name: 'Fire Department', phone: '', enabled: false },
    ambulance: { name: 'Ambulance', phone: '', enabled: false },
    security: { name: 'Security', phone: '', enabled: false },
  });
  const [savingContacts, setSavingContacts] = useState(false);
  const [contactStatus, setContactStatus] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [apiStatus, setApiStatus] = useState('checking');
  const [dbStatus, setDbStatus] = useState('checking');

  useEffect(() => {
    fetchSettings();
    checkSystemStatus();
  }, []);

  const fetchSettings = async () => {
    try {
      const res = await api.get('/settings');
      if (res.data?.settings) {
        setSettings(prev => ({ ...prev, ...res.data.settings }));
        if (res.data.settings.emergency_contacts) {
          setEmergencyContacts(res.data.settings.emergency_contacts);
        }
      }
    } catch (err) {
      console.error('Failed to fetch settings:', err);
    } finally {
      setLoading(false);
    }
  };

  const saveContacts = async () => {
    setSavingContacts(true);
    setContactStatus('');
    try {
      const res = await api.put('/settings', { emergency_contacts: emergencyContacts });
      if (res.data?.settings) {
        setSettings(prev => ({ ...prev, ...res.data.settings }));
        setContactStatus('Emergency contacts saved successfully.');
      }
    } catch (err) {
      setContactStatus(err?.response?.data?.error || 'Failed to save emergency contacts');
    } finally {
      setSavingContacts(false);
    }
  };

  const updateSetting = async (key, value) => {
    setSaving(true);
    try {
      const res = await api.put('/settings', { [key]: value });
      if (res.data?.settings) {
        setSettings(prev => ({ ...prev, ...res.data.settings }));
      }
    } catch (err) {
      console.error('Failed to update setting:', err);
      alert(err?.response?.data?.error || 'Failed to save setting');
      fetchSettings();
    } finally {
      setSaving(false);
    }
  };

  const checkSystemStatus = async () => {
    try {
      const res = await fetch('/api/health');
      const data = await res.json();
      setApiStatus(data.success ? 'online' : 'offline');
      setDbStatus(data.checks?.database?.connected ? 'connected' : 'disconnected');
    } catch {
      setApiStatus('offline');
      setDbStatus('disconnected');
    }
  };

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="settings-page">
        <h1 className="settings-title">Settings</h1>

        <div className="settings-section">
          <h2>Notifications</h2>
          <div className="setting-row">
            <div>
              <div className="setting-label">Email Alerts</div>
              <div className="setting-desc">Receive email notifications for critical alerts</div>
            </div>
            <div 
              className={`toggle ${settings.email_alerts ? 'active' : ''}`} 
              onClick={() => updateSetting('email_alerts', !settings.email_alerts)}
            />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Push Notifications</div>
              <div className="setting-desc">Browser push notifications for real-time alerts</div>
            </div>
            <div 
              className={`toggle ${settings.push_notifications ? 'active' : ''}`}
              onClick={() => updateSetting('push_notifications', !settings.push_notifications)}
            />
          </div>
        </div>

        <div className="settings-section">
          <h2>Reports</h2>
          <div className="setting-row">
            <div>
              <div className="setting-label">Automatic Reports</div>
              <div className="setting-desc">Generate daily security summary reports</div>
            </div>
            <div 
              className={`toggle ${settings.auto_reports ? 'active' : ''}`} 
              onClick={() => updateSetting('auto_reports', !settings.auto_reports)}
            />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Weekly Summary</div>
              <div className="setting-desc">Send weekly incident summary to email</div>
            </div>
            <div 
              className={`toggle ${settings.weekly_summary ? 'active' : ''}`}
              onClick={() => updateSetting('weekly_summary', !settings.weekly_summary)}
            />
          </div>
        </div>

        <div className="settings-section">
          <h2>Map & Display</h2>
          <div className="setting-row">
            <div>
              <div className="setting-label">Map Overlays</div>
              <div className="setting-desc">Show camera coverage zones on map</div>
            </div>
            <div 
              className={`toggle ${settings.map_overlays ? 'active' : ''}`} 
              onClick={() => updateSetting('map_overlays', !settings.map_overlays)}
            />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Dark Mode</div>
              <div className="setting-desc">Always use dark theme</div>
            </div>
            <div 
              className={`toggle ${settings.dark_mode ? 'active' : ''}`}
              onClick={() => updateSetting('dark_mode', !settings.dark_mode)}
            />
          </div>
        </div>

        <div className="settings-section">
          <h2>Emergency Contacts</h2>
          {['police', 'fire', 'ambulance', 'security'].map((key) => {
            const contact = emergencyContacts[key] || { name: key, phone: '', enabled: false };
            return (
              <div className="emergency-contact-row" key={key}>
                <div className="emergency-contact-fields">
                  <div className="emergency-contact-name">{contact.name || key}</div>
                  <input
                    type="text"
                    value={contact.phone || ''}
                    onChange={(e) => setEmergencyContacts((prev) => ({
                      ...prev,
                      [key]: { ...(prev[key] || { name: key, enabled: false }), phone: e.target.value.trim() },
                    }))}
                    placeholder="+1 555 000 0000"
                  />
                </div>
                <div
                  className={`toggle ${contact.enabled ? 'active' : ''}`}
                  onClick={() => setEmergencyContacts((prev) => ({
                    ...prev,
                    [key]: { ...(prev[key] || { name: key, phone: '' }), enabled: !prev[key]?.enabled },
                  }))}
                />
              </div>
            );
          })}
          <button
            className="emergency-save-btn"
            onClick={saveContacts}
            disabled={savingContacts}
          >
            {savingContacts ? 'Saving...' : 'Save Changes'}
          </button>
          {contactStatus && (
            <div className="emergency-status" style={{ color: contactStatus.includes('Failed') ? '#ff5050' : '#00d450' }}>
              {contactStatus}
            </div>
          )}
        </div>

        <div className="settings-section">
          <h2>Legal</h2>
          <div className="setting-row">
            <div>
              <div className="setting-label">Terms of Service</div>
              <div className="setting-desc">Service terms and conditions</div>
            </div>
            <a 
              href="/terms-of-service.html" 
              target="_blank"
              style={{ color: 'var(--accent-primary, #00d4ff)', textDecoration: 'none', fontSize: '.85rem' }}
            >
              View →
            </a>
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Privacy Policy</div>
              <div className="setting-desc">How we handle your data</div>
            </div>
            <a 
              href="/privacy-policy.html" 
              target="_blank"
              style={{ color: 'var(--accent-primary, #00d4ff)', textDecoration: 'none', fontSize: '.85rem' }}
            >
              View →
            </a>
          </div>
        </div>

        <div className="settings-section">
          <h2>System</h2>
          <div className="setting-row">
            <div>
              <div className="setting-label">API Status</div>
              <div className="setting-desc">Backend connection status</div>
            </div>
            <span style={{ 
              color: apiStatus === 'online' ? 'var(--accent-success, #00d450)' : apiStatus === 'checking' ? '#ffa500' : 'var(--accent-danger, #ff5050)', 
              fontWeight: 'bold',
              textTransform: 'uppercase'
            }}>
              {apiStatus}
            </span>
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Database</div>
              <div className="setting-desc">PostgreSQL connection</div>
            </div>
            <span style={{ 
              color: dbStatus === 'connected' ? 'var(--accent-success, #00d450)' : dbStatus === 'checking' ? '#ffa500' : 'var(--accent-danger, #ff5050)',
              fontWeight: 'bold',
              textTransform: 'uppercase'
            }}>
              {dbStatus}
            </span>
          </div>
        </div>

        <div className="version">
          D&D Global AI Surveillance v1.0.0<br/>
          Security Command Center<br/><br/>
          <span style={{ fontSize: '.75rem', color: 'var(--text-muted, #6a8aaa)' }}>
            By using this service, you agree to our{' '}
            <a href="/terms-of-service.html" target="_blank" style={{ color: 'var(--accent-primary, #00d4ff)' }}>Terms of Service</a>
            {' '}and{' '}
            <a href="/privacy-policy.html" target="_blank" style={{ color: 'var(--accent-primary, #00d4ff)' }}>Privacy Policy</a>
          </span>
        </div>
      </main>
    </>
  );
}
