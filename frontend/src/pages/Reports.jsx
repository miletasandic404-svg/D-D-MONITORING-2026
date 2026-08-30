import React, { useState, useEffect } from 'react';
import api from '../services/api';
import BackToDashboard from '../components/BackToDashboard';

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
  .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(120px, 1fr)); gap: 1rem; }
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
  .status-acknowledged { background: rgba(255,180,50,.2); color: var(--accent-warning, #ffb432); }
  .status-in_progress { background: rgba(0,212,255,.2); color: var(--accent-primary, #00d4ff); }
  .status-resolved { background: rgba(0,212,80,.2); color: var(--accent-success, #00d450); }
  .status-false_alarm { background: rgba(150,150,150,.2); color: var(--text-secondary, #8ab0c9); }
  .empty-state { text-align: center; padding: 2rem; color: var(--text-secondary, #8ab0c9); }
  .date-range { color: var(--text-muted, #6a8aaa); font-size: .85rem; margin-bottom: 1rem; }
  .camera-breakdown { margin-top: 1rem; }
  .camera-row { display: flex; justify-content: space-between; padding: .5rem 0; border-bottom: 1px solid rgba(87,125,196,.12); }
  .camera-row:last-child { border-bottom: none; }
`;

export default function Reports() {
  const [reportType, setReportType] = useState('daily');
  const [reportData, setReportData] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchReport();
  }, [reportType]);

  const fetchReport = async () => {
    setLoading(true);
    try {
      const res = await api.get('/reports/summary', { params: { type: reportType } });
      setReportData(res.data);
    } catch (err) {
      console.error('Failed to fetch report:', err);
      setReportData(null);
    } finally {
      setLoading(false);
    }
  };

  const generateReport = () => {
    if (!reportData) return;

    const blob = new Blob([JSON.stringify(reportData, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `security-report-${reportType}-${Date.now()}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const reportTypes = [
    { id: 'daily', icon: '📅', title: 'Daily Report', desc: 'Last 24 hours' },
    { id: 'weekly', icon: '📊', title: 'Weekly Report', desc: 'Last 7 days' },
    { id: 'monthly', icon: '📈', title: 'Monthly Report', desc: 'Last 30 days' },
  ];

  const summary = reportData?.summary || {
    total_incidents: 0,
    by_status: {},
    by_severity: {},
    by_camera: [],
    avg_resolution_time_minutes: null,
  };

  const getStatusClass = (status) => {
    const classes = {
      'New': 'status-new',
      'Acknowledged': 'status-acknowledged',
      'In Progress': 'status-in_progress',
      'Resolved': 'status-resolved',
      'False Alarm': 'status-false_alarm',
    };
    return classes[status] || 'status-new';
  };

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="reports-page">
        <BackToDashboard />
        <div className="reports-header">
          <h1 className="reports-title">Security Reports</h1>
          <button className="generate-btn" onClick={generateReport} disabled={!reportData}>
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

        {reportData?.date_range && (
          <div className="date-range">
            Period: {reportData.date_range.from} to {reportData.date_range.to}
          </div>
        )}

        <div className="report-content">
          <div className="report-section">
            <h2>Incident Summary</h2>
            <div className="stat-grid">
              <div className="stat-card">
                <div className="stat-value">{summary.total_incidents}</div>
                <div className="stat-label">Total Incidents</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{summary.by_status['New'] || 0}</div>
                <div className="stat-label">New</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{summary.by_status['In Progress'] || 0}</div>
                <div className="stat-label">In Progress</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{summary.by_status['Resolved'] || 0}</div>
                <div className="stat-label">Resolved</div>
              </div>
              <div className="stat-card">
                <div className="stat-value">{summary.avg_resolution_time_minutes ?? '—'}</div>
                <div className="stat-label">Avg Resolution (min)</div>
              </div>
            </div>
          </div>

          {summary.by_severity && Object.keys(summary.by_severity).length > 0 && (
            <div className="report-section">
              <h2>By Severity</h2>
              <div className="stat-grid">
                {Object.entries(summary.by_severity).map(([severity, count]) => (
                  <div key={severity} className="stat-card">
                    <div className="stat-value">{count}</div>
                    <div className="stat-label">{severity}</div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {summary.by_camera && summary.by_camera.length > 0 && (
            <div className="report-section">
              <h2>Top Cameras</h2>
              <div className="camera-breakdown">
                {summary.by_camera.map(cam => (
                  <div key={cam.camera_id} className="camera-row">
                    <span>{cam.camera_name || cam.camera_id}</span>
                    <span style={{ color: 'var(--accent-primary, #00d4ff)', fontWeight: 'bold' }}>{cam.count}</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          <div className="report-section">
            <h2>Recent Incidents</h2>
            {loading ? (
              <div className="empty-state">Loading...</div>
            ) : !reportData?.incidents || reportData.incidents.length === 0 ? (
              <div className="empty-state">No incidents in this period.</div>
            ) : (
              <div className="incidents-list">
                {reportData.incidents.slice(0, 10).map(incident => (
                  <div key={incident.id} className="incident-row">
                    <div>
                      <div className="incident-title">{incident.description || 'Incident'}</div>
                      <div className="incident-time">
                        {incident.camera_name && <span>📷 {incident.camera_name} • </span>}
                        {incident.created_at ? new Date(incident.created_at).toLocaleString() : 'Unknown time'}
                      </div>
                    </div>
                    <span className={`incident-status ${getStatusClass(incident.status)}`}>
                      {incident.status || 'New'}
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
