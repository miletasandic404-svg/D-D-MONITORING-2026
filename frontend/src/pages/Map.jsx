import React, { useState, useEffect } from 'react';
import api from '../services/api';

const PAGE_CSS = `
  .map-page { height: calc(100vh - 60px); display: flex; flex-direction: column; }
  .map-header { padding: 1rem 2rem; display: flex; justify-content: space-between; align-items: center; background: rgba(10,18,38,.9); border-bottom: 1px solid rgba(87,140,255,.18); }
  .map-title { font-family: 'Orbitron', sans-serif; font-size: 1.2rem; color: var(--text-primary, #dff5ff); }
  .map-controls { display: flex; gap: .5rem; }
  .map-btn { background: rgba(87,125,196,.2); border: 1px solid rgba(87,125,196,.3); color: var(--text-secondary, #8ab0c9); padding: .5rem 1rem; border-radius: 8px; font-size: .85rem; cursor: pointer; transition: all .2s; }
  .map-btn:hover { border-color: var(--accent-primary, #00d4ff); color: var(--accent-primary, #00d4ff); }
  .map-btn.active { background: rgba(0,212,255,.2); border-color: var(--accent-primary, #00d4ff); color: var(--accent-primary, #00d4ff); }
  .map-container { flex: 1; background: #0a0f1a; position: relative; overflow: hidden; }
  .map-grid { position: absolute; inset: 0; background-image: linear-gradient(rgba(0,212,255,.05) 1px, transparent 1px), linear-gradient(90deg, rgba(0,212,255,.05) 1px, transparent 1px); background-size: 50px 50px; }
  .map-locations { position: absolute; inset: 0; }
  .location-marker { position: absolute; transform: translate(-50%, -50%); cursor: pointer; }
  .marker-dot { width: 16px; height: 16px; border-radius: 50%; background: var(--accent-primary, #00d4ff); border: 2px solid #fff; box-shadow: 0 0 20px rgba(0,212,255,.5); animation: pulse 2s infinite; }
  .marker-dot.offline { background: var(--accent-danger, #ff5050); box-shadow: 0 0 20px rgba(255,80,80,.5); animation: none; }
  .marker-label { position: absolute; top: 20px; left: 50%; transform: translateX(-50%); background: rgba(10,18,38,.9); padding: .25rem .5rem; border-radius: 4px; font-size: .75rem; color: var(--text-primary, #dff7ff); white-space: nowrap; border: 1px solid rgba(0,212,255,.3); }
  @keyframes pulse { 0%, 100% { transform: scale(1); opacity: 1; } 50% { transform: scale(1.2); opacity: .8; } }
  .map-sidebar { position: absolute; right: 0; top: 0; bottom: 0; width: 300px; background: rgba(10,18,38,.95); border-left: 1px solid rgba(87,140,255,.18); padding: 1rem; overflow-y: auto; }
  .sidebar-title { color: #8ee8ff; font-size: .85rem; text-transform: uppercase; letter-spacing: .1em; margin-bottom: 1rem; }
  .camera-list { display: flex; flex-direction: column; gap: .5rem; }
  .camera-item { background: rgba(87,125,196,.1); border: 1px solid rgba(87,125,196,.2); border-radius: 10px; padding: 1rem; cursor: pointer; transition: all .2s; }
  .camera-item:hover { border-color: rgba(0,212,255,.5); }
  .camera-item h3 { color: var(--text-primary, #dff7ff); font-size: .9rem; margin-bottom: .25rem; }
  .camera-item p { color: var(--text-secondary, #8ab0c9); font-size: .8rem; }
  .camera-status { display: flex; align-items: center; gap: .5rem; margin-top: .5rem; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; }
  .status-dot.online { background: var(--accent-success, #00d450); }
  .status-dot.offline { background: var(--accent-danger, #ff5050); }
  .empty-map { position: absolute; inset: 0; display: flex; flex-direction: column; align-items: center; justify-content: center; color: var(--text-secondary, #8ab0c9); }
  .empty-map h2 { color: var(--text-primary, #dff7ff); margin-bottom: .5rem; }
`;

export default function Map() {
  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showLabels, setShowLabels] = useState(true);
  const [selectedCamera, setSelectedCamera] = useState(null);

  useEffect(() => {
    fetchCameras();
  }, []);

  const fetchCameras = async () => {
    try {
      const res = await api.get('/cameras');
      setCameras(res.data.cameras || []);
    } catch (err) {
      console.error('Failed to fetch cameras:', err);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="map-page">
        <div className="map-header">
          <h1 className="map-title">📍 Live Camera Map</h1>
          <div className="map-controls">
            <button 
              className={`map-btn ${showLabels ? 'active' : ''}`}
              onClick={() => setShowLabels(!showLabels)}
            >
              Labels
            </button>
            <button className="map-btn">Refresh</button>
          </div>
        </div>

        <div className="map-container">
          <div className="map-grid" />
          
          {cameras.length === 0 && !loading ? (
            <div className="empty-map">
              <h2>No Camera Locations</h2>
              <p>Add cameras with latitude/longitude coordinates to see them on the map.</p>
              <p style={{ marginTop: '1rem', fontSize: '0.85rem' }}>
                Tip: Use the camera settings to add location coordinates.
              </p>
            </div>
          ) : (
            <div className="map-locations">
              {cameras.map((camera, index) => {
                // Generate positions based on index if no coordinates
                const left = camera.lng ? ((camera.lng + 180) / 360 * 100) : (20 + (index * 15) % 60);
                const top = camera.lat ? ((90 - camera.lat) / 180 * 100) : (20 + (index * 20) % 60);
                
                return (
                  <div 
                    key={camera.id}
                    className="location-marker"
                    style={{ left: `${left}%`, top: `${top}%` }}
                    onClick={() => setSelectedCamera(camera)}
                  >
                    <div className={`marker-dot ${camera.enabled === false ? 'offline' : ''}`} />
                    {showLabels && <div className="marker-label">{camera.name}</div>}
                  </div>
                );
              })}
            </div>
          )}

          <div className="map-sidebar">
            <div className="sidebar-title">Camera Locations</div>
            {loading ? (
              <p style={{ color: 'var(--text-secondary, #8ab0c9)' }}>Loading...</p>
            ) : cameras.length === 0 ? (
              <p style={{ color: 'var(--text-secondary, #8ab0c9)' }}>No cameras configured.</p>
            ) : (
              <div className="camera-list">
                {cameras.map(camera => (
                  <div 
                    key={camera.id} 
                    className="camera-item"
                    onClick={() => setSelectedCamera(camera)}
                  >
                    <h3>{camera.name}</h3>
                    <p>{camera.location || 'No location set'}</p>
                    <div className="camera-status">
                      <span className={`status-dot ${camera.enabled !== false ? 'online' : 'offline'}`} />
                      <span style={{ color: camera.enabled !== false ? 'var(--accent-success, #00d450)' : 'var(--accent-danger, #ff5050)', fontSize: '.8rem' }}>
                        {camera.enabled !== false ? 'Online' : 'Offline'}
                      </span>
                    </div>
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
