import React, { useState, useEffect } from 'react';
import api from '../services/api';

const PAGE_CSS = `
  .playback-page { padding: 2rem; color: var(--text-primary, #e5eef7); }
  .playback-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
  .playback-title { font-family: 'Orbitron', sans-serif; font-size: 1.5rem; color: var(--text-primary, #dff5ff); }
  .playback-grid { display: grid; grid-template-columns: 300px 1fr; gap: 1.5rem; min-height: calc(100vh - 200px); }
  .recordings-list { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; overflow: hidden; }
  .recordings-header { padding: 1rem; border-bottom: 1px solid rgba(87,125,196,.18); }
  .recordings-header h2 { color: #8ee8ff; font-size: .85rem; text-transform: uppercase; letter-spacing: .1em; }
  .recording-item { padding: 1rem; border-bottom: 1px solid rgba(87,125,196,.12); cursor: pointer; transition: all .2s; }
  .recording-item:hover { background: rgba(0,212,255,.05); }
  .recording-item.active { background: rgba(0,212,255,.1); border-left: 3px solid var(--accent-primary, #00d4ff); }
  .recording-item h3 { color: var(--text-primary, #dff7ff); margin-bottom: .25rem; font-size: .9rem; }
  .recording-item p { color: var(--text-secondary, #8ab0c9); font-size: .75rem; }
  .recording-time { color: var(--text-muted, #6a8aaa); font-size: .7rem; margin-top: .25rem; }
  .video-player { background: #000; border-radius: 16px; overflow: hidden; display: flex; flex-direction: column; }
  .video-placeholder { flex: 1; display: flex; align-items: center; justify-content: center; background: #0a0f1a; min-height: 400px; }
  .video-placeholder-text { color: var(--text-muted, #6a8aaa); font-size: 1.2rem; text-align: center; }
  .video-placeholder-text span { display: block; font-size: 3rem; margin-bottom: 1rem; }
  .video-controls { background: rgba(10,18,38,.95); padding: 1rem; display: flex; gap: 1rem; align-items: center; }
  .timeline { flex: 1; height: 6px; background: rgba(87,125,196,.3); border-radius: 3px; position: relative; cursor: pointer; }
  .timeline-progress { height: 100%; background: linear-gradient(90deg,var(--accent-primary, #00d4ff),var(--accent-secondary, #8c4dff)); border-radius: 3px; width: 35%; }
  .control-btn { background: rgba(87,125,196,.2); border: none; color: var(--text-secondary, #8ab0c9); padding: .5rem 1rem; border-radius: 6px; font-size: .85rem; cursor: pointer; transition: all .2s; }
  .control-btn:hover { background: rgba(0,212,255,.2); color: var(--accent-primary, #00d4ff); }
  .control-btn.active { background: rgba(0,212,255,.2); color: var(--accent-primary, #00d4ff); }
  .time-display { color: var(--text-secondary, #8ab0c9); font-size: .85rem; font-family: monospace; }
  .filters { display: flex; gap: .75rem; padding: 1rem; border-bottom: 1px solid rgba(87,125,196,.12); flex-wrap: wrap; }
  .filter-input { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); color: var(--text-secondary, #8ab0c9); padding: .6rem 1rem; border-radius: 8px; font-size: .85rem; min-width: 150px; }
  .empty-state { text-align: center; padding: 3rem; color: var(--text-secondary, #8ab0c9); }
`;

