import api from '../services/api';
import React, { useState, useEffect } from 'react';
import BackToDashboard from '../components/BackToDashboard';

const PAGE_CSS = `
  .emergency-page { padding: 2rem; color: var(--text-primary, #e5eef7); }
  .emergency-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
  .emergency-title { font-family: 'Orbitron', sans-serif; font-size: 1.5rem; color: var(--text-primary, #dff5ff); }
  .emergency-alert { background: rgba(255,80,80,.15); border: 2px solid rgba(255,80,80,.4); border-radius: 16px; padding: 1.5rem; margin-bottom: 2rem; display: flex; align-items: center; gap: 1rem; }
  .emergency-alert-icon { font-size: 2rem; }
  .emergency-alert-text h2 { color: var(--accent-danger, #ff5050); margin-bottom: .25rem; }
  .emergency-alert-text p { color: var(--text-primary, #dff7ff); font-size: .9rem; }
  .contacts-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(300px, 1fr)); gap: 1.5rem; margin-bottom: 2rem; }
  .contact-card { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; padding: 1.5rem; }
  .contact-card h2 { color: #8ee8ff; font-size: .9rem; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 1rem; display: flex; align-items: center; gap: .5rem; }
  .contact-row { display: flex; justify-content: space-between; align-items: center; padding: .75rem 0; border-bottom: 1px solid rgba(87,125,196,.12); }
  .contact-row:last-child { border-bottom: none; }
  .contact-name { color: var(--text-primary, #dff7ff); }
  .contact-phone { font-family: monospace; color: var(--accent-primary, #00d4ff); font-size: .9rem; }
  .contact-btn { background: linear-gradient(135deg,var(--accent-primary, #00d4ff),var(--accent-secondary, #8c4dff)); border: none; color: #03101c; padding: .5rem 1rem; border-radius: 8px; font-size: .85rem; cursor: pointer; font-weight: bold; }
  .contact-btn:hover { filter: brightness(1.1); }
  .dispatch-form { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; padding: 2rem; }
  .dispatch-form h2 { color: #8ee8ff; font-size: .9rem; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 1.5rem; }
  .form-group { margin-bottom: 1rem; }
  .form-label { display: block; color: var(--text-secondary, #8ab0c9); font-size: .85rem; margin-bottom: .5rem; }
  .form-input, .form-textarea, .form-select { width: 100%; padding: .8rem; background: rgba(87,125,196,.1); border: 1px solid rgba(87,125,196,.3); border-radius: 8px; color: var(--text-primary, #dff7ff); font-size: .9rem; }
  .form-textarea { min-height: 100px; resize: vertical; }
  .dispatch-actions { display: flex; gap: 1rem; margin-top: 1.5rem; }
  .dispatch-btn { flex: 1; padding: 1rem; border: none; border-radius: 12px; font-size: .9rem; font-weight: bold; cursor: pointer; transition: all .2s; }
  .dispatch-btn-primary { background: linear-gradient(135deg,var(--accent-danger, #ff5050),#ff8040); color: white; }
  .dispatch-btn-secondary { background: rgba(87,125,196,.2); color: var(--text-secondary, #8ab0c9); border: 1px solid rgba(87,125,196,.3); }
  .dispatch-btn:hover { filter: brightness(1.1); transform: translateY(-2px); }
  .dispatch-btn:disabled { opacity: .5; cursor: not-allowed; transform: none; }
  .recent-dispatches { margin-top: 2rem; }
  .dispatch-list { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; overflow: hidden; }
  .dispatch-list-header { padding: 1rem; border-bottom: 1px solid rgba(87,125,196,.18); }
  .dispatch-list-header h3 { color: #8ee8ff; font-size: .9rem; text-transform: uppercase; letter-spacing: .1em; }
  .dispatch-row { display: flex; justify-content: space-between; align-items: center; padding: 1rem; border-bottom: 1px solid rgba(87,125,196,.12); }
  .dispatch-row:last-child { border-bottom: none; }
  .dispatch-info h4 { color: var(--text-primary, #dff7ff); margin-bottom: .25rem; }
  .dispatch-info p { color: var(--text-secondary, #8ab0c9); font-size: .8rem; }
  .dispatch-status { padding: .25rem .75rem; border-radius: 10px; font-size: .75rem; font-weight: bold; }
  .dispatch-status.pending { background: rgba(255,180,50,.2); color: var(--accent-warning, #ffb432); }
  .dispatch-status.sent { background: rgba(0,212,80,.2); color: var(--accent-success, #00d450); }
  .dispatch-time { color: var(--text-muted, #6a8aaa); font-size: .75rem; }
  .success-message { background: rgba(0,212,80,.15); border: 1px solid rgba(0,212,80,.3); border-radius: 12px; padding: 1rem; color: var(--accent-success, #00d450); text-align: center; margin-top: 1rem; }
`;

