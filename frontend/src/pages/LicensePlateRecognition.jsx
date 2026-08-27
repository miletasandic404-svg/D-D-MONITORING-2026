import React, { useState, useEffect } from 'react';
import api from '../services/api';

const PAGE_CSS = `
  .lpr-page { padding: 2rem; color: var(--text-primary, #e5eef7); }
  .lpr-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
  .lpr-title { font-family: 'Orbitron', sans-serif; font-size: 1.5rem; color: var(--text-primary, #dff5ff); }
  .lpr-stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 1rem; margin-bottom: 2rem; }
  .lpr-stat { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 12px; padding: 1rem; text-align: center; }
  .lpr-stat-value { font-size: 2rem; font-weight: bold; color: var(--accent-primary, #00d4ff); }
  .lpr-stat-label { color: var(--text-secondary, #8ab0c9); font-size: .8rem; margin-top: .25rem; }
  .plates-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 1rem; }
  .plate-card { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 12px; padding: 1.25rem; transition: all .2s; }
  .plate-card:hover { border-color: rgba(0,212,255,.5); }
  .plate-card.allowed { border-left: 4px solid var(--accent-success, #00d450); }
  .plate-card.blocked { border-left: 4px solid var(--accent-danger, #ff5050); }
  .plate-card.unknown { border-left: 4px solid var(--accent-warning, #ffb432); }
  .plate-number { font-family: monospace; font-size: 1.5rem; font-weight: bold; color: var(--accent-primary, #00d4ff); margin-bottom: .5rem; letter-spacing: .1em; }
  .plate-details { display: flex; flex-wrap: wrap; gap: .75rem; color: var(--text-secondary, #8ab0c9); font-size: .8rem; margin-bottom: .75rem; }
  .plate-details span { display: flex; align-items: center; gap: .25rem; }
  .plate-status { display: inline-block; padding: .25rem .75rem; border-radius: 12px; font-size: .75rem; font-weight: bold; text-transform: uppercase; }
  .status-allowed { background: rgba(0,212,80,.2); color: var(--accent-success, #00d450); }
  .status-blocked { background: rgba(255,80,80,.2); color: var(--accent-danger, #ff5050); }
  .status-unknown { background: rgba(255,180,50,.2); color: var(--accent-warning, #ffb432); }
  .plate-time { color: var(--text-muted, #6a8aaa); font-size: .75rem; margin-top: .5rem; }
  .vehicles-list { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; margin-top: 2rem; overflow: hidden; }
  .vehicles-header { padding: 1rem; border-bottom: 1px solid rgba(87,125,196,.18); }
  .vehicles-header h2 { color: #8ee8ff; font-size: .9rem; text-transform: uppercase; letter-spacing: .1em; }
  .vehicles-table { width: 100%; }
  .vehicles-table th { text-align: left; padding: 1rem; color: #8ee8ff; font-size: .8rem; text-transform: uppercase; border-bottom: 1px solid rgba(87,125,196,.18); }
  .vehicles-table td { padding: 1rem; border-bottom: 1px solid rgba(87,125,196,.12); }
  .vehicles-table tr:hover { background: rgba(0,212,255,.05); }
  .empty-state { text-align: center; padding: 3rem; color: var(--text-secondary, #8ab0c9); }
  .search-box { margin-bottom: 1.5rem; }
  .search-input { width: 100%; max-width: 400px; padding: .8rem 1rem; background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 10px; color: var(--text-primary, #dff7ff); font-size: .9rem; }
  .search-input::placeholder { color: var(--text-muted, #6a8aaa); }
  .enroll-form { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 12px; padding: 1.5rem; margin-bottom: 2rem; }
  .enroll-form h3 { color: #8ee8ff; margin-bottom: 1rem; font-size: .9rem; text-transform: uppercase; letter-spacing: .1em; }
  .form-row { display: flex; gap: 1rem; flex-wrap: wrap; align-items: flex-end; }
  .form-group { display: flex; flex-direction: column; gap: .25rem; flex: 1; min-width: 120px; }
  .form-group label { color: var(--text-secondary, #8ab0c9); font-size: .8rem; }
  .form-group input, .form-group select, .form-group textarea { padding: .6rem; background: rgba(87,125,196,.1); border: 1px solid rgba(87,125,196,.3); border-radius: 8px; color: var(--text-primary, #dff7ff); font-size: .9rem; }
  .btn { padding: .6rem 1.2rem; border: none; border-radius: 8px; cursor: pointer; font-size: .85rem; font-weight: bold; }
  .btn-primary { background: var(--accent-primary, #00d4ff); color: #000; }
  .btn-danger { background: rgba(255,80,80,.2); color: var(--accent-danger, #ff5050); border: 1px solid rgba(255,80,80,.3); }
  .btn-secondary { background: rgba(87,125,196,.2); color: var(--text-secondary, #8ab0c9); border: 1px solid rgba(87,125,196,.3); }
  .btn-sm { padding: .3rem .6rem; font-size: .75rem; }
  .plate-actions { display: flex; gap: .5rem; margin-top: .5rem; }
  .section-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 1rem; }
  .section-header h2 { color: #8ee8ff; font-size: .9rem; text-transform: uppercase; letter-spacing: .1em; margin: 0; }
  .detection-section { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; margin-top: 2rem; }
  .detection-section-header { padding: 1rem; border-bottom: 1px solid rgba(87,125,196,.18); }
  .detection-section-header h3 { color: #8ee8ff; font-size: .9rem; text-transform: uppercase; letter-spacing: .1em; }
`;

