import React, { useState, useEffect } from 'react';
import api from '../services/api';
import Hls from 'hls.js';
import { captureSnapshot } from '../services/snapshot';

const hlsBaseUrl = (import.meta.env.VITE_HLS_BASE_URL || '/hls').replace(/\/$/, '');

function buildHlsManifestUrl(cameraId, cameraHlsBaseUrl) {
  const base = (cameraHlsBaseUrl || hlsBaseUrl).replace(/\/$/, '');
  return `${base}/${cameraId}/index.m3u8`;
}

const PAGE_CSS = `
  .streams-page { padding: 2rem; color: var(--text-primary, #e5eef7); }
  .streams-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 2rem; }
  .streams-title { font-family: 'Orbitron', sans-serif; font-size: 1.5rem; color: var(--text-primary, #dff5ff); }
  .streams-status-online { color: var(--accent-success, #00d450); font-size: .9rem; font-weight: 600; }
  .streams-status-offline { color: var(--accent-danger, #ff5050); font-size: .9rem; font-weight: 600; }
  .add-cam-btn { background: linear-gradient(135deg,#00d4ff,#8c4dff); color: #03101c; border: none; padding: .8rem 1.5rem; border-radius: 10px; font-family: 'Orbitron', sans-serif; font-size: .8rem; text-transform: uppercase; letter-spacing: .1em; cursor: pointer; }
  .streams-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(400px, 1fr)); gap: 1.5rem; }
  .stream-card { background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; overflow: hidden; transition: all .2s; }
  .stream-card:hover { border-color: rgba(0,212,255,.5); transform: translateY(-4px); }
  .stream-preview { height: 225px; background: #000; display: flex; align-items: center; justify-content: center; position: relative; }
  .stream-placeholder { font-size: 3rem; color: #6a8aaa; }
  .stream-status { position: absolute; top: .75rem; right: .75rem; padding: .25rem .6rem; border-radius: 10px; font-size: .7rem; font-weight: bold; }
  .stream-live { background: rgba(255,80,80,.8); color: white; animation: pulse-live 1.5s infinite; }
  @keyframes pulse-live { 0%, 100% { opacity: 1; } 50% { opacity: .7; } }
  .stream-info { padding: 1rem; }
  .stream-info h3 { color: var(--text-primary, #dff7ff); margin-bottom: .5rem; }
  .stream-meta { display: flex; gap: 1rem; color: #8ab0c9; font-size: .8rem; }
  .stream-meta span { display: flex; align-items: center; gap: .25rem; }
  .stream-actions { display: flex; gap: .5rem; padding: 1rem; padding-top: 0; }
  .stream-btn { flex: 1; padding: .6rem; border: none; border-radius: 8px; font-size: .8rem; cursor: pointer; transition: all .2s; }
  .stream-btn-primary { background: linear-gradient(135deg,var(--accent-primary, #00d4ff),var(--accent-secondary, #8c4dff)); color: #03101c; font-weight: bold; }
  .stream-btn-secondary { background: rgba(87,125,196,.2); color: var(--text-secondary, #8ab0c9); }
  .stream-btn:hover { filter: brightness(1.1); transform: translateY(-1px); }
  .empty-streams { text-align: center; padding: 4rem; background: rgba(10,18,38,.85); border: 1px solid rgba(87,140,255,.18); border-radius: 16px; }
  .empty-streams h2 { color: var(--text-primary, #dff7ff); font-size: 1.15rem; margin-bottom: 1rem; }
  .empty-streams p { color: var(--text-secondary, #8ab0c9); margin-bottom: 1.5rem; }

  /* Stream modal overlay */
  .stream-modal-overlay {
    position: fixed; top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,.9); display: flex; align-items: center; justify-content: center;
    z-index: 1000;
  }
  .stream-modal-content {
    background: #000; border-radius: 16px; padding: 1rem; max-width: 800px; width: 90%;
  }
  .stream-modal-video { width: 100%; height: auto; display: block; }
  .stream-modal-actions { display: flex; gap: .5rem; margin-top: 1rem; justify-content: flex-end; }
  .stream-snap-btn {
    padding: .6rem 1.2rem; border: none; border-radius: 8px; font-size: .8rem; cursor: pointer;
    background: rgba(0,212,255,.2); color: #00d4ff; border: 1px solid rgba(0,212,255,.4);
  }
  .stream-snap-btn:disabled { opacity: .5; cursor: not-allowed; }
  .stream-close-btn {
    padding: .6rem 1.2rem; border: none; border-radius: 8px; font-size: .8rem; cursor: pointer;
    background: rgba(87,125,196,.2); color: #8ab0c9;
  }
`;

