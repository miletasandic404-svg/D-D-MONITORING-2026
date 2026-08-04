import React, { useState, useEffect } from 'react';
import api from '../services/api';

const PAGE_CSS = `
  .incidents-page { padding: 2rem; color: var(--text-primary, #e5eef7); }
  .incidents-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
  .incidents-title { font-family: 'Orbitron', sans-serif; font-size: 1.5rem; color: var(--text-primary, #dff5ff); }
  .incidents-filters { display: flex; gap: .75rem; flex-wrap: wrap; margin-bottom: 1.5rem; }
  .filter-select { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); color: var(--text-secondary, #8ab0c9); padding: .6rem 1rem; border-radius: 8px; font-size: .85rem; min-width: 150px; }
  .incidents-table { width: 100%; border-collapse: collapse; }
  .incidents-table th { text-align: left; padding: 1rem; color: #8ee8ff; font-size: .8rem; text-transform: uppercase; letter-spacing: .05em; border-bottom: 1px solid rgba(87,125,196,.18); }
  .incidents-table td { padding: 1rem; border-bottom: 1px solid rgba(87,125,196,.12); }
  .incidents-table tr:hover { background: rgba(0,212,255,.05); }
  .incident-id { font-family: monospace; color: var(--accent-primary, #00d4ff); font-size: .85rem; }
  .incident-title { color: var(--text-primary, #dff7ff); margin-bottom: .2rem; }
  .incident-desc { color: var(--text-secondary, #8ab0c9); font-size: .8rem; }
  .incident-time { color: var(--text-muted, #6a8aaa); font-size: .8rem; }
  .status-badge { display: inline-block; padding: .25rem .6rem; border-radius: 10px; font-size: .75rem; font-weight: bold; text-transform: uppercase; }
  .status-new { background: rgba(255,80,80,.2); color: var(--accent-danger, #ff5050); }
  .status-active { background: rgba(255,180,50,.2); color: var(--accent-warning, #ffb432); }
  .status-investigating { background: rgba(140,77,255,.2); color: #c580ff; }
  .status-resolved { background: rgba(0,212,80,.2); color: var(--accent-success, #00d450); }
  .incident-actions { display: flex; gap: .5rem; }
  .action-btn { padding: .4rem .8rem; border-radius: 6px; font-size: .75rem; cursor: pointer; border: none; transition: all .2s; }
  .action-btn-view { background: rgba(0,212,255,.2); color: var(--accent-primary, #00d4ff); }
  .action-btn-edit { background: rgba(87,125,196,.2); color: var(--text-secondary, #8ab0c9); }
  .action-btn:hover { filter: brightness(1.2); }
  .empty-incidents { text-align: center; padding: 4rem; background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; }
  .empty-incidents h2 { color: var(--text-primary, #dff7ff); margin-bottom: 1rem; }
  .empty-incidents p { color: var(--text-secondary, #8ab0c9); }
  .severity-indicator { width: 4px; height: 40px; border-radius: 2px; }
  .sev-critical { background: var(--accent-danger, #ff5050); }
  .sev-high { background: var(--accent-warning, #ffb432); }
  .sev-medium { background: var(--accent-primary, #00d4ff); }
  .sev-low { background: var(--accent-success, #00d450); }
`;

export default function Incidents() {
  const [incidents, setIncidents] = useState([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState('all');

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

  const filteredIncidents = statusFilter === 'all' 
    ? incidents 
    : incidents.filter(i => String(i.status || '').toLowerCase() === statusFilter.toLowerCase());

  const getStatusClass = (status) => {
    const classes = {
      'new': 'status-new',
      'acknowledged': 'status-active',
      'in progress': 'status-investigating',
      'resolved': 'status-resolved',
      'false alarm': 'status-resolved'
    };
    return classes[String(status || '').toLowerCase()] || 'status-new';
  };

  const getSeverityClass = (severity) => {
    const classes = {
      'critical': 'sev-critical',
      'high': 'sev-high',
      'medium': 'sev-medium',
      'low': 'sev-low'
    };
    return classes[severity] || 'sev-medium';
  };

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="incidents-page">
        <div className="incidents-header">
          <h1 className="incidents-title">📋 Incident Management</h1>
          <span style={{ color: 'var(--text-secondary, #8ab0c9)', fontSize: '.9rem' }}>
            {filteredIncidents.length} incidents
          </span>
        </div>

        <div className="incidents-filters">
          <select className="filter-select" value={statusFilter} onChange={(e) => setStatusFilter(e.target.value)}>
            <option value="all">All Status</option>
            <option value="new">New</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="in progress">In Progress</option>
            <option value="resolved">Resolved</option>
            <option value="false alarm">False Alarm</option>
          </select>
        </div>

        {loading ? (
          <div className="empty-incidents"><p>Loading incidents...</p></div>
        ) : filteredIncidents.length === 0 ? (
          <div className="empty-incidents">
            <h2>No Incidents Found</h2>
            <p>No incidents match your current filters.</p>
          </div>
        ) : (
          <table className="incidents-table">
            <thead>
              <tr>
                <th></th>
                <th>ID</th>
                <th>Incident</th>
                <th>Status</th>
                <th>Time</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filteredIncidents.map(incident => (
                <tr key={incident.id}>
                  <td>
                    <div className={`severity-indicator ${getSeverityClass(incident.severity)}`} />
                  </td>
                  <td className="incident-id">#{incident.id?.slice(0, 8) || '00000000'}</td>
                  <td>
                    <div className="incident-title">{incident.source || 'Untitled Incident'}</div>
                    <div className="incident-desc">{incident.subtitle || incident.camera_id || 'No description'}</div>
                  </td>
                  <td>
                    <span className={`status-badge ${getStatusClass(incident.status)}`}>
                      {incident.status || 'new'}
                    </span>
                  </td>
                  <td className="incident-time">
                    {incident.created_at ? new Date(incident.created_at).toLocaleString() : 'Unknown'}
                  </td>
                  <td>
                    <div className="incident-actions">
                      <button className="action-btn action-btn-view">View</button>
                      <button className="action-btn action-btn-edit">Edit</button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </main>
    </>
  );
}