export default function LicensePlateRecognition() {
  const [detections, setDetections] = useState([]);
  const [knownPlates, setKnownPlates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  const [enrollPlate, setEnrollPlate] = useState('');
  const [enrollMake, setEnrollMake] = useState('');
  const [enrollModel, setEnrollModel] = useState('');
  const [enrollColor, setEnrollColor] = useState('');
  const [enrollStatus, setEnrollStatus] = useState('unknown');
  const [enrollNotes, setEnrollNotes] = useState('');
  const [enrolling, setEnrolling] = useState(false);
  const [editingId, setEditingId] = useState(null);
  const [editStatus, setEditStatus] = useState('');
   const [editNotes, setEditNotes] = useState('');

  useEffect(() => {
    fetchPlateData();
  }, []);

  const fetchPlateData = async () => {
    try {
      const [detRes, platesRes] = await Promise.all([
        api.get('/ai-detections'),
        api.get('/license-plates'),
      ]);
      const all = detRes.data.detections || [];
      const plateRows = all.filter((d) => /plate|license|vehicle/i.test(d.object_type || ''));
      setDetections(plateRows.map((d) => ({
        id: d.id,
        plate_number: (d.bounding_box && (d.bounding_box.text || d.bounding_box.plate)) || d.object_type || 'UNKNOWN',
        vehicle: (d.bounding_box && d.bounding_box.vehicle) || d.object_type || 'Vehicle',
        color: (d.bounding_box && d.bounding_box.color) || '—',
        camera: d.camera_name || d.camera_id || 'Unknown',
        timestamp: d.created_at,
      })));
      setKnownPlates(platesRes.data.known_plates || []);
    } catch (err) {
      console.error('Failed to fetch plate data:', err);
      setDetections([]);
      setKnownPlates([]);
    } finally {
      setLoading(false);
    }
  };

  const handleEnroll = async (e) => {
    e.preventDefault();
    if (!enrollPlate.trim()) return;
    setEnrolling(true);
    try {
      await api.post('/license-plates/enroll', {
        plate_number: enrollPlate.trim(),
        vehicle_make: enrollMake.trim() || null,
        vehicle_model: enrollModel.trim() || null,
        vehicle_color: enrollColor.trim() || null,
        status: enrollStatus,
        notes: enrollNotes.trim() || null,
      });
      setEnrollPlate('');
      setEnrollMake('');
      setEnrollModel('');
      setEnrollColor('');
      setEnrollStatus('unknown');
      setEnrollNotes('');
      await fetchPlateData();
    } catch (err) {
      console.error('Failed to enroll plate:', err);
      alert(err?.response?.data?.error || 'Failed to enroll plate');
    } finally {
      setEnrolling(false);
    }
  };

  const handleUpdate = async (id) => {
    try {
      const updates = {};
      if (editStatus) updates.status = editStatus;
      if (editNotes.trim()) updates.notes = editNotes.trim();
      await api.put(`/license-plates/${id}`, updates);
      setEditingId(null);
      setEditStatus('');
      setEditNotes('');
      await fetchPlateData();
    } catch (err) {
      console.error('Failed to update plate:', err);
      alert(err?.response?.data?.error || 'Failed to update plate');
    }
  };

  const handleDelete = async (id) => {
    if (!confirm('Delete this plate from the database?')) return;
    try {
      await api.delete(`/license-plates/${id}`);
      await fetchPlateData();
    } catch (err) {
      console.error('Failed to delete plate:', err);
      alert(err?.response?.data?.error || 'Failed to delete plate');
    }
  };

  const startEdit = (plate) => {
    setEditingId(plate.id);
    setEditStatus(plate.status);
    setEditNotes(plate.notes || '');
  };

  const filteredPlates = knownPlates.filter(p =>
    String(p.plate_number || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    String(p.vehicle_make || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    String(p.vehicle_model || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  const stats = {
    total: knownPlates.length,
    allowed: knownPlates.filter(p => p.status === 'allowed').length,
    blocked: knownPlates.filter(p => p.status === 'blocked').length,
    unknown: knownPlates.filter(p => p.status === 'unknown').length,
  };

  const getStatusClass = (status) => {
    const classes = { allowed: 'status-allowed', blocked: 'status-blocked', unknown: 'status-unknown' };
    return classes[status] || 'status-unknown';
  };

  const getCardClass = (status) => {
    const classes = { allowed: 'allowed', blocked: 'blocked', unknown: 'unknown' };
    return classes[status] || 'unknown';
  };

  const getStatusText = (status) => {
    const texts = { allowed: '✓ Allowed', blocked: '✕ Blocked', unknown: '? Unknown' };
    return texts[status] || 'Unknown';
  };

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="lpr-page">
        <div className="lpr-header">
          <h1 className="lpr-title">🚗 License Plate Recognition (LPR)</h1>
        </div>

        <div className="lpr-stats">
          <div className="lpr-stat">
            <div className="lpr-stat-value">{stats.total}</div>
            <div className="lpr-stat-label">Known Plates</div>
          </div>
          <div className="lpr-stat">
            <div className="lpr-stat-value" style={{ color: 'var(--accent-success, #00d450)' }}>{stats.allowed}</div>
            <div className="lpr-stat-label">Allowed</div>
          </div>
          <div className="lpr-stat">
            <div className="lpr-stat-value" style={{ color: 'var(--accent-danger, #ff5050)' }}>{stats.blocked}</div>
            <div className="lpr-stat-label">Blocked</div>
          </div>
          <div className="lpr-stat">
            <div className="lpr-stat-value" style={{ color: 'var(--accent-warning, #ffb432)' }}>{stats.unknown}</div>
            <div className="lpr-stat-label">Unknown</div>
          </div>
        </div>

        <div className="enroll-form">
          <h3>Enroll New Plate</h3>
          <form onSubmit={handleEnroll}>
            <div className="form-row">
              <div className="form-group">
                <label>Plate Number *</label>
                <input
                  type="text"
                  value={enrollPlate}
                  onChange={(e) => setEnrollPlate(e.target.value)}
                  placeholder="e.g. BG-123-AB"
                  required
                />
              </div>
              <div className="form-group">
                <label>Vehicle Make</label>
                <input
                  type="text"
                  value={enrollMake}
                  onChange={(e) => setEnrollMake(e.target.value)}
                  placeholder="e.g. Toyota"
                />
              </div>
              <div className="form-group">
                <label>Vehicle Model</label>
                <input
                  type="text"
                  value={enrollModel}
                  onChange={(e) => setEnrollModel(e.target.value)}
                  placeholder="e.g. Corolla"
                />
              </div>
              <div className="form-group">
                <label>Color</label>
                <input
                  type="text"
                  value={enrollColor}
                  onChange={(e) => setEnrollColor(e.target.value)}
                  placeholder="e.g. White"
                />
              </div>
              <div className="form-group">
                <label>Status</label>
                <select value={enrollStatus} onChange={(e) => setEnrollStatus(e.target.value)}>
                  <option value="unknown">Unknown</option>
                  <option value="allowed">Allowed</option>
                  <option value="blocked">Blocked</option>
                </select>
              </div>
              <button type="submit" className="btn btn-primary" disabled={enrolling}>
                {enrolling ? 'Enrolling...' : 'Enroll'}
              </button>
            </div>
            <div className="form-row" style={{ marginTop: '1rem' }}>
              <div className="form-group" style={{ flex: '100%' }}>
                <label>Notes (optional)</label>
                <textarea
                  value={enrollNotes}
                  onChange={(e) => setEnrollNotes(e.target.value)}
                  placeholder="Additional notes..."
                  rows={2}
                  style={{ width: '100%', resize: 'vertical' }}
                />
              </div>
            </div>
          </form>
        </div>

        <div className="section-header">
          <h2>Known Plates Database</h2>
        </div>

        <div className="search-box">
          <input
            type="text"
            className="search-input"
            placeholder="Search by plate number, make, or model..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="empty-state">Loading...</div>
        ) : filteredPlates.length === 0 ? (
          <div className="empty-state">No known plates found. Use the form above to enroll plates.</div>
        ) : (
          <>
            <div className="plates-grid">
              {filteredPlates.slice(0, 12).map(plate => (
                <div key={plate.id} className={`plate-card ${getCardClass(plate.status)}`}>
                  <div className="plate-number">{plate.plate_number}</div>
                  <div className="plate-details">
                    {plate.vehicle_make && <span>🚗 {plate.vehicle_make} {plate.vehicle_model || ''}</span>}
                    {plate.vehicle_color && <span>🎨 {plate.vehicle_color}</span>}
                  </div>
                  {editingId === plate.id ? (
                    <>
                      <select
                        value={editStatus}
                        onChange={(e) => setEditStatus(e.target.value)}
                        style={{ width: '100%', padding: '.3rem', marginBottom: '.5rem', background: 'rgba(87,125,196,.1)', border: '1px solid rgba(87,125,196,.3)', borderRadius: '4px', color: 'var(--text-primary, #dff7ff)' }}
                      >
                        <option value="unknown">Unknown</option>
                        <option value="allowed">Allowed</option>
                        <option value="blocked">Blocked</option>
                      </select>
                      <input
                        type="text"
                        value={editNotes}
                        onChange={(e) => setEditNotes(e.target.value)}
                        placeholder="Notes"
                        style={{ width: '100%', padding: '.3rem', marginBottom: '.5rem', background: 'rgba(87,125,196,.1)', border: '1px solid rgba(87,125,196,.3)', borderRadius: '4px', color: 'var(--text-primary, #dff7ff)' }}
                      />
                      <div className="plate-actions">
                        <button className="btn btn-primary btn-sm" onClick={() => handleUpdate(plate.id)}>Save</button>
                        <button className="btn btn-secondary btn-sm" onClick={() => setEditingId(null)}>Cancel</button>
                      </div>
                    </>
                  ) : (
                    <>
                      <span className={`plate-status ${getStatusClass(plate.status)}`}>
                        {getStatusText(plate.status)}
                      </span>
                      {plate.notes && (
                        <p style={{ color: 'var(--text-muted, #6a8aaa)', fontSize: '.75rem', marginTop: '.5rem' }}>
                          {plate.notes}
                        </p>
                      )}
                      <div className="plate-actions">
                        <button className="btn btn-secondary btn-sm" onClick={() => startEdit(plate)}>Edit</button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(plate.id)}>Delete</button>
                      </div>
                    </>
                  )}
                </div>
              ))}
            </div>

            <div className="vehicles-list">
              <div className="vehicles-header">
                <h2>All Known Plates</h2>
              </div>
              <table className="vehicles-table">
                <thead>
                  <tr>
                    <th>Plate</th>
                    <th>Vehicle</th>
                    <th>Color</th>
                    <th>Status</th>
                    <th>Notes</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPlates.slice(0, 20).map(plate => (
                    <tr key={plate.id}>
                      <td style={{ fontFamily: 'monospace', fontWeight: 'bold', color: 'var(--accent-primary, #00d4ff)' }}>{plate.plate_number}</td>
                      <td>{[plate.vehicle_make, plate.vehicle_model].filter(Boolean).join(' ') || '—'}</td>
                      <td>{plate.vehicle_color || '—'}</td>
                      <td>
                        <span className={`plate-status ${getStatusClass(plate.status)}`}>
                          {getStatusText(plate.status)}
                        </span>
                      </td>
                      <td style={{ color: 'var(--text-muted, #6a8aaa)', fontSize: '.8rem' }}>
                        {plate.notes || '—'}
                      </td>
                      <td>
                        <button className="btn btn-secondary btn-sm" onClick={() => startEdit(plate)}>Edit</button>
                        <button className="btn btn-danger btn-sm" onClick={() => handleDelete(plate.id)} style={{ marginLeft: '.25rem' }}>Delete</button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}

        <div className="detection-section">
          <div className="detection-section-header">
            <h3>Recent AI Detections (Raw)</h3>
          </div>
          {detections.length === 0 ? (
            <div className="empty-state">No AI plate detections yet</div>
          ) : (
            <table className="vehicles-table">
              <thead>
                <tr>
                  <th>Detected Text</th>
                  <th>Camera</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {detections.slice(0, 10).map(det => (
                  <tr key={det.id}>
                    <td style={{ fontFamily: 'monospace', fontWeight: 'bold', color: 'var(--accent-primary, #00d4ff)' }}>{det.plate_number}</td>
                    <td>{det.camera}</td>
                    <td style={{ color: 'var(--text-muted, #6a8aaa)', fontSize: '.8rem' }}>
                      {new Date(det.timestamp).toLocaleTimeString()}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </main>
    </>
  );
}
