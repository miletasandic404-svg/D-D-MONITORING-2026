import React, { useState, useEffect } from 'react';
import api from '../services/api';

const PAGE_CSS = `
  .ai-page { padding: 2rem; color: var(--text-primary, #e5eef7); }
  .ai-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
  .ai-title { font-family: 'Orbitron', sans-serif; font-size: 1.5rem; color: var(--text-primary, #dff5ff); }
  .ai-status { display: flex; align-items: center; gap: .5rem; padding: .5rem 1rem; background: rgba(0,212,80,.15); border: 1px solid rgba(0,212,80,.3); border-radius: 20px; }
  .status-indicator { width: 10px; height: 10px; border-radius: 50%; background: var(--accent-success, #00d450); animation: blink 1s infinite; }
  @keyframes blink { 0%, 100% { opacity: 1; } 50% { opacity: .5; } }
  .ai-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .ai-card { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; padding: 1.5rem; text-align: center; }
  .ai-card-icon { font-size: 2rem; margin-bottom: 1rem; }
  .ai-card-value { font-size: 2rem; font-weight: bold; color: var(--accent-primary, #00d4ff); }
  .ai-card-label { color: var(--text-secondary, #8ab0c9); font-size: .85rem; margin-top: .25rem; }
  .detections-section { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; padding: 1.5rem; }
  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1.5rem; }
  .section-title { color: #8ee8ff; font-size: .9rem; text-transform: uppercase; letter-spacing: .1em; }
  .filter-btn { background: rgba(87,125,196,.2); border: 1px solid rgba(87,125,196,.3); color: var(--text-secondary, #8ab0c9); padding: .5rem 1rem; border-radius: 8px; font-size: .8rem; cursor: pointer; }
  .filter-btn.active { background: rgba(0,212,255,.2); border-color: var(--accent-primary, #00d4ff); color: var(--accent-primary, #00d4ff); }
  .object-types { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: 1.5rem; }
  .object-type { padding: .5rem 1rem; background: rgba(87,125,196,.15); border: 1px solid rgba(87,125,196,.25); border-radius: 20px; font-size: .85rem; color: var(--text-secondary, #8ab0c9); }
  .detection-feed { max-height: 400px; overflow-y: auto; }
  .detection-item { display: flex; gap: 1rem; padding: 1rem; border-bottom: 1px solid rgba(87,125,196,.12); transition: background .2s; }
  .detection-item:hover { background: rgba(0,212,255,.05); }
  .detection-item:last-child { border-bottom: none; }
  .detection-icon { width: 50px; height: 50px; border-radius: 10px; background: rgba(0,212,255,.1); display: flex; align-items: center; justify-content: center; font-size: 1.5rem; }
  .detection-info { flex: 1; }
  .detection-info h3 { color: var(--text-primary, #dff7ff); margin-bottom: .25rem; }
  .detection-meta { display: flex; gap: 1rem; color: var(--text-secondary, #8ab0c9); font-size: .8rem; }
  .confidence-bar { width: 100px; height: 6px; background: rgba(87,125,196,.3); border-radius: 3px; overflow: hidden; }
  .confidence-fill { height: 100%; background: linear-gradient(90deg,var(--accent-success, #00d450),var(--accent-primary, #00d4ff)); border-radius: 3px; }
  .empty-detections { text-align: center; padding: 3rem; color: var(--text-secondary, #8ab0c9); }
  .empty-detections h2 { color: var(--text-primary, #dff7ff); margin-bottom: .5rem; }
`;

const OBJECT_TYPES = ['All', 'Person', 'Vehicle', 'Animal', 'Baggage', 'Weapon', 'Face'];

