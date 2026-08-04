import React, { useState, useEffect } from 'react';
import api from '../services/api';

const PAGE_CSS = `
  .alerts-page { padding: 2rem; color: var(--text-primary, #e5eef7); }
  .alerts-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
  .alerts-title { font-family: 'Orbitron', sans-serif; font-size: 1.5rem; color: var(--text-primary, #dff5ff); }
  .alert-stats { display: flex; gap: 1rem; }
  .stat-badge { padding: .5rem 1rem; border-radius: 20px; font-size: .85rem; font-weight: bold; }
  .stat-critical { background: rgba(255,80,80,.2); color: var(--accent-danger, #ff5050); border: 1px solid rgba(255,80,80,.4); }
  .stat-warning { background: rgba(255,180,50,.2); color: var(--accent-warning, #ffb432); border: 1px solid rgba(255,180,50,.4); }
  .stat-info { background: rgba(0,212,255,.15); color: var(--accent-primary, #00d4ff); border: 1px solid rgba(0,212,255,.3); }
  .alerts-list { display: flex; flex-direction: column; gap: .75rem; }
  .alert-card { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 12px; padding: 1rem 1.25rem; display: flex; align-items: center; gap: 1rem; transition: all .2s; }
  .alert-card:hover { border-color: rgba(0,212,255,.5); transform: translateX(4px); }
  .alert-icon { width: 44px; height: 44px; border-radius: 10px; display: flex; align-items: center; justify-content: center; font-size: 1.3rem; flex-shrink: 0; }
  .alert-critical { background: rgba(255,80,80,.15); }
  .alert-warning { background: rgba(255,180,50,.15); }
  .alert-info { background: rgba(0,212,255,.15); }
  .alert-content { flex: 1; }
  .alert-content h3 { color: var(--text-primary, #dff7ff); margin-bottom: .2rem; font-size: .95rem; }
  .alert-content p { color: var(--text-secondary, #8ab0c9); font-size: .8rem; }
  .alert-meta { display: flex; gap: 1rem; color: var(--text-muted, #6a8aaa); font-size: .75rem; margin-top: .3rem; }
  .alert-actions { display: flex; gap: .5rem; }
  .alert-btn { padding: .4rem .8rem; border-radius: 6px; font-size: .75rem; cursor: pointer; transition: all .2s; border: none; }
  .alert-btn-dismiss { background: rgba(87,125,196,.2); color: var(--text-secondary, #8ab0c9); }
  .alert-btn-acknowledge { background: rgba(0,212,255,.2); color: var(--accent-primary, #00d4ff); }
  .alert-btn:hover { filter: brightness(1.2); }
  .empty-alerts { text-align: center; padding: 4rem; background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; }
  .empty-alerts h2 { color: var(--text-primary, #dff7ff); margin-bottom: 1rem; }
  .empty-alerts p { color: var(--text-secondary, #8ab0c9); }
`;

export default function Alerts() {
  const [alerts, setAlerts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAlerts();
  }, []);

  const fetchAlerts = async () => {
    try {
      const res = await api.get('/incidents');
      const allIncidents = res.data.incidents || [];
      // Convert incidents to alerts format
      const normalizeSeverity = (sev) => {
        const s = String(sev || 'info').toLowerCase();
        if (s === 'alert' || s === 'critical') return 'critical';
        if (s === 'warning' || s === 'high') return 'warning';
        return 'info';
      };
      const formattedAlerts = allIncidents.map(inc => ({
        id: inc.id,
        // The status-update endpoint is keyed by event_id (an integer FK
        // into events), not the incident's own UUID — keep both so actions
        // call the right one.
        event_id: inc.event_id,
        title: inc.source || 'Alert',
        message: inc.subtitle || inc.source || 'Security alert detected',
        severity: normalizeSeverity(inc.severity),
        time: inc.timestamp || inc.created_at,
        camera: inc.camera_id,
        // API returns 'New', 'Acknowledged', 'In Progress', 'Resolved', ...
        acknowledged: String(inc.status || '').toLowerCase() !== 'new'
      }));
      setAlerts(formattedAlerts);
    } catch (err) {
      console.error('Failed to fetch alerts:', err);
    } finally {
      setLoading(false);
    }
  };

  const acknowledgeAlert = async (id) => {
    try {
      // Find the incident ID from the alert
      const alert = alerts.find(a => a.id === id);
      if (!alert) return;

      // Call the incidents API to update status (keyed by event_id, not id)
      await api.patch(`/incidents/${alert.event_id}/status`, { status: 'Acknowledged' });
      
      setAlerts(alerts.map(a => a.id === id ? { ...a, acknowledged: true } : a));
    } catch (err) {
      console.error('Failed to acknowledge alert:', err);
    }
  };

  const dismissAlert = async (id) => {
    try {
      const alert = alerts.find(a => a.id === id);
      if (!alert) return;

      // Mark as resolved via incidents API (keyed by event_id, not id)
      await api.patch(`/incidents/${alert.event_id}/status`, { status: 'Resolved' });
      
      setAlerts(alerts.filter(a => a.id !== id));
    } catch (err) {
      console.error('Failed to dismiss alert:', err);
    }
  };

  const getIcon = (severity) => {
    const icons = { critical: '🚨', warning: '⚠️', info: 'ℹ️' };
    return icons[severity] || icons.info;
  };

  const stats = {
    critical: alerts.filter(a => a.severity === 'critical' && !a.acknowledged).length,
    warning: alerts.filter(a => a.severity === 'warning' && !a.acknowledged).length,
    info: alerts.filter(a => a.severity === 'info' && !a.acknowledged).length
  };

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="alerts-page">
        <div className="alerts-header">
          <h1 className="alerts-title">🚨 Alerts & Notifications</h1>
          <div className="alert-stats">
            <span className="stat-badge stat-critical">{stats.critical} Critical</span>
            <span className="stat-badge stat-warning">{stats.warning} Warning</span>
            <span className="stat-badge stat-info">{stats.info} Info</span>
          </div>
        </div>

        {loading ? (
          <div className="empty-alerts"><p>Loading alerts...</p></div>
        ) : alerts.length === 0 ? (
          <div className="empty-alerts">
            <h2>No Active Alerts</h2>
            <p>All systems operating normally. Alerts will appear here when issues are detected.</p>
          </div>
        ) : (
          <div className="alerts-list">
            {alerts.map(alert => (
              <div key={alert.id} className="alert-card">
                <div className={`alert-icon alert-${alert.severity}`}>
                  {getIcon(alert.severity)}
                </div>
                <div className="alert-content">
                  <h3>{alert.title}</h3>
                  <p>{alert.message}</p>
                  <div className="alert-meta">
                    <span>🕐 {alert.time ? new Date(alert.time).toLocaleString() : 'Unknown'}</span>
                    {alert.camera && <span>📷 {alert.camera}</span>}
                    {alert.acknowledged && <span style={{ color: 'var(--accent-success, #00d450)' }}>✓ Acknowledged</span>}
                  </div>
                </div>
                <div className="alert-actions">
                  {!alert.acknowledged && (
                    <button className="alert-btn alert-btn-acknowledge" onClick={() => acknowledgeAlert(alert.id)}>
                      Acknowledge
                    </button>
                  )}
                  <button className="alert-btn alert-btn-dismiss" onClick={() => dismissAlert(alert.id)}>
                    Dismiss
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </main>
    </>
  );
}
