import React, { useState, useEffect, useRef } from 'react';
import api from '../services/api';
import BackToDashboard from '../components/BackToDashboard';

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
  .video-container { flex: 1; display: flex; align-items: center; justify-content: center; background: #0a0f1a; min-height: 400px; position: relative; }
  .video-container video { max-width: 100%; max-height: 100%; border-radius: 8px; }
  .video-placeholder { text-align: center; color: var(--text-muted, #6a8aaa); }
  .video-placeholder span { display: block; font-size: 3rem; margin-bottom: 1rem; }
  .video-controls { background: rgba(10,18,38,.95); padding: 1rem; display: flex; gap: 1rem; align-items: center; }
  .timeline { flex: 1; height: 6px; background: rgba(87,125,196,.3); border-radius: 3px; position: relative; cursor: pointer; }
  .timeline-progress { height: 100%; background: linear-gradient(90deg,var(--accent-primary, #00d4ff),var(--accent-secondary, #8c4dff)); border-radius: 3px; width: 0%; transition: width 0.1s linear; }
  .control-btn { background: rgba(87,125,196,.2); border: none; color: var(--text-secondary, #8ab0c9); padding: .5rem 1rem; border-radius: 6px; font-size: .85rem; cursor: pointer; transition: all .2s; }
  .control-btn:hover { background: rgba(0,212,255,.2); color: var(--accent-primary, #00d4ff); }
  .control-btn.active { background: rgba(0,212,255,.2); color: var(--accent-primary, #00d4ff); }
  .time-display { color: var(--text-secondary, #8ab0c9); font-size: .85rem; font-family: monospace; }
  .filters { display: flex; gap: .75rem; padding: 1rem; border-bottom: 1px solid rgba(87,125,196,.12); flex-wrap: wrap; }
  .filter-input { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); color: var(--text-secondary, #8ab0c9); padding: .6rem 1rem; border-radius: 8px; font-size: .85rem; min-width: 150px; }
  .empty-state { text-align: center; padding: 3rem; color: var(--text-secondary, #8ab0c9); }
  .error-state { color: var(--accent-danger, #ff5050); text-align: center; padding: 2rem; }
`;

export default function VideoPlayback() {
  const [recordings, setRecordings] = useState([]);
  const [selectedRecording, setSelectedRecording] = useState(null);
  const [loading, setLoading] = useState(true);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [playbackError, setPlaybackError] = useState(null);
  const [filters, setFilters] = useState({
    camera: '',
    date: '',
    type: 'all'
  });

  const videoRef = useRef(null);

  useEffect(() => {
    fetchRecordings();
  }, []);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !selectedRecording?.storage_url) return;

    const handleTimeUpdate = () => setCurrentTime(video.currentTime);
    const handlePlay = () => setIsPlaying(true);
    const handlePause = () => setIsPlaying(false);
    const handleEnded = () => setIsPlaying(false);
    const handleError = () => {
      setPlaybackError('Failed to load recording. The file may be unavailable.');
      setIsPlaying(false);
    };

    video.addEventListener('timeupdate', handleTimeUpdate);
    video.addEventListener('play', handlePlay);
    video.addEventListener('pause', handlePause);
    video.addEventListener('ended', handleEnded);
    video.addEventListener('error', handleError);

    return () => {
      video.removeEventListener('timeupdate', handleTimeUpdate);
      video.removeEventListener('play', handlePlay);
      video.removeEventListener('pause', handlePause);
      video.removeEventListener('ended', handleEnded);
      video.removeEventListener('error', handleError);
    };
  }, [selectedRecording]);

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

  const togglePlay = () => {
    const video = videoRef.current;
    if (!video) return;
    if (video.paused) {
      video.play().catch(() => setPlaybackError('Playback failed. The recording may be unavailable.'));
    } else {
      video.pause();
    }
  };

  const handleTimelineClick = (e) => {
    const video = videoRef.current;
    if (!video || !selectedRecording?.duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    video.currentTime = pct * selectedRecording.duration;
  };

  const handleDownload = async () => {
    if (!selectedRecording?.storage_url) return;
    try {
      const res = await api.get(selectedRecording.storage_url, { responseType: 'blob' });
      const url = window.URL.createObjectURL(new Blob([res.data]));
      const link = document.createElement('a');
      link.href = url;
      link.setAttribute('download', `recording-${selectedRecording.id}.mp4`);
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.URL.revokeObjectURL(url);
    } catch {
      window.open(selectedRecording.storage_url, '_blank');
    }
  };

  const filteredRecordings = recordings.filter(r => {
    if (filters.camera && !(r.camera_name || '').toLowerCase().includes(filters.camera.toLowerCase())) return false;
    if (filters.type !== 'all' && r.type !== filters.type) return false;
    return true;
  });

  const isLocalRecording = selectedRecording?.storage_url?.startsWith('local://');

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="playback-page">
        <BackToDashboard />
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
                  onClick={() => {
                    setSelectedRecording(rec);
                    setPlaybackError(null);
                    setCurrentTime(0);
                    setIsPlaying(false);
                  }}
                >
                  <h3>📹 {rec.camera_name || 'Unknown Camera'}</h3>
                  <p>{rec.type} • {formatDuration(rec.duration)} • {rec.size}MB</p>
                  <div className="recording-time">{formatDate(rec.timestamp)}</div>
                </div>
              ))
            )}
          </div>

          <div className="video-player">
            <div className="video-container">
              {selectedRecording ? (
                isLocalRecording ? (
                  <div className="error-state">
                    <span style={{ fontSize: '3rem', display: 'block', marginBottom: '1rem' }}>📁</span>
                    <p>Local recording playback requires a media node proxy.</p>
                    <p style={{ fontSize: '0.85rem', color: 'var(--text-muted, #6a8aaa)' }}>
                      Access this recording through the media server directly.
                    </p>
                  </div>
                ) : selectedRecording.storage_url ? (
                  <>
                    <video
                      ref={videoRef}
                      controls
                      autoPlay
                      src={selectedRecording.storage_url}
                      onError={() => setPlaybackError('Failed to load recording.')}
                    />
                    {playbackError && (
                      <div className="error-state" style={{ position: 'absolute', bottom: 16, left: '50%', transform: 'translateX(-50%)', background: 'rgba(255,80,80,.9)', padding: '0.5rem 1rem', borderRadius: 8 }}>
                        {playbackError}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="video-placeholder">
                    <span>📹</span>
                    <p>No playback URL available for this recording.</p>
                  </div>
                )
              ) : (
                <div className="video-placeholder">
                  <span>📹</span>
                  <p>Select a recording to view</p>
                </div>
              )}
            </div>
            {selectedRecording && !isLocalRecording && (
              <div className="video-controls">
                <button
                  className={`control-btn ${isPlaying ? 'active' : ''}`}
                  onClick={togglePlay}
                >
                  {isPlaying ? '⏸ Pause' : '▶ Play'}
                </button>
                <div className="timeline" onClick={handleTimelineClick}>
                  <div className="timeline-progress" style={{ width: `${getProgressPercent()}%` }} />
                </div>
                <span className="time-display">
                  {formatDuration(Math.floor(currentTime))} / {formatDuration(selectedRecording.duration || 0)}
                </span>
                <button className="control-btn" onClick={handleDownload}>💾 Download</button>
              </div>
            )}
          </div>
        </div>
      </main>
    </>
  );
}
