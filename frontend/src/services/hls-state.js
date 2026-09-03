/**
 * HLS Live playback state machine.
 *
 * Derives a single high-level state from a stream of hls.js events
 * (`MEDIA_ATTACHED`, `MANIFEST_PARSED`, `LEVEL_LOADED`, `FRAG_LOADED`,
 * `ERROR`) and HTMLMediaElement events (`playing`, `waiting`,
 * `stalled`, `error`). The Dashboard uses this to render an honest
 * "Loading / Buffering / Live / Error" indicator on every camera
 * card. A `blob:` URL or a successful `MANIFEST_PARSED` is NOT
 * considered proof of playback — only an actual `playing` event
 * after at least one fragment has been loaded promotes to `live`.
 *
 * Pure functions, no React, no DOM. Easy to unit-test.
 *
 * State graph:
 *
 *   loading ─MANIFEST_PARSED─► buffering
 *   loading ─fatal error────► error
 *   buffering ─FRAG_LOADED + playing─► live
 *   buffering ─fatal error─► error
 *   live ─video waiting/stalled─► buffering
 *   live ─fatal error─────► error
 *   error ─recovery event (startLoad)─► buffering
 */

export const HLS_STATE = Object.freeze({
  LOADING: 'loading',
  BUFFERING: 'buffering',
  LIVE: 'live',
  ERROR: 'error',
});

// Event name constants — these mirror hls.js's Hls.Events values and
// the HTMLMediaElement event names we care about.
export const HLS_EVENT = Object.freeze({
  MEDIA_ATTACHED: 'hlsMediaAttached',
  MANIFEST_PARSED: 'hlsManifestParsed',
  LEVEL_LOADED: 'hlsLevelLoaded',
  FRAG_LOADED: 'hlsFragLoaded',
  ERROR: 'hlsError',
  // HTMLMediaElement events
  PLAYING: 'playing',
  WAITING: 'waiting',
  STALLED: 'stalled',
  ERROR_VIDEO: 'error',
  // Internal / synthetic
  RECOVERY: '__recovery',
  AUTOPLAY_REJECTED: '__autoplayRejected',
});

const TERMINAL_RECOVERY_TYPES = new Set([
  'mediaError',
  'networkError',
  'levelSwitchError',
]);

/**
 * Initial state for a new camera. Always `loading`.
 */
export function initialHlsState() {
  return {
    state: HLS_STATE.LOADING,
    errorMessage: null,
    errorDetails: null,
    fragmentsLoaded: 0,
    levelsLoaded: 0,
    manifestParsed: false,
    mediaAttached: false,
  };
}

/**
 * Reducer: apply one event to the current state and return the next.
 *
 * @param {object} prev  - Current HlsStateValue from initialHlsState()
 * @param {string} type  - One of HLS_EVENT.* constants
 * @param {object} [data] - Optional payload (hls.js data, video error, etc.)
 * @returns {object} Next state (NEW object — never mutate)
 */