export default function AIDetection() {
  const [detections, setDetections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [filter, setFilter] = useState('All');

  useEffect(() => {
    fetchDetections();
    // Poll for new detections every 30 seconds
    const interval = setInterval(fetchDetections, 30000);
    return () => clearInterval(interval);
  }, []);

  const fetchDetections = async () => {
    try {
      const res = await api.get('/ai-detections');
      setDetections(res.data.detections || []);
    } catch (err) {
      console.error('Failed to fetch detections:', err);
    } finally {
      setLoading(false);
    }
  };

  const filteredDetections = filter === 'All' 
    ? detections 
    : detections.filter(d => d.object_type?.toLowerCase() === filter.toLowerCase());

  const stats = {
    total: detections.length,
    today: detections.filter(d => {
      if (!d.created_at) return false;
      const today = new Date().toDateString();
      return new Date(d.created_at).toDateString() === today;
    }).length,
    confidence: detections.length > 0 
      ? Math.round(detections.reduce((sum, d) => sum + (d.confidence || 0), 0) / detections.length * 100)
      : 0,
    cameras: new Set(detections.map(d => d.camera_id)).size
  };

  const getIcon = (type) => {
    const icons = {
      person: '👤',
      vehicle: '🚗',
      animal: '🐕',
      baggage: '🧳',
      weapon: '⚠️',
      face: '👁️'
    };
    return icons[type?.toLowerCase()] || '🔍';
  };

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="ai-page">
        <div className="ai-header">
          <h1 className="ai-title">🤖 AI Detection Engine</h1>
          <div className="ai-status">
            <span className="status-indicator" />
            <span style={{ color: 'var(--accent-success, #00d450)', fontSize: '.85rem' }}>Active</span>
          </div>
        </div>

        <div className="ai-grid">
          <div className="ai-card">
            <div className="ai-card-icon">🎯</div>
            <div className="ai-card-value">{stats.total}</div>
            <div className="ai-card-label">Total Detections</div>
          </div>
          <div className="ai-card">
            <div className="ai-card-icon">📅</div>
            <div className="ai-card-value">{stats.today}</div>
            <div className="ai-card-label">Today</div>
          </div>
          <div className="ai-card">
            <div className="ai-card-icon">📊</div>
            <div className="ai-card-value">{stats.confidence}%</div>
            <div className="ai-card-label">Avg Confidence</div>
          </div>
          <div className="ai-card">
            <div className="ai-card-icon">📷</div>
            <div className="ai-card-value">{stats.cameras}</div>
            <div className="ai-card-label">Active Cameras</div>
          </div>
        </div>

        <div className="detections-section">
          <div className="section-header">
            <h2 className="section-title">Detection Feed</h2>
            <button className="filter-btn" onClick={fetchDetections}>
              🔄 Refresh
            </button>
          </div>

          <div className="object-types">
            {OBJECT_TYPES.map(type => (
              <button
                key={type}
                className={`filter-btn ${filter === type ? 'active' : ''}`}
                onClick={() => setFilter(type)}
              >
                {type}
              </button>
            ))}
          </div>

          {loading ? (
            <div className="empty-detections">Loading detections...</div>
          ) : filteredDetections.length === 0 ? (
            <div className="empty-detections">
              <h2>No Detections Yet</h2>
              <p>AI detection results will appear here when cameras detect objects.</p>
            </div>
          ) : (
            <div className="detection-feed">
              {filteredDetections.slice(0, 20).map(detection => (
                <div key={detection.id} className="detection-item">
                  <div className="detection-icon">
                    {getIcon(detection.object_type)}
                  </div>
                  <div className="detection-info">
                    <h3>{detection.object_type || 'Unknown Object'}</h3>
                    <div className="detection-meta">
                      <span>📷 {detection.camera_name || 'Unknown camera'}</span>
                      <span>📍 {detection.zone || 'Unknown zone'}</span>
                      <span>🕐 {detection.created_at ? new Date(detection.created_at).toLocaleTimeString() : 'Unknown'}</span>
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: '.5rem' }}>
                    <div style={{ color: 'var(--text-secondary, #8ab0c9)', fontSize: '.8rem' }}>
                      {Math.round((detection.confidence || 0) * 100)}%
                    </div>
                    <div className="confidence-bar">
                      <div 
                        className="confidence-fill" 
                        style={{ width: `${(detection.confidence || 0) * 100}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </main>
    </>
  );
}
