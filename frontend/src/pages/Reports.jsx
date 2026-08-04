import React, { useState, useEffect } from 'react';
import api from '../services/api';

const PAGE_CSS = `
  .reports-page { padding: 2rem; color: var(--text-primary, #e5eef7); }
  .reports-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
  .reports-title { font-family: 'Orbitron', sans-serif; font-size: 1.5rem; color: var(--text-primary, #dff5ff); }
  .generate-btn { background: linear-gradient(135deg,var(--accent-primary, #00d4ff),var(--accent-secondary, #8c4dff)); color: #03101c; border: none; padding: .8rem 1.5rem; border-radius: 10px; font-family: 'Orbitron', sans-serif; font-size: .8rem; text-transform: uppercase; letter-spacing: .1em; cursor: pointer; }
  .report-types { display: grid; grid-template-columns: repeat(auto-fit, minmax(250px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .report-type { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; padding: 1.5rem; cursor: pointer; transition: all .2s; }
  .report-type:hover { border-color: rgba(0,212,255,.5); transform: translateY(-2px); }
  .report-type.selected { border-color: var(--accent-primary, #00d4ff); background: rgba(0,212,255,.1); }
  .report-icon { font-size: 2rem; margin-bottom: 1rem; }
  .report-type h2 { color: var(--text-primary, #dff7ff); margin-bottom: .5rem; }
  .report-type p { color: var(--text-secondary, #8ab0c9); font-size: .85rem; }
  .report-content { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; padding: 1.5rem; }
  .report-section { margin-bottom: 1.5rem; }
  .report-section:last-child { margin-bottom: 0; }
  .report-section h2 { color: #8ee8ff; font-size: .85rem; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 1rem; }
  .stat-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 1rem; }
  .stat-card { background: rgba(87,125,196,.1); border-radius: 12px; padding: 1rem; text-align: center; }
  .stat-value { font-size: 1.8rem; font-weight: bold; color: var(--accent-primary, #00d4ff); }
  .stat-label { color: var(--text-secondary, #8ab0c9); font-size: .8rem; margin-top: .25rem; }
  .incidents-list { max-height: 300px; overflow-y: auto; }
  .incident-row { display: flex; justify-content: space-between; padding: .75rem 0; border-bottom: 1px solid rgba(87,125,196,.12); }
  .incident-row:last-child { border-bottom: none; }
  .incident-time { color: var(--text-secondary, #8ab0c9); font-size: .85rem; }
  .incident-title { color: var(--text-primary, #dff7ff); }
  .incident-status { padding: .2rem .6rem; border-radius: 10px; font-size: .75rem; }
  .status-new { background: rgba(255,80,80,.2); color: var(--accent-danger, #ff5050); }
  .status-active { background: rgba(255,180,50,.2); color: var(--accent-warning, #ffb432); }
  .status-resolved { background: rgba(0,212,80,.2); color: var(--accent-success, #00d450); }
  .empty-state { text-align: center; padding: 2rem; color: var(--text-secondary, #8ab0c9); }
`;

export default function Reports() {
  const [reportType, setReportType] = useState('daily');
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchIncidents();
  }, []);

  const fetchIncidents = async () => {
    try {
      const res = await api.get('/incidents');
      setIncidents(res.data.incidents || []);
    } catch (err) {
      console.error('Failed to fetch incidents:', err);
    } finally {
      setLoading(false);
    }
  };

  const generateReport = () => {
    const reportData = {
      generated_at: new Date().toISOString(),
      report_type: reportType,
      total_incidents: incidents.length,
      incidents_by_status: {
        new: incidents.filter(i => i.status === 'new').length,
        active: incidents.filter(i => i.status === 'active').length,
        resolved: incidents.filter(i => i.status === 'resolved').length
      },
      incidents: incidents.slice(0, 10)
    };
    
    const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `security-report-${reportType}-${Date.now()}.json`;
    a.click();
  };

  const reportTypes = [
    { id: 'daily', icon: '📅', title: 'Daily Report', desc: '24-hour incident summary' },
    { id: 'weekly', icon: '📊', title: 'Weekly Report', desc: '7-day analytics overview' },
    { id: 'monthly', icon: '📈', title: 'Monthly Report', desc: '30-day trend analysis' },
    { id: 'custom', icon: '⚙️', title: 'Custom Report', desc: 'Select date range' }
  ];

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="reports-page">
        <div className="reports-header">
          <h1 className="reports-title">Security Reports</h1>
          <button className="generate-btn" onClick={generateReport}>
            Download Report
          </button>
        </div>

        <div className="report-types">
          {reportTypes.map(type => (
            <div 
              key={type.id}
              className={`report-type ${reportType === type.id ? 'selected' : ''}`}
              onClick={() => setReportType(type.id)}
            >
              <div className="report-icon">{type.icon}</div>
              <h2>{type.title}</h2>
              <p>{type.desc}</p>
            </div>
          ))}
        </div>

        <div className="report-content">
          <div className="report-section">
            <h2>Incident Summary</h2>
            <div className="stat-grid">
              <div className="stat-card">
                <div className="stat-value">{incidents.length}</div>
                <div className="stat-label">Total Incidents</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{incidents.filter(i => i.status === 'new').length}</div>
                <div className="stat-label">New</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{incidents.filter(i => i.status === 'active').length}</div>
                <div className="stat-label">Active</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{incidents.filter(i => i.status === 'resolved').length}</div>
                <div className="stat-label">Resolved</div>
              </div>
            </div>
          </div>

          <div className="report-section">
            <h2>Recent Incidents</h2>
            {loading ? (
              <div className="empty-state">Loading...</div>
            ) : incidents.length === 0 ? (
              <div className="empty-state">No incidents recorded.</div>
            ) : (
              <div className="incidents-list">
                {incidents.slice(0, 10).map(incident => (
                  <div key={incident.id} className="incident-row">
                    <div>
                      <div className="incident-title">{incident.title || 'Incident'}</div>
                      <div className="incident-time">
                        {incident.created_at ? new Date(incident.created_at).toLocaleString() : 'Unknown time'}
                      </div>
                    </div>
                    <span className={`incident-status status-${incident.status || 'new'}`}>
                      {incident.status || 'new'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