export function reduceHlsEvent(prev, type, data) {
  switch (type) {
    case HLS_EVENT.MEDIA_ATTACHED: {
      // hls.js is wired to the <video> element. Stays in loading until
      // the manifest arrives.
      return { ...prev, mediaAttached: true };
    }

    case HLS_EVENT.MANIFEST_PARSED: {
      // Manifest is available. We're no longer "loading the manifest",
      // but we have NOT yet verified that frames decode and play. Stay
      // in buffering until at least one fragment lands AND the video
      // element fires `playing`.
      if (prev.state === HLS_STATE.ERROR) {
        // Defensive: ignore stale manifest events after a fatal error.
        return prev;
      }
      return {
        ...prev,
        manifestParsed: true,
        state: HLS_STATE.BUFFERING,
        errorMessage: null,
        errorDetails: null,
      };
    }

    case HLS_EVENT.LEVEL_LOADED: {
      return { ...prev, levelsLoaded: prev.levelsLoaded + 1 };
    }

    case HLS_EVENT.FRAG_LOADED: {
      // A fragment is in. We're definitely past "loading the manifest",
      // but still need a `playing` event to be considered live.
      const next = { ...prev, fragmentsLoaded: prev.fragmentsLoaded + 1 };
      if (prev.state === HLS_STATE.LIVE) {
        return next;
      }
      // Buffering is the safest fallback — promotion to LIVE happens
      // when the <video> element fires `playing`.
      if (prev.state === HLS_STATE.LOADING || prev.state === HLS_STATE.BUFFERING) {
        return { ...next, state: HLS_STATE.BUFFERING };
      }
      return next;
    }

    case HLS_EVENT.PLAYING: {
      // Real playback started. Promote to LIVE only if we have evidence
      // of an actual media segment being fetched (FRAG_LOADED or
      // LEVEL_LOADED). Without at least one segment we would be
      // declaring "live" on a still-buffering pre-roll.
      if (prev.fragmentsLoaded > 0 || prev.levelsLoaded > 0) {
        if (prev.state === HLS_STATE.LIVE) return prev;
        return {
          ...prev,
          state: HLS_STATE.LIVE,
          errorMessage: null,
          errorDetails: null,
        };
      }
      // No segment yet — keep buffering.
      return prev;
    }

    case HLS_EVENT.WAITING:
    case HLS_EVENT.STALLED: {
      // Stalled mid-stream. We were probably live; now we wait.
      if (prev.state === HLS_STATE.LIVE) {
        return { ...prev, state: HLS_STATE.BUFFERING };
      }
      return prev;
    }

    case HLS_EVENT.ERROR: {
      // hls.js ERROR event has shape: { type, details, fatal, error? }
      const fatal = !!(data && data.fatal);
      if (!fatal) {
        // Non-fatal: hls.js will retry on its own. Stay where we are.
        return prev;
      }
      return {
        ...prev,
        state: HLS_STATE.ERROR,
        errorMessage: humanErrorMessage(data),
        errorDetails: (data && (data.details || data.type)) || 'fatal HLS error',
      };
    }

    case HLS_EVENT.ERROR_VIDEO: {
      // <video> element's own error event. The MediaError code tells
      // us why; map it to a readable string.
      const code = data && data.code;
      const message = code ? `Video element error (code ${code})` : 'Video element error';
      return {
        ...prev,
        state: HLS_STATE.ERROR,
        errorMessage: message,
        errorDetails: data && data.message ? String(data.message) : null,
      };
    }

    case HLS_EVENT.RECOVERY: {
      // hls.js is about to call startLoad() after a fatal error.
      // Surface a transient buffering state and clear the error.
      return {
        ...prev,
        state: HLS_STATE.BUFFERING,
        errorMessage: null,
        errorDetails: null,
      };
    }

    case HLS_EVENT.AUTOPLAY_REJECTED: {
      // Browser refused to autoplay. This is not fatal — the user can
      // click play. We report it as a buffering state with a hint.
      return {
        ...prev,
        state: HLS_STATE.BUFFERING,
        errorMessage: 'Autoplay was blocked by the browser. Click the video to start playback.',
        errorDetails: 'autoplay_rejected',
      };
    }

    default:
      return prev;
  }
}

/**
 * Decide whether a fatal HLS error should be auto-recovered.
 * hls.js's default error handler does this; we surface the same logic
 * so tests can assert it without spinning up a real hls.js instance.
 */
export function shouldAutoRecover(data) {
  if (!data || !data.fatal) return false;
  return TERMINAL_RECOVERY_TYPES.has(data.type);
}

/**
 * Convert a hls.js error payload into a human-readable message that
 * the Dashboard can show in the "Error" badge.
 */
export function humanErrorMessage(data) {
  if (!data || (!data.type && !data.details)) return 'Stream unavailable';
  const detail = data.details || data.type;
  switch (data.type) {
    case 'networkError':
      return 'Network error — the media server is unreachable.';
    case 'mediaError':
      return 'Media error — the stream is corrupted or unsupported.';
    case 'levelSwitchError':
      return 'Stream variant error.';
    case 'manifestLoadError':
      return 'Could not load the stream manifest.';
    case 'manifestLoadTimeOut':
      return 'Stream manifest request timed out.';
    case 'fragLoadError':
      return 'A media segment failed to download.';
    case 'fragLoadTimeOut':
      return 'A media segment request timed out.';
    case 'bufferIncompatibleCodecsError':
      return 'The browser cannot decode this stream.';
    default:
      return `Stream unavailable (${detail || 'unknown'}).`;
  }
}

/**
 * Convenience: derive a `data-fatal` discriminator for hls.js ERROR
 * events. Centralized so tests can construct payloads with a single
 * helper.
 */
export function fatalError(type, details) {
  return { fatal: true, type, details };
}
