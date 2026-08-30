import React, { useState, useEffect } from 'react';
import api from '../services/api';
import BackToDashboard from '../components/BackToDashboard';

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
  .face-avatar { width: 80px; height: 80px; border-radius: 50%; background: rgba(87,125,196,.2); margin: 0 auto 1rem; display: flex; align-items: center; justify-content: center; font-size: 2rem; overflow: hidden; }
  .face-avatar img { width: 100%; height: 100%; object-fit: cover; }
  .face-card h3 { color: var(--text-primary, #dff7ff); margin-bottom: .5rem; }
  .face-card p { color: var(--text-secondary, #8ab0c9); font-size: .8rem; margin-bottom: .5rem; }
  .face-confidence { display: flex; align-items: center; gap: .5rem; justify-content: center; }
  .confidence-bar { width: 60px; height: 6px; background: rgba(87,125,196,.3); border-radius: 3px; overflow: hidden; }
  .confidence-fill { height: 100%; background: var(--accent-success, #00d450); border-radius: 3px; }
  .face-badge { display: inline-block; padding: .2rem .6rem; border-radius: 10px; font-size: .7rem; margin-top: .5rem; }
  .badge-active { background: rgba(0,212,80,.2); color: var(--accent-success, #00d450); }
  .badge-unknown { background: rgba(255,80,80,.2); color: var(--accent-danger, #ff5050); }
  .badge-suspicious { background: rgba(255,180,50,.2); color: var(--accent-warning, #ffb432); }
  .badge-blocked { background: rgba(255,50,50,.3); color: var(--accent-danger, #ff5050); }
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
  .enroll-form { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 12px; padding: 1.5rem; margin-bottom: 2rem; }
  .enroll-form h3 { color: #8ee8ff; margin-bottom: 1rem; font-size: .9rem; text-transform: uppercase; letter-spacing: .1em; }
  .form-row { display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-end; }
  .form-group { display: flex; flex-direction: column; gap: .25rem; flex: 1; min-width: 150px; }
  .form-group label { color: var(--text-secondary, #8ab0c9); font-size: .8rem; }
  .form-group input, .form-group select { padding: .6rem; background: rgba(87,125,196,.1); border: 1px solid rgba(87,125,196,.3); border-radius: 8px; color: var(--text-primary, #dff7ff); font-size: .9rem; }
  .btn { padding: .6rem 1.2rem; border: none; border-radius: 8px; cursor: pointer; font-size: .85rem; font-weight: bold; }
  .btn-primary { background: var(--accent-primary, #00d4ff); color: #000; }
  .btn-danger { background: rgba(255,80,80,.2); color: var(--accent-danger, #ff5050); border: 1px solid rgba(255,80,80,.3); }
  .btn-secondary { background: rgba(87,125,196,.2); color: var(--text-secondary, #8ab0c9); border: 1px solid rgba(87,125,196,.3); }
  .btn-sm { padding: .3rem .6rem; font-size: .75rem; }
  .face-actions { display: flex; gap: .5rem; justify-content: center; margin-top: .5rem; }
  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .section-header h2 { color: #8ee8ff; font-size: .9rem; text-transform: uppercase; letter-spacing: .1em; margin: 0; }
`;

export default function FaceRecognition() {
  const [detections, setDetections] = useState([]);
  const [knownFaces, setKnownFaces] = useState([]);
  const [loading, setLoading] = useState(true);
  const [enrollName, setEnrollName] = useState('');
  const [enrollImageUrl, setEnrollImageUrl] = useState('');
  const [enrollStatus, setEnrollStatus] = useState('active');
  const [enrolling, setEnrolling] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editName, setEditName] = useState('');
  const [editStatus, setEditStatus] = useState('');

  useEffect(() => {
    fetchFaceData();
  }, []);

  const fetchFaceData = async () => {
    try {
      const [detRes, facesRes] = await Promise.all([
        api.get('/ai-detections'),
        api.get('/face-recognition'),
      ]);
      const all = detRes.data.detections || [];
      const faces = all.filter((d) => /face|person/i.test(d.object_type || ''));
      setDetections(faces.map((d) => ({
        id: d.id,
        name: d.object_type || 'Face',
        camera: d.camera_name || d.camera_id || 'Unknown camera',
        confidence: Number(d.confidence) || 0,
        status: 'unknown',
        timestamp: d.created_at,
      })));
      setKnownFaces(facesRes.data.known_faces || []);
    } catch (err) {
      console.error('Failed to fetch face data:', err);
      setDetections([]);
      setKnownFaces([]);
    } finally {
      setLoading(false);
    }
  };

  const handleEnroll = async (e) => {
    e.preventDefault();
    if (!enrollName.trim()) return;
    setEnrolling(true);
    try {
      await api.post('/face-recognition/enroll', {
        name: enrollName.trim(),
        image_url: enrollImageUrl.trim() || null,
        status: enrollStatus,
      });
      setEnrollName('');
      setEnrollImageUrl('');
      setEnrollStatus('active');
      await fetchFaceData();
    } catch (err) {
      console.error('Failed to enroll face:', err);
      alert(err?.response?.data?.error || 'Failed to enroll face');
    } finally {
      setEnrolling(false);
    }
  };

  const handleUpdate = async (id) => {
    try {
      const updates = {};
      if (editName.trim()) updates.name = editName.trim();
      if (editStatus) updates.status = editStatus;
      await api.put(`/face-recognition/${id}`, updates);
      setEditingId(null);
      setEditName('');
      setEditStatus('');
      await fetchFaceData();
    } catch (err) {
      console.error('Failed to update face:', err);
      alert(err?.response?.data?.error || 'Failed to update face');
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this known face?')) return;
    try {
      await api.delete(`/face-recognition/${id}`);
      await fetchFaceData();
    } catch (err) {
      console.error('Failed to delete face:', err);
      alert(err?.response?.data?.error || 'Failed to delete face');
    }
  };

  const startEdit = (face) => {
    setEditingId(face.id);
    setEditName(face.name);
    setEditStatus(face.status);
  };

  const stats = {
    total: knownFaces.length,
    active: knownFaces.filter(f => f.status === 'active').length,
    suspicious: knownFaces.filter(f => f.status === 'suspicious').length,
    blocked: knownFaces.filter(f => f.status === 'blocked').length,
  };

  const getBadgeClass = (status) => {
    const classes = { active: 'badge-active', unknown: 'badge-unknown', suspicious: 'badge-suspicious', blocked: 'badge-blocked' };
    return classes[status] || 'badge-unknown';
  };

  const getBadgeText = (status) => {
    const texts = { active: 'Active', unknown: 'Unknown', suspicious: 'Suspicious', blocked: 'Blocked' };
    return texts[status] || 'Unknown';
  };

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="face-page">
        <BackToDashboard />
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
            <div className="face-stat-label">Known Faces</div>
          </div>
          <div className="face-stat">
            <div className="face-stat-value" style={{ color: 'var(--accent-success, #00d450)' }}>{stats.active}</div>
            <div className="face-stat-label">Active</div>
          </div>
          <div className="face-stat">
            <div className="face-stat-value" style={{ color: 'var(--accent-warning, #ffb432)' }}>{stats.suspicious}</div>
            <div className="face-stat-label">Suspicious</div>
          </div>
          <div className="face-stat">
            <div className="face-stat-value" style={{ color: 'var(--accent-danger, #ff5050)' }}>{stats.blocked}</div>
            <div className="face-stat-label">Blocked</div>
          </div>
        </div>

        <div className="enroll-form">
          <h3>Enroll New Face</h3>
          <form onSubmit={handleEnroll}>
            <div className="form-row">
              <div className="form-group">
                <label>Name *</label>
                <input
                  type="text"
                  value={enrollName}
                  onChange={(e) => setEnrollName(e.target.value)}
                  placeholder="Person's name"
                  required
                />
              </div>
              <div className="form-group">
                <label>Image URL (optional)</label>
                <input
                  type="url"
                  value={enrollImageUrl}
                  onChange={(e) => setEnrollImageUrl(e.target.value)}
                  placeholder="https://..."
                />
              </div>
              <div className="form-group">
                <label>Status</label>
                <select value={enrollStatus} onChange={(e) => setEnrollStatus(e.target.value)}>
                  <option value="active">Active</option>
                  <option value="suspicious">Suspicious</option>
                  <option value="blocked">Blocked</option>
                </select>
              </div>
              <button type="submit" className="btn btn-primary" disabled={enrolling}>
                {enrolling ? 'Enrolling...' : 'Enroll'}
              </button>
            </div>
          </form>
        </div>

        <div className="section-header">
          <h2>Known Faces Database</h2>
        </div>

        {loading ? (
          <div className="empty-state">Loading...</div>
        ) : knownFaces.length === 0 ? (
          <div className="empty-state">No known faces enrolled yet. Use the form above to add faces.</div>
        ) : (
          <div className="faces-grid">
            {knownFaces.map(face => (
              <div key={face.id} className="face-card">
                <div className="face-avatar">
                  {face.image_url ? (
                    <img src={face.image_url} alt={face.name} />
                  ) : (
                    '👤'
                  )}
                </div>
                {editingId === face.id ? (
                  <>
                    <input
                      type="text"
                      value={editName}
                      onChange={(e) => setEditName(e.target.value)}
                      style={{ width: '100%', padding: '.3rem', marginBottom: '.5rem', background: 'rgba(87,125,196,.1)', border: '1px solid rgba(87,125,196,.3)', borderRadius: '4px', color: 'var(--text-primary, #dff7ff)' }}
                    />
                    <select
                      value={editStatus}
                      onChange={(e) => setEditStatus(e.target.value)}
                      style={{ width: '100%', padding: '.3rem', marginBottom: '.5rem', background: 'rgba(87,125,196,.1)', border: '1px solid rgba(87,125,196,.3)', borderRadius: '4px', color: 'var(--text-primary, #dff7ff)' }}
                    >
                      <option value="active">Active</option>
                      <option value="suspicious">Suspicious</option>
                      <option value="blocked">Blocked</option>
                    </select>
                    <div className="face-actions">
                      <button className="btn btn-primary btn-sm" onClick={() => handleUpdate(face.id)}>Save</button>
                      <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                    </div>
                  </>
                ) : (
                  <>
                    <h3>{face.name}</h3>
                    <span className={`face-badge ${getBadgeClass(face.status)}`}>
                      {getBadgeText(face.status)}
                    </span>
                    <div className="face-actions">
                      <button className="btn btn-secondary btn-sm" onClick={() => startEdit(face)}>Edit</button>
                      <button className="btn btn-danger btn-sm" onClick={() => handleDelete(face.id)}>Delete</button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        <div className="detections-list">
          <div className="detections-header">
            <h3>Recent Detections (AI)</h3>
          </div>
          {detections.length === 0 ? (
            <div className="empty-state">No AI detections yet</div>
          ) : (
            detections.slice(0, 10).map(det => (
              <div key={det.id} className="detection-row">
                <div className="detection-face">👤</div>
                <div className="detection-info">
                  <h4>{det.name}</h4>
                  <p>{det.camera} • AI Detection</p>
                </div>
                <span className={`face-badge ${getBadgeClass(det.status)}`}>
                  Unknown
                </span>
                <span className="detection-time">
                  {new Date(det.timestamp).toLocaleTimeString()}
                </span>
              </div>
            ))
          )}
        </div>
      </main>
    </>
  );
}
