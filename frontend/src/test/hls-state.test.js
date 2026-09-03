/**
 * Unit tests for the HLS playback state machine.
 *
 * The reducer is pure (no React, no DOM), so we exercise the
 * full event sequence the Dashboard feeds into it: MEDIA_ATTACHED,
 * MANIFEST_PARSED, LEVEL_LOADED, FRAG_LOADED, ERROR, PLAYING,
 * WAITING, STALLED, ERROR_VIDEO, RECOVERY, AUTOPLAY_REJECTED.
 *
 * Required coverage (per task spec):
 *   - Loading state
 *   - Manifest parsed but not playing  -> Buffering
 *   - Actual playback                  -> Live
 *   - Fatal error                      -> Error
 *   - Recovery Error/Buffering         -> Live
 *   - Autoplay rejection handled
 */
import { describe, it, expect } from 'vitest';
import {
  HLS_STATE,
  HLS_EVENT,
  initialHlsState,
  reduceHlsEvent,
  humanErrorMessage,
  fatalError,
  shouldAutoRecover,
} from '../services/hls-state';

describe('initialHlsState', () => {
  it('starts in loading with no error', () => {
    const s = initialHlsState();
    expect(s.state).toBe(HLS_STATE.LOADING);
    expect(s.errorMessage).toBeNull();
    expect(s.errorDetails).toBeNull();
    expect(s.fragmentsLoaded).toBe(0);
  });
});

describe('loading → buffering transition', () => {
  it('MEDIA_ATTACHED alone does not leave loading', () => {
    const s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MEDIA_ATTACHED);
    expect(s.state).toBe(HLS_STATE.LOADING);
  });

  it('MANIFEST_PARSED alone promotes loading -> buffering', () => {
    const s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    expect(s.state).toBe(HLS_STATE.BUFFERING);
    expect(s.manifestParsed).toBe(true);
  });

  it('MANIFEST_PARSED does NOT promote straight to live', () => {
    // This is the core invariant the user called out: a manifest
    // being available is not proof of playback.
    const s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    expect(s.state).not.toBe(HLS_STATE.LIVE);
  });
});

describe('buffering → live', () => {
  it('a single FRAG_LOADED keeps us buffering (no playing yet)', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    expect(s.state).toBe(HLS_STATE.BUFFERING);
    expect(s.fragmentsLoaded).toBe(1);
  });

  it('PLAYING without any FRAG_LOADED does NOT promote to live', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    expect(s.state).not.toBe(HLS_STATE.LIVE);
  });

  it('PLAYING after FRAG_LOADED promotes to live', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    expect(s.state).toBe(HLS_STATE.LIVE);
  });

  it('PLAYING after LEVEL_LOADED also promotes to live', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.LEVEL_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    expect(s.state).toBe(HLS_STATE.LIVE);
  });

  it('full happy path: attach -> manifest -> frag -> playing -> live', () => {
    let s = initialHlsState();
    s = reduceHlsEvent(s, HLS_EVENT.MEDIA_ATTACHED);
    expect(s.state).toBe(HLS_STATE.LOADING);
    s = reduceHlsEvent(s, HLS_EVENT.MANIFEST_PARSED);
    expect(s.state).toBe(HLS_STATE.BUFFERING);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    expect(s.state).toBe(HLS_STATE.BUFFERING);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    expect(s.state).toBe(HLS_STATE.LIVE);
  });
});

describe('live → buffering (stalled / waiting)', () => {
  it('WAITING demotes live back to buffering', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    expect(s.state).toBe(HLS_STATE.LIVE);
    s = reduceHlsEvent(s, HLS_EVENT.WAITING);
    expect(s.state).toBe(HLS_STATE.BUFFERING);
  });

  it('STALLED demotes live back to buffering', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    s = reduceHlsEvent(s, HLS_EVENT.STALLED);
    expect(s.state).toBe(HLS_STATE.BUFFERING);
  });

  it('a new FRAG_LOADED while live keeps live', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    expect(s.state).toBe(HLS_STATE.LIVE);
  });

  it('PLAYING again after stall re-promotes to live', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    s = reduceHlsEvent(s, HLS_EVENT.WAITING);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    expect(s.state).toBe(HLS_STATE.LIVE);
  });
});