export default function LiveStreams() {
  const [cameras, setCameras] = useState([]);
  const [loading, setLoading] = useState(true);
  const [viewingCamera, setViewingCamera] = useState(null);
  const [snapshotPending, setSnapshotPending] = useState(false);
  const [snapshotStatus, setSnapshotStatus] = useState({});

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

  const handleSnapshot = (camera) => {
    setViewingCamera(camera);
    setSnapshotPending(true);
    setSnapshotStatus({});
  };

  const handleViewStream = (camera) => {
    setViewingCamera(camera);
    setSnapshotPending(false);
    setSnapshotStatus({});
  };

  useEffect(() => {
    if (!viewingCamera) return;

    const video = document.getElementById(`video-${viewingCamera.id}`);
    if (!video) return;

    let hls;
    let cancelled = false;

    async function initStream() {
      if (cancelled) return;
      try {
        const tokenRes = await api.post('/camera-views', { camera_id: viewingCamera.id });
        const streamToken = tokenRes.data?.streamToken;
        if (!streamToken) {
          console.error('No stream token for camera:', viewingCamera.id);
          return;
        }
        const manifestUrl = `${buildHlsManifestUrl(viewingCamera.id, viewingCamera.hls_base_url)}?token=${encodeURIComponent(streamToken)}`;

        if (Hls.isSupported()) {
          hls = new Hls();
          hls.loadSource(manifestUrl);
          hls.attachMedia(video);
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
          video.src = manifestUrl;
        }
      } catch (err) {
        if (!cancelled) {
          console.error('Failed to initialize stream:', err.message);
        }
      }
    }

    video.addEventListener('canplay', () => {
      if (snapshotPending && !cancelled) {
        captureSnapshot(viewingCamera.id, {
          onStatus: (s) => setSnapshotStatus((prev) => ({ ...prev, [viewingCamera.id]: s })),
        }).catch((err) => {
          console.error('Snapshot error:', err.message);
          setSnapshotStatus((prev) => ({ ...prev, [viewingCamera.id]: 'error' }));
        });
        setSnapshotPending(false);
      }
    });

    initStream();

    return () => {
      cancelled = true;
      setSnapshotPending(false);
      if (hls) hls.destroy();
      if (video.src) video.src = '';
    };
  }, [viewingCamera]);

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="streams-page">
        <div className="streams-header">
          <h1 className="streams-title">📹 Live Camera Streams</h1>
          <span style={{ color: 'var(--accent-success, #00d450)', fontSize: '.9rem' }}>
            {cameras.filter(c => c.enabled !== false).length} cameras online
          </span>
        </div>

        {loading ? (
          <div className="empty-streams">
            <p>Loading cameras...</p>
          </div>
        ) : cameras.length === 0 ? (
          <div className="empty-streams">
            <h2>No Active Streams</h2>
            <p>Configure cameras in the Dashboard to start streaming.</p>
          </div>
        ) : (
          <div className="streams-grid">
            {cameras.map(camera => (
              <div key={camera.id} className="stream-card">
                <div className="stream-preview">
                  <div className="stream-placeholder">📹</div>
                  {camera.enabled !== false && (
                    <span className="stream-status stream-live">LIVE</span>
                  )}
                </div>
                <div className="stream-info">
                  <h3>{camera.name}</h3>
                  <div className="stream-meta">
                    <span>📍 {camera.location || 'No location'}</span>
                    <span>{camera.fps || 0} FPS</span>
                  </div>
                </div>
                <div className="stream-actions">
                  <button
                    className="stream-btn stream-btn-secondary"
                    onClick={() => handleSnapshot(camera)}
                    disabled={snapshotStatus[camera.id] === 'capturing'}
                  >
                    {snapshotStatus[camera.id] === 'capturing' ? 'Capturing...' :
                     snapshotStatus[camera.id] === 'success' ? 'Snapshot saved' :
                     snapshotStatus[camera.id] === 'error' ? 'Snapshot failed' : 'Snapshot'}
                  </button>
                  <button className="stream-btn stream-btn-primary" onClick={() => handleViewStream(camera)}>
                    View Stream
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        {viewingCamera && (
          <div className="stream-modal-overlay" onClick={() => setViewingCamera(null)}>
            <div className="stream-modal-content" onClick={e => e.stopPropagation()}>
              <video
                id={`video-${viewingCamera.id}`}
                className="stream-modal-video"
                controls
                autoPlay
                playsInline
                muted
              />
              <div className="stream-modal-actions">
                <button
                  type="button"
                  className="stream-close-btn"
                  onClick={() => setViewingCamera(null)}
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        )}
      </main>
    </>
  );
}
