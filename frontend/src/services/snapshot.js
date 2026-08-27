import api from './api';

/**
 * Capture a still frame from a camera's <video> element via Canvas
 * and upload it to the backend snapshot endpoint.
 *
 * The <video> element must carry id={`video-${cameraId}`} — this is
 * the convention used by both Dashboard.jsx and LiveStreams.jsx.
 *
 * @param {string} cameraId  — camera id (matches the video element id suffix)
 * @param {object} [opts]    — optional callbacks for live UI feedback
 * @param {function} [opts.onStatus] — called with 'capturing' | 'success' | 'error'
 * @returns {Promise<object>}        — { id, taken_at, storage_url } from the API
 * @throws  when no video frame is available or the upload fails.
 */
export async function captureSnapshot(cameraId, { onStatus } = {}) {
  const video = document.getElementById(`video-${cameraId}`);
  if (!video || video.readyState < 2) {
    throw new Error('No video frame available — start the stream first');
  }

  onStatus?.('capturing');

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

  const dataUrl = canvas.toDataURL('image/jpeg', 0.9);
  const base64 = dataUrl.split(',')[1];

  try {
    const res = await api.post('/snapshots', { camera_id: cameraId, image_base64: base64 });
    onStatus?.('success');
    return res.data.snapshot;
  } catch (err) {
    onStatus?.('error');
    throw err;
  }
}

export default captureSnapshot;
