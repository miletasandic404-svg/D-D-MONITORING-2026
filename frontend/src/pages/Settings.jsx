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
`;

export default function Settings() {
  const [notifications, setNotifications] = useState(true);
  const [autoReports, setAutoReports] = useState(false);
  const [mapOverlay, setMapOverlay] = useState(true);
  const [apiStatus, setApiStatus] = useState('checking');
  const [dbStatus, setDbStatus] = useState('checking');

  useEffect(() => {
    checkSystemStatus();
  }, []);

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
              className={`toggle ${notifications ? 'active' : ''}`} 
              onClick={() => setNotifications(!notifications)}
            />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Push Notifications</div>
              <div className="setting-desc">Browser push notifications for real-time alerts</div>
            </div>
            <div className="toggle active" />
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
              className={`toggle ${autoReports ? 'active' : ''}`} 
              onClick={() => setAutoReports(!autoReports)}
            />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Weekly Summary</div>
              <div className="setting-desc">Send weekly incident summary to email</div>
            </div>
            <div className="toggle" />
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
              className={`toggle ${mapOverlay ? 'active' : ''}`} 
              onClick={() => setMapOverlay(!mapOverlay)}
            />
          </div>
          <div className="setting-row">
            <div>
              <div className="setting-label">Dark Mode</div>
              <div className="setting-desc">Always use dark theme</div>
            </div>
            <div className="toggle active" />
          </div>
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