export default function VideoPlayback() {
  const [recordings, setRecordings] = useState([]);
  const [selectedRecording, setSelectedRecording] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [filters, setFilters] = useState({
    camera: '',
    date: '',
    type: 'all'
  });

  useEffect(() => {
    fetchRecordings();
  }, []);

  const fetchRecordings = async () => {
    try {
      const res = await api.get('/recordings');
      setRecordings(res.data.recordings || []);
    } catch (err) {
      console.error('Failed to fetch recordings:', err);
      setRecordings([]);
    } finally {
      setLoading(false);
    }
  };

  const formatDuration = (seconds) => {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    return h > 0 ? `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}` : `${m}:${s.toString().padStart(2, '0')}`;
  };

  const getProgressPercent = () => {
    const duration = selectedRecording?.duration;
    if (!duration || duration <= 0) return 0;
    if (currentTime < 0) return 0;
    if (currentTime > duration) return 100;
    return (currentTime / duration) * 100;
  };

  const formatDate = (dateStr) => {
    const date = new Date(dateStr);
    return date.toLocaleDateString() + ' ' + date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  };

  const filteredRecordings = recordings.filter(r => {
    if (filters.camera && !r.camera_name.toLowerCase().includes(filters.camera.toLowerCase())) return false;
    if (filters.type !== 'all' && r.type !== filters.type) return false;
    return true;
  });

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="playback-page">
        <div className="playback-header">
          <h1 className="playback-title">🎬 Video Playback & Recordings</h1>
        </div>

        <div className="playback-grid">
          <div className="recordings-list">
            <div className="recordings-header">
              <h2>Recordings</h2>
            </div>
            <div className="filters">
              <input
                type="text"
                className="filter-input"
                placeholder="Search camera..."
                value={filters.camera}
                onChange={(e) => setFilters({...filters, camera: e.target.value})}
              />
              <select 
                className="filter-input"
                value={filters.type}
                onChange={(e) => setFilters({...filters, type: e.target.value})}
              >
                <option value="all">All Types</option>
                <option value="Motion">Motion</option>
                <option value="Continuous">Continuous</option>
                <option value="Alarm">Alarm</option>
                <option value="Manual">Manual</option>
              </select>
            </div>

            {loading ? (
              <div className="empty-state">Loading...</div>
            ) : filteredRecordings.length === 0 ? (
              <div className="empty-state">No recordings found</div>
            ) : (
              filteredRecordings.map(rec => (
                <div 
                  key={rec.id}
                  className={`recording-item ${selectedRecording?.id === rec.id ? 'active' : ''}`}
                  onClick={() => setSelectedRecording(rec)}
                >
                  <h3>📹 {rec.camera_name}</h3>
                  <p>{rec.type} • {formatDuration(rec.duration)} • {rec.size}MB</p>
                  <div className="recording-time">{formatDate(rec.timestamp)}</div>
                </div>
              ))
            )}
          </div>

          <div className="video-player">
            <div className="video-placeholder">
              {selectedRecording ? (
                <div style={{ textAlign: 'center', color: 'var(--text-secondary, #8ab0c9)' }}>
                  <span style={{ fontSize: '3rem' }}>▶️</span>
                  <p>Video Player Ready</p>
                  <p style={{ fontSize: '0.85rem' }}>{selectedRecording.camera_name}</p>
                  <p style={{ fontSize: '0.8rem', color: 'var(--text-muted, #6a8aaa)' }}>
                    Duration: {formatDuration(selectedRecording.duration)}
                  </p>
                </div>
              ) : (
                <div className="video-placeholder-text">
                  <span>📹</span>
                  Select a recording to view
                </div>
              )}
            </div>
            <div className="video-controls">
              <button 
                className={`control-btn ${isPlaying ? 'active' : ''}`}
                onClick={() => setIsPlaying(!isPlaying)}
              >
                {isPlaying ? '⏸ Pause' : '▶ Play'}
              </button>
              <div className="timeline">
                <div className="timeline-progress" style={{ width: `${getProgressPercent()}%` }} />
              </div>
              <span className="time-display">
                {formatDuration(currentTime)} / {formatDuration(selectedRecording?.duration || 0)}
              </span>
              <button className="control-btn">🔊</button>
              <button className="control-btn">⏮</button>
              <button className="control-btn">⏭</button>
              <button className="control-btn">💾 Download</button>
            </div>
          </div>
        </div>
      </main>
    </>
  );
}
