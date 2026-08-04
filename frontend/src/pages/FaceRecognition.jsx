import React, { useState, useEffect } from 'react';
import api from '../services/api';

const PAGE_CSS = `
  .face-page { padding: 2rem; color: var(--text-primary, #e5eef7); }
  .face-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
  .face-title { font-family: 'Orbitron', sans-serif; font-size: 1.5rem; color: var(--text-primary, #dff5ff); }
  .face-status { display: flex; align-items: center; gap: .5rem; padding: .5rem 1rem; background: rgba(0,212,80,.15); border: 1px solid rgba(0,212,80,.3); border-radius: 20px; }
  .face-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .face-stat { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 12px; padding: 1rem; text-align: center; }
  .face-stat-value { font-size: 2rem; font-weight: bold; color: var(--accent-primary, #00d4ff); }
  .face-stat-label { color: var(--text-secondary, #8ab0c9); font-size: .8rem; margin-top: .25rem; }
  .faces-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 1rem; }
  .face-card { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 12px; padding: 1rem; text-align: center; transition: all .2s; }
  .face-card:hover { border-color: rgba(0,212,255,.5); transform: translateY(-2px); }
  .face-avatar { width: 80px; height: 80px; border-radius: 50%; background: rgba(87,125,196,.2); margin: 0 auto 1rem; display: flex; align-items: center; justify-content: center; font-size: 2rem; }
  .face-card h3 { color: var(--text-primary, #dff7ff); margin-bottom: .5rem; }
  .face-card p { color: var(--text-secondary, #8ab0c9); font-size: .8rem; margin-bottom: .5rem; }
  .face-confidence { display: flex; align-items: center; gap: .5rem; justify-content: center; }
  .confidence-bar { width: 60px; height: 6px; background: rgba(87,125,196,.3); border-radius: 3px; overflow: hidden; }
  .confidence-fill { height: 100%; background: var(--accent-success, #00d450); border-radius: 3px; }
  .face-badge { display: inline-block; padding: .2rem .6rem; border-radius: 10px; font-size: .7rem; margin-top: .5rem; }
  .badge-known { background: rgba(0,212,80,.2); color: var(--accent-success, #00d450); }
  .badge-unknown { background: rgba(255,80,80,.2); color: var(--accent-danger, #ff5050); }
  .badge-suspicious { background: rgba(255,180,50,.2); color: var(--accent-warning, #ffb432); }
  .detections-list { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; margin-top: 2rem; }
  .detections-header { padding: 1rem; border-bottom: 1px solid rgba(87,125,196,.18); }
  .detections-header h3 { color: #8ee8ff; font-size: .9rem; text-transform: uppercase; letter-spacing: .1em; }
  .detection-row { display: flex; align-items: center; gap: 1rem; padding: 1rem; border-bottom: 1px solid rgba(87,125,196,.12); }
  .detection-row:last-child { border-bottom: none; }
  .detection-face { width: 40px; height: 40px; border-radius: 50%; background: rgba(87,125,196,.2); display: flex; align-items: center; justify-content: center; }
  .detection-info { flex: 1; }
  .detection-info h4 { color: var(--text-primary, #dff7ff); margin-bottom: .2rem; font-size: .9rem; }
  .detection-info p { color: var(--text-secondary, #8ab0c9); font-size: .8rem; }
  .detection-time { color: var(--text-muted, #6a8aaa); font-size: .75rem; }
  .empty-state { text-align: center; padding: 3rem; color: var(--text-secondary, #8ab0c9); }
`;