describe('fatal error → error', () => {
  it('fatal hls.js ERROR (networkError) -> error with human message', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    s = reduceHlsEvent(s, HLS_EVENT.ERROR, fatalError('networkError', 'manifestLoadError'));
    expect(s.state).toBe(HLS_STATE.ERROR);
    expect(s.errorMessage).toMatch(/network/i);
    expect(s.errorDetails).toBe('manifestLoadError');
  });

  it('fatal hls.js ERROR (mediaError) -> error with media message', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    s = reduceHlsEvent(s, HLS_EVENT.ERROR, fatalError('mediaError', 'bufferIncompatibleCodecsError'));
    expect(s.state).toBe(HLS_STATE.ERROR);
    expect(s.errorMessage).toMatch(/media/i);
  });

  it('non-fatal hls.js ERROR does NOT change state', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    const before = { ...s };
    s = reduceHlsEvent(s, HLS_EVENT.ERROR, { fatal: false, type: 'fragLoadError' });
    expect(s.state).toBe(before.state);
  });

  it('<video> error event -> error with code', () => {
    const s = reduceHlsEvent(
      reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED),
      HLS_EVENT.ERROR_VIDEO,
      { code: 4, message: 'MEDIA_ERR_SRC_NOT_SUPPORTED' },
    );
    expect(s.state).toBe(HLS_STATE.ERROR);
    expect(s.errorMessage).toMatch(/code 4/);
    expect(s.errorDetails).toBe('MEDIA_ERR_SRC_NOT_SUPPORTED');
  });
});

describe('recovery: error -> buffering -> live', () => {
  it('RECOVERY event from error returns to buffering', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    s = reduceHlsEvent(s, HLS_EVENT.ERROR, fatalError('networkError', 'fragLoadError'));
    expect(s.state).toBe(HLS_STATE.ERROR);
    s = reduceHlsEvent(s, HLS_EVENT.RECOVERY);
    expect(s.state).toBe(HLS_STATE.BUFFERING);
    expect(s.errorMessage).toBeNull();
  });

  it('after RECOVERY, a new FRAG_LOADED + PLAYING re-promotes to live', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    s = reduceHlsEvent(s, HLS_EVENT.ERROR, fatalError('networkError', 'fragLoadError'));
    s = reduceHlsEvent(s, HLS_EVENT.RECOVERY);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    expect(s.state).toBe(HLS_STATE.LIVE);
  });
});

describe('autoplay rejection', () => {
  it('AUTOPLAY_REJECTED moves loading -> buffering with hint', () => {
    const s = reduceHlsEvent(initialHlsState(), HLS_EVENT.AUTOPLAY_REJECTED);
    expect(s.state).toBe(HLS_STATE.BUFFERING);
    expect(s.errorMessage).toMatch(/[Aa]utoplay/);
    expect(s.errorDetails).toBe('autoplay_rejected');
  });

  it('user clicking play afterwards (PLAYING) promotes to live', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.AUTOPLAY_REJECTED);
    expect(s.state).toBe(HLS_STATE.BUFFERING);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    expect(s.state).toBe(HLS_STATE.LIVE);
  });
});

describe('stale events after a fatal error are ignored', () => {
  it('a stale MANIFEST_PARSED after error does not flip to buffering', () => {
    let s = reduceHlsEvent(initialHlsState(), HLS_EVENT.MANIFEST_PARSED);
    s = reduceHlsEvent(s, HLS_EVENT.FRAG_LOADED);
    s = reduceHlsEvent(s, HLS_EVENT.PLAYING);
    s = reduceHlsEvent(s, HLS_EVENT.ERROR, fatalError('mediaError'));
    expect(s.state).toBe(HLS_STATE.ERROR);
    s = reduceHlsEvent(s, HLS_EVENT.MANIFEST_PARSED);
    expect(s.state).toBe(HLS_STATE.ERROR);
  });
});

describe('shouldAutoRecover', () => {
  it('true for mediaError and networkError (hls.js default behavior)', () => {
    expect(shouldAutoRecover(fatalError('mediaError'))).toBe(true);
    expect(shouldAutoRecover(fatalError('networkError'))).toBe(true);
  });
  it('false for non-fatal or unknown types', () => {
    expect(shouldAutoRecover({ fatal: false, type: 'mediaError' })).toBe(false);
    expect(shouldAutoRecover(fatalError('otherError'))).toBe(false);
    expect(shouldAutoRecover(null)).toBe(false);
  });
});

describe('humanErrorMessage', () => {
  it('returns a sensible default when payload is empty', () => {
    expect(humanErrorMessage(null)).toBe('Stream unavailable');
    expect(humanErrorMessage({})).toBe('Stream unavailable');
  });
  it('includes details for unknown error types', () => {
    expect(humanErrorMessage({ type: 'mysteryError', details: 'wut' }))
      .toMatch(/mysteryError|wut/);
  });
});

describe('immutability', () => {
  it('reducer returns a new state object (never mutates)', () => {
    const s0 = initialHlsState();
    const s1 = reduceHlsEvent(s0, HLS_EVENT.MANIFEST_PARSED);
    expect(s0.state).toBe('loading');
    expect(s1.state).toBe('buffering');
    expect(s0).not.toBe(s1);
  });
});
