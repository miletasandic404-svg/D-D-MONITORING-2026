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
`;

export default function LicensePlateRecognition() {
  const [plates, setPlates] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');

  useEffect(() => {
    fetchPlateData();
  }, []);

  const fetchPlateData = async () => {
    try {
      // /license-plates does not exist; use the real /ai-detections
      // endpoint and keep only plate/license/vehicle detections.
      const res = await api.get('/ai-detections');
      const all = res.data.detections || [];
      const plateRows = all.filter((d) => /plate|license|vehicle/i.test(d.object_type || ''));
      setPlates(plateRows.map((d) => ({
        id: d.id,
        plate_number: (d.bounding_box && (d.bounding_box.text || d.bounding_box.plate))
          || d.object_type || 'UNKNOWN',
        vehicle: (d.bounding_box && d.bounding_box.vehicle) || d.object_type || 'Vehicle',
        color: (d.bounding_box && d.bounding_box.color) || '\u2014',
        camera: d.camera_name || d.camera_id || 'Unknown',
        status: 'unknown',
        timestamp: d.created_at,
      })));
    } catch (err) {
      console.error('Failed to fetch plate data:', err);
      setPlates([]);
    } finally {
      setLoading(false);
    }
  };

  const filteredPlates = plates.filter(p => 
    String(p.plate_number || '').toLowerCase().includes(searchTerm.toLowerCase()) ||
    String(p.vehicle || '').toLowerCase().includes(searchTerm.toLowerCase())
  );

  const stats = {
    total: plates.length,
    allowed: plates.filter(p => p.status === 'allowed').length,
    blocked: plates.filter(p => p.status === 'blocked').length,
    unknown: plates.filter(p => p.status === 'unknown').length
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
            <div className="lpr-stat-label">Total Scans</div>
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

        <div className="search-box">
          <input
            type="text"
            className="search-input"
            placeholder="Search by plate number or vehicle..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
          />
        </div>

        {loading ? (
          <div className="empty-state">Loading...</div>
        ) : filteredPlates.length === 0 ? (
          <div className="empty-state">No plates found</div>
        ) : (
          <>
            <div className="plates-grid">
              {filteredPlates.slice(0, 12).map(plate => (
                <div key={plate.id} className={`plate-card ${getCardClass(plate.status)}`}>
                  <div className="plate-number">{plate.plate_number}</div>
                  <div className="plate-details">
                    <span>🚗 {plate.vehicle}</span>
                    <span>🎨 {plate.color}</span>
                    <span>📷 {plate.camera}</span>
                  </div>
                  <span className={`plate-status ${getStatusClass(plate.status)}`}>
                    {getStatusText(plate.status)}
                  </span>
                  <div className="plate-time">
                    {new Date(plate.timestamp).toLocaleString()}
                  </div>
                </div>
              ))}
            </div>

            <div className="vehicles-list">
              <div className="vehicles-header">
                <h2>Recent Vehicle Scans</h2>
              </div>
              <table className="vehicles-table">
                <thead>
                  <tr>
                    <th>Plate</th>
                    <th>Vehicle</th>
                    <th>Color</th>
                    <th>Location</th>
                    <th>Status</th>
                    <th>Time</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredPlates.slice(0, 10).map(plate => (
                    <tr key={plate.id}>
                      <td style={{ fontFamily: 'monospace', fontWeight: 'bold', color: 'var(--accent-primary, #00d4ff)' }}>{plate.plate_number}</td>
                      <td>{plate.vehicle}</td>
                      <td>{plate.color}</td>
                      <td>{plate.camera}</td>
                      <td>
                        <span className={`plate-status ${getStatusClass(plate.status)}`}>
                          {getStatusText(plate.status)}
                        </span>
                      </td>
                      <td style={{ color: 'var(--text-muted, #6a8aaa)', fontSize: '.8rem' }}>
                        {new Date(plate.timestamp).toLocaleTimeString()}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </>
        )}
      </main>
    </>
  );
}