export default function FaceRecognition() {
  const [detections, setDetections] = useState([]);
  const [knownFaces, setKnownFaces] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchFaceData();
  }, []);

  const fetchFaceData = async () => {
    try {
      // /face-detections does not exist; use the real /ai-detections
      // endpoint and keep only face/person detections.
      const res = await api.get('/ai-detections');
      const all = res.data.detections || [];
      const faces = all.filter((d) => /face|person/i.test(d.object_type || ''));
      setDetections(faces.map((d) => ({
        id: d.id,
        name: d.object_type || 'Face',
        camera: d.camera_name || d.camera_id || 'Unknown camera',
        confidence: Number(d.confidence) || 0,
        status: 'unknown',
        timestamp: d.created_at,
      })));
      setKnownFaces([]);
    } catch (err) {
      console.error('Failed to fetch face data:', err);
      setDetections([]);
      setKnownFaces([]);
    } finally {
      setLoading(false);
    }
  };

  const stats = {
    total: detections.length,
    known: detections.filter(d => d.status === 'known').length,
    unknown: detections.filter(d => d.status === 'unknown').length,
    suspicious: detections.filter(d => d.status === 'suspicious').length
  };

  const getBadgeClass = (status) => {
    const classes = { known: 'badge-known', unknown: 'badge-unknown', suspicious: 'badge-suspicious' };
    return classes[status] || 'badge-unknown';
  };

  const getBadgeText = (status) => {
    const texts = { known: 'Known', unknown: 'Unknown', suspicious: '⚠️ Suspicious' };
    return texts[status] || 'Unknown';
  };

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="face-page">
        <div className="face-header">
          <h1 className="face-title">👤 Face Recognition</h1>
          <div className="face-status">
            <span style={{ width: '8px', height: '8px', borderRadius: '50%', background: 'var(--accent-success, #00d450)' }} />
            <span style={{ color: 'var(--accent-success, #00d450)', fontSize: '.85rem' }}>Active</span>
          </div>
        </div>

        <div className="face-stats">
          <div className="face-stat">
            <div className="face-stat-value">{stats.total}</div>
            <div className="face-stat-label">Total Detections</div>
          </div>
          <div className="face-stat">
            <div className="face-stat-value" style={{ color: 'var(--accent-success, #00d450)' }}>{stats.known}</div>
            <div className="face-stat-label">Known</div>
          </div>
          <div className="face-stat">
            <div className="face-stat-value" style={{ color: 'var(--accent-danger, #ff5050)' }}>{stats.unknown}</div>
            <div className="face-stat-label">Unknown</div>
          </div>
          <div className="face-stat">
            <div className="face-stat-value" style={{ color: 'var(--accent-warning, #ffb432)' }}>{stats.suspicious}</div>
            <div className="face-stat-label">Suspicious</div>
          </div>
        </div>

        <h2 style={{ color: '#8ee8ff', marginBottom: '1rem', fontSize: '.9rem', textTransform: 'uppercase', letterSpacing: '.1em' }}>
          Recent Detections
        </h2>

        {loading ? (
          <div className="empty-state">Loading...</div>
        ) : (
          <>
            <div className="faces-grid">
              {detections.slice(0, 8).map(det => (
                <div key={det.id} className="face-card">
                  <div className="face-avatar">👤</div>
                  <h3>{det.name}</h3>
                  <p>📷 {det.camera}</p>
                  <div className="face-confidence">
                    <span style={{ color: 'var(--text-secondary, #8ab0c9)', fontSize: '.8rem' }}>{(det.confidence * 100).toFixed(0)}%</span>
                    <div className="confidence-bar">
                      <div className="confidence-fill" style={{ width: `${det.confidence * 100}%` }} />
                    </div>
                  </div>
                  <span className={`face-badge ${getBadgeClass(det.status)}`}>
                    {getBadgeText(det.status)}
                  </span>
                </div>
              ))}
            </div>

            <div className="detections-list">
              <div className="detections-header">
                <h3>Detection Log</h3>
              </div>
              {detections.slice(0, 10).map(det => (
                <div key={det.id} className="detection-row">
                  <div className="detection-face">👤</div>
                  <div className="detection-info">
                    <h4>{det.name}</h4>
                    <p>{det.camera} • {getBadgeText(det.status)}</p>
                  </div>
                  <span className={`face-badge ${getBadgeClass(det.status)}`}>
                    {getBadgeText(det.status)}
                  </span>
                  <span className="detection-time">
                    {new Date(det.timestamp).toLocaleTimeString()}
                  </span>
                </div>
              ))}
            </div>
          </>
        )}
      </main>
    </>
  );
}
