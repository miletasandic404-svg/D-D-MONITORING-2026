import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';

let TwoWayAudio;

describe('TwoWayAudio lifecycle', () => {
  let startResponse;

  beforeEach(async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUDIO_API_BASE_URL', 'http://audio.test');
    ({ default: TwoWayAudio } = await import('../components/TwoWayAudio'));
    startResponse = {};
    global.fetch = vi.fn((url) => {
      if (url.includes('/start?')) {
        return new Promise((resolve) => {
          startResponse.resolve = resolve;
        });
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) });
    });

    global.navigator.mediaDevices = {
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: vi.fn() }],
      })),
    };
    global.window.AudioContext = class {
      sampleRate = 8000;
      destination = {};
      createAnalyser() {
        return { fftSize: 0, frequencyBinCount: 1, getByteFrequencyData: vi.fn() };
      }
      createMediaStreamSource() {
        return { connect: vi.fn(), disconnect: vi.fn() };
      }
      createScriptProcessor() {
        return { onaudioprocess: null, connect: vi.fn(), disconnect: vi.fn() };
      }
      close() {
        return Promise.resolve();
      }
    };
    global.window.webkitAudioContext = global.window.AudioContext;
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('does not start duplicate sessions while the first start is pending', async () => {
    render(
      <TwoWayAudio
        cameraId="camera-1"
        cameraName="Camera 1"
        streamToken="redacted-test-token"
        capabilities={{ supported: true, protocol: 'optalk' }}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: /start listen/i }));
    const speakButton = screen.getByRole('button', { name: /hold to speak/i });
    fireEvent.mouseDown(speakButton);
    fireEvent.mouseDown(speakButton);

    await waitFor(() => expect(global.fetch).toHaveBeenCalledTimes(1));
    expect(global.fetch.mock.calls[0][0]).toContain('/start?');

    startResponse.resolve({ ok: true, status: 200, json: async () => ({ success: true }) });
  });
});