export default function EmergencyDispatch() {
  const [formData, setFormData] = useState({
    incidentType: '',
    location: '',
    description: '',
    priority: 'high'
  });
  const [sending, setSending] = useState(false);
  const [success, setSuccess] = useState(false);
  const [dispatches, setDispatches] = useState([]);
  const [loading, setLoading] = useState(true);
  const [contacts, setContacts] = useState([]);
  const [contactsLoading, setContactsLoading] = useState(true);

  useEffect(() => {
    fetchDispatches();
    fetchContacts();
  }, []);

  const fetchDispatches = async () => {
    try {
      const res = await api.get('/emergency/dispatch');
      setDispatches(res.data.dispatches || []);
    } catch (err) {
      console.error('Failed to fetch dispatches:', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchContacts = async () => {
    try {
      const res = await api.get('/settings');
      const raw = res.data?.settings?.emergency_contacts || {};
      const iconMap = { police: '👮', fire: '🚒', ambulance: '🚑', security: '🛡️' };
      const enabledContacts = Object.entries(raw)
        .filter(([, v]) => v && v.enabled && v.phone)
        .map(([key, v]) => ({
          key,
          name: v.name || key,
          phone: v.phone,
          icon: iconMap[key] || '📞',
        }));
      setContacts(enabledContacts);
    } catch (err) {
      console.error('Failed to fetch emergency contacts:', err);
    } finally {
      setContactsLoading(false);
    }
  };

  const handleSubmit = async (e) => {
    e.preventDefault();
    setSending(true);

    try {
      await api.post('/emergency/dispatch', {
        incident_type: formData.incidentType,
        location: formData.location,
        description: formData.description,
        priority: formData.priority
      });

      setSuccess(true);
      setFormData({ incidentType: '', location: '', description: '', priority: 'high' });
      fetchDispatches();
      setTimeout(() => setSuccess(false), 3000);
    } catch (err) {
      console.error('Failed to create dispatch:', err);
      alert(err?.response?.data?.error || 'Failed to send dispatch');
    } finally {
      setSending(false);
    }
  };

  const callContact = (phone) => {
    window.open(`tel:${phone}`, '_self');
  };

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="emergency-page">
        <BackToDashboard />
        <div className="emergency-header">
          <h1 className="emergency-title">🚨 Emergency Dispatch Center</h1>
        </div>

        <div className="emergency-alert">
          <span className="emergency-alert-icon">⚠️</span>
          <div className="emergency-alert-text">
            <h2>In Case of Emergency</h2>
            <p>Use this panel to quickly dispatch emergency services. For immediate threats, call your configured emergency contacts directly.</p>
          </div>
        </div>

        <div className="contacts-grid">
          {contactsLoading ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary, #8ab0c9)' }}>
              Loading emergency contacts...
            </div>
          ) : contacts.length === 0 ? (
            <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary, #8ab0c9)' }}>
              Emergency contacts are not configured. Please configure them in Settings.
            </div>
          ) : (
            contacts.map((contact) => (
              <div key={contact.key} className="contact-card">
                <h2>{contact.icon} {contact.name}</h2>
                <div className="contact-row">
                  <div>
                    <div className="contact-name">{contact.name}</div>
                    <div className="contact-phone">{contact.phone}</div>
                  </div>
                  <button className="contact-btn" onClick={() => callContact(contact.phone)}>
                    📞 Call
                  </button>
                </div>
              </div>
            ))
          )}
        </div>

        <div className="dispatch-form">
          <h2>📋 Emergency Dispatch Request</h2>
          <form onSubmit={handleSubmit}>
            <div className="form-group">
              <label className="form-label">Incident Type *</label>
              <select 
                className="form-select"
                value={formData.incidentType}
                onChange={(e) => setFormData({...formData, incidentType: e.target.value})}
                required
              >
                <option value="">Select incident type...</option>
                <option value="medical">Medical Emergency</option>
                <option value="fire">Fire Emergency</option>
                <option value="security">Security Threat</option>
                <option value="intrusion">Intrusion Detected</option>
                <option value="suspicious">Suspicious Activity</option>
                <option value="other">Other Emergency</option>
              </select>
            </div>

            <div className="form-group">
              <label className="form-label">Location *</label>
              <input 
                type="text"
                className="form-input"
                placeholder="Building, floor, room, or specific location..."
                value={formData.location}
                onChange={(e) => setFormData({...formData, location: e.target.value})}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Description *</label>
              <textarea 
                className="form-textarea"
                placeholder="Describe the emergency situation, number of people involved, visible threats..."
                value={formData.description}
                onChange={(e) => setFormData({...formData, description: e.target.value})}
                required
              />
            </div>

            <div className="form-group">
              <label className="form-label">Priority Level</label>
              <select 
                className="form-select"
                value={formData.priority}
                onChange={(e) => setFormData({...formData, priority: e.target.value})}
              >
                <option value="critical">🔴 CRITICAL - Immediate threat to life</option>
                <option value="high">🟠 HIGH - Urgent response needed</option>
                <option value="medium">🟡 MEDIUM - Response within 30 mins</option>
                <option value="low">🟢 LOW - Non-urgent, standard response</option>
              </select>
            </div>

            <div className="dispatch-actions">
              <button 
                type="submit" 
                className="dispatch-btn dispatch-btn-primary"
                disabled={sending || !formData.incidentType || !formData.location}
              >
                {sending ? '🚨 Sending Dispatch...' : '🚨 Send Emergency Dispatch'}
              </button>
              <button 
                type="button" 
                className="dispatch-btn dispatch-btn-secondary"
                onClick={() => setFormData({ incidentType: '', location: '', description: '', priority: 'high' })}
              >
                Clear Form
              </button>
            </div>

            {success && (
              <div className="success-message">
                ✓ Emergency dispatch request sent successfully!
              </div>
            )}
          </form>
        </div>

        <div className="recent-dispatches">
          <div className="dispatch-list">
            <div className="dispatch-list-header">
              <h3>Recent Dispatch Requests</h3>
            </div>
            {loading ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary, #8ab0c9)' }}>
                Loading dispatches...
              </div>
            ) : dispatches.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-secondary, #8ab0c9)' }}>
                No dispatch requests yet.
              </div>
            ) : (
              dispatches.map(dispatch => (
                <div key={dispatch.id} className="dispatch-row">
                  <div className="dispatch-info">
                    <h4>{dispatch.incident_type}</h4>
                    <p>{dispatch.location || 'No location'}</p>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    <span className={`dispatch-status ${dispatch.status === 'pending' ? 'pending' : 'sent'}`}>
                      {dispatch.status === 'pending' ? '⏳ Pending' : '✓ ' + dispatch.status.charAt(0).toUpperCase() + dispatch.status.slice(1)}
                    </span>
                    <span className="dispatch-time">
                      {dispatch.created_at ? new Date(dispatch.created_at).toLocaleString() : ''}
                    </span>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      </main>
    </>
  );
}
