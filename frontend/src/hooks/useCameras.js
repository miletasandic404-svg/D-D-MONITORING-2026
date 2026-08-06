import { useEffect, useMemo, useState } from 'react';
import Hls from 'hls.js';
import api from '../services/api';

function buildHlsManifestUrl(cameraId, cameraHlsBaseUrl) {
  const hlsBaseUrl = (import.meta.env.VITE_HLS_BASE_URL || '/hls').replace(/\/$/, '');
  const base = (cameraHlsBaseUrl || hlsBaseUrl).replace(/\/$/, '');
  return `${base}/${cameraId}/index.m3u8`;
}

export function useCameras(authChecked) {
  const [cameras, setCameras] = useState(null);
  const [camerasError, setCamerasError] = useState(null);
  const [streamErrors, setStreamErrors] = useState({});
  const [snapshotStatus, setSnapshotStatus] = useState({});
  const [talkdownActive, setTalkdownActive] = useState(null);

  // Fetch cameras once auth is confirmed
  useEffect(() => {
    if (!authChecked) return;

    api
      .get('/cameras')
      .then((res) => {
        setCameras(res.data.cameras || []);
        setCamerasError(null);
      })
      .catch((err) => {
        const backendMessage = err.response?.data?.error;
        setCamerasError(
          backendMessage ||
          (err.response
            ? `Camera service returned an error (HTTP ${err.response.status}).`
            : 'Could not reach the camera API. Check your network connection or API deployment.')
        );
        setCameras([]);
      });
  }, [authChecked]);

  // Initialize HLS for each camera video element
  useEffect(() => {
    if (!authChecked || !cameras) return undefined;

    let cancelled = false;
    const hlsInstances = [];
    const openViewLogIds = [];
    setStreamErrors({});

    const closeViewLog = (viewLogId) => {
      if (!viewLogId) return;
      api.patch(`/camera-views/${viewLogId}`).catch(() => {
        // Best-effort cleanup
      });
    };

    async function initCamera(cam) {
      const video = document.getElementById(`video-${cam.id}`);
      if (!video) return;

      let streamToken;
      let viewLogId;
      try {
        const res = await api.post('/camera-views', { camera_id: cam.id });
        
        if (!res.data?.success) {
          console.error('Camera views API failed:', res.data?.error);
          setStreamErrors((prev) => ({
            ...prev,
            [cam.id]: res.data?.error || 'Failed to start viewing session.',
          }));
          return;
        }
        
        streamToken = res.data?.streamToken;
        viewLogId = res.data?.viewLogId;
        
        if (!streamToken) {
          console.error('No stream token returned for camera:', cam.id, 'Response:', res.data);
          setStreamErrors((prev) => ({
            ...prev,
            [cam.id]: 'Stream token not received from server.',
          }));
          return;
        }
      } catch (err) {
        console.error('Camera views API error:', err.message, err.response?.data);
        if (cancelled) return;
        setStreamErrors((prev) => ({
          ...prev,
          [cam.id]: err.response?.status === 404
            ? 'You do not have access to this camera.'
            : 'Could not start a viewing session for this camera.',
        }));
        return;
      }
      if (cancelled) {
        closeViewLog(viewLogId);
        return;
      }
      openViewLogIds.push(viewLogId);

      const manifestUrl = `${buildHlsManifestUrl(cam.id, cam.hls_base_url)}?token=${encodeURIComponent(streamToken)}`;
      console.log('HLS URL for camera', cam.id, ':', manifestUrl);

      if (Hls.isSupported()) {
        const hls = new Hls();
        hls.on(Hls.Events.ERROR, (_event, data) => {
          if (!data.fatal) return;
          setStreamErrors((prev) => ({
            ...prev,
            [cam.id]: 'Stream unavailable. Check that the media server is running and reachable.',
          }));
        });
        hls.loadSource(manifestUrl);
        hls.attachMedia(video);
        hlsInstances.push(hls);
      } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
        video.src = manifestUrl;
        video.addEventListener('error', () => {
          setStreamErrors((prev) => ({
            ...prev,
            [cam.id]: 'Stream unavailable. Check that the media server is running and reachable.',
          }));
        });
      } else {
        setStreamErrors((prev) => ({
          ...prev,
          [cam.id]: 'This browser does not support HLS playback.',
        }));
      }
    }

    cameras.forEach((cam) => {
      if (cam.enabled === false) return;
      initCamera(cam);
    });

    return () => {
      cancelled = true;
      hlsInstances.forEach((hls) => hls.destroy());
      openViewLogIds.forEach(closeViewLog);
    };
  }, [cameras, authChecked]);

  const activeCameras = useMemo(
    () => (cameras ? cameras.filter((camera) => camera.enabled !== false).length : 0),
    [cameras],
  );

  const takeSnapshot = async (camId) => {
    const video = document.getElementById(`video-${camId}`);
    if (!video || video.readyState < 2) {
      setSnapshotStatus((prev) => ({ ...prev, [camId]: 'error' }));
      setTimeout(() => setSnapshotStatus((prev) => ({ ...prev, [camId]: null })), 3000);
      return;
    }

    setSnapshotStatus((prev) => ({ ...prev, [camId]: 'capturing' }));
    try {
      const canvas = document.createElement('canvas');
      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      const imageBase64 = canvas.toDataURL('image/jpeg', 0.9);

      await api.post('/snapshots', { camera_id: camId, image_base64: imageBase64 });
      setSnapshotStatus((prev) => ({ ...prev, [camId]: 'success' }));
    } catch (err) {
      console.error('Snapshot capture error:', err);
      setSnapshotStatus((prev) => ({ ...prev, [camId]: 'error' }));
    } finally {
      setTimeout(() => setSnapshotStatus((prev) => ({ ...prev, [camId]: null })), 3000);
    }
  };

  const triggerTalkdown = (camId) => {
    setTalkdownActive(camId);
    setTimeout(() => setTalkdownActive(null), 5000);
  };

  const submitAddCamera = async (addCamForm, setAddCamForm, setShowAddCam, setAddCamError, addAuditEntry) => {
    if (!addCamForm.name.trim() || !addCamForm.rtsp_url.trim()) {
      setAddCamError('Camera name and RTSP URL are required.');
      return;
    }
    const id = `CAM-${String((cameras?.length || 0) + 1).padStart(2, '0')}`;
    const newCam = {
      id,
      name: addCamForm.name.trim(),
      rtsp_url: addCamForm.rtsp_url.trim(),
      location: addCamForm.location.trim() || id,
      lat: addCamForm.lat ? Number(addCamForm.lat) : null,
      lng: addCamForm.lng ? Number(addCamForm.lng) : null,
      enabled: true,
      resolution: '1920x1080',
      fps: 30,
      codec: 'H264',
    };
    try {
      await api.post('/cameras', newCam);
      setCameras((prev) => [...(prev || []), newCam]);
      setAddCamForm({ name: '', rtsp_url: '', location: '', lat: '', lng: '' });
      setShowAddCam(false);
      addAuditEntry(`Added camera: ${newCam.name} (${id})`);
    } catch (err) {
      setAddCamError(err?.response?.data?.error || err.message || 'Failed to save camera.');
    }
  };

  return {
    cameras,
    camerasError,
    streamErrors,
    snapshotStatus,
    talkdownActive,
    activeCameras,
    takeSnapshot,
    triggerTalkdown,
    submitAddCamera,
  };
}
