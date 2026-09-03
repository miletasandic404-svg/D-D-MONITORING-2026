/**
 * MapPanel tests.
 *
 * MapPanel is a Leaflet-backed component. jsdom does not provide a
 * real layout engine, so the full Leaflet pipeline (tile fetches,
 * canvas / SVG rendering, popup positioning) cannot run here. We
 * therefore mock `leaflet` and assert on the public API surface:
 *   - which cameras are passed to L.marker
 *   - which cameras are excluded (null / 0,0)
 *   - what popup HTML is bound
 *   - what the click handler does
 *   - that the map is created on mount and destroyed on unmount
 *   - the isValidCoord / hasValidCoord pure helper
 *
 * The visual rendering (tiles, popups, marker icons) is covered
 * manually in the deployed dashboard and by the Vite production
 * build succeeding.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, act, cleanup } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';

// Hoisted mock so we can inspect the leaflet API surface.
const leafletMock = vi.hoisted(() => {
  const makeLayer = () => ({
    addTo: vi.fn(function (parent) { this._parent = parent; return this; }),
    clearLayers: vi.fn(),
  });
  const map = {
    _layers: {},
    _handlers: [],
    _listeners: {},
    setView: vi.fn(),
    flyTo: vi.fn(),
    fitBounds: vi.fn(),
    remove: vi.fn(),
    on: vi.fn(function (ev, cb) { (this._listeners[ev] = this._listeners[ev] || []).push(cb); return this; }),
    off: vi.fn(),
    getCenter: vi.fn(() => ({ lat: 0, lng: 0 })),
    getZoom: vi.fn(() => 2),
  };
  const tileLayer = makeLayer();
  const markerInstances = [];
  const makeMarker = (latLng, opts = {}) => {
    const inst = {
      _latLng: latLng,
      _opts: opts,
      _popupHtml: null,
      _open: false,
      on: vi.fn(function (ev, cb) { (this._listeners = this._listeners || {})[ev] = (this._listeners[ev] || []).concat(cb); return this; }),
      bindPopup: vi.fn(function (html) { this._popupHtml = html; return this; }),
      openPopup: vi.fn(function () { this._open = true; return this; }),
      closePopup: vi.fn(),
      addTo: vi.fn(function (parent) { this._parent = parent; return this; }),
      getElement: vi.fn(() => null),
    };
    markerInstances.push(inst);
    return inst;
  };
  const layerGroup = makeLayer();
  const latLngBounds = (latLngs) => ({
    isValid: () => latLngs.length > 0,
    pad: (p) => ({ isValid: () => true }),
  });
  const L = {
    map: vi.fn(() => map),
    tileLayer: vi.fn(() => tileLayer),
    layerGroup: vi.fn(() => layerGroup),
    marker: vi.fn(makeMarker),
    latLngBounds: vi.fn(latLngBounds),
    Icon: { Default: { mergeOptions: vi.fn(), prototype: { _getIconUrl: undefined } } },
    DomEvent: { disableClickPropagation: vi.fn() },
  };
  return { L, map, tileLayer, layerGroup, markerInstances, makeMarker };
});

vi.mock('leaflet', () => ({ default: leafletMock.L }));
vi.mock('leaflet/dist/leaflet.css', () => ({}));

import MapPanel, { hasValidCoord, CARTO_TILE_URL } from '../components/dashboard/MapPanel.jsx';

beforeEach(() => {
  leafletMock.L.map.mockClear();
  leafletMock.L.tileLayer.mockClear();
  leafletMock.L.layerGroup.mockClear();
  leafletMock.L.marker.mockClear();
  leafletMock.L.latLngBounds.mockClear();
  leafletMock.markerInstances.length = 0;
  leafletMock.map.remove.mockClear();
  leafletMock.map.fitBounds.mockClear();
  leafletMock.map.flyTo.mockClear();
  cleanup();
});

describe('MapPanel — coordinate validation', () => {
  it('accepts a valid camera with finite numeric lat/lng', () => {
    expect(hasValidCoord({ id: 'a', lat: 45.26, lng: 19.83 })).toBe(true);
  });
  it('accepts numeric strings', () => {
    expect(hasValidCoord({ id: 'a', lat: '45.26', lng: '19.83' })).toBe(true);
  });
  it('rejects missing lat', () => {
    expect(hasValidCoord({ id: 'a', lng: 19.83 })).toBe(false);
  });
  it('rejects missing lng', () => {
    expect(hasValidCoord({ id: 'a', lat: 45.26 })).toBe(false);
  });
  it('rejects null lat/lng', () => {
    expect(hasValidCoord({ id: 'a', lat: null, lng: null })).toBe(false);
  });
  it('rejects undefined', () => {
    expect(hasValidCoord({ id: 'a', lat: undefined, lng: undefined })).toBe(false);
  });
  it('rejects empty-string coordinates', () => {
    expect(hasValidCoord({ id: 'a', lat: '', lng: '' })).toBe(false);
  });
  it('rejects NaN', () => {
    expect(hasValidCoord({ id: 'a', lat: NaN, lng: 19.83 })).toBe(false);
  });
  it('rejects (0, 0) — Null Island is a sentinel for "no coordinates" in this product', () => {
    expect(hasValidCoord({ id: 'a', lat: 0, lng: 0 })).toBe(false);
  });
  it('rejects a non-object', () => {
    expect(hasValidCoord(null)).toBe(false);
    expect(hasValidCoord(undefined)).toBe(false);
  });
});

describe('MapPanel — rendering', () => {
  it('creates exactly one L.map and one tile layer on mount', async () => {
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={[]} /></MemoryRouter>);
    });
    expect(leafletMock.L.map).toHaveBeenCalledTimes(1);
    expect(leafletMock.L.tileLayer).toHaveBeenCalledTimes(1);
    expect(leafletMock.L.tileLayer.mock.calls[0][0]).toBe(CARTO_TILE_URL);
    // Tile layer options must declare the a/b/c/d subdomains so
    // Leaflet can parallelise requests against the four CARTO CDN
    // endpoints; this is what makes the {s}. placeholder in
    // CARTO_TILE_URL actually resolve.
    const tileOpts = leafletMock.L.tileLayer.mock.calls[0][1] || {};
    expect(tileOpts.subdomains).toBe('abcd');
    expect(typeof tileOpts.attribution).toBe('string');
    expect(tileOpts.attribution).toMatch(/openstreetmap/i);
  });

  it('renders a marker for a valid camera', async () => {
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={[{ id: 'cam-1', name: 'Front', lat: 45.26, lng: 19.83 }]} /></MemoryRouter>);
    });
    expect(leafletMock.L.marker).toHaveBeenCalledTimes(1);
    const call = leafletMock.L.marker.mock.calls[0];
    expect(call[0]).toEqual([45.26, 19.83]);
  });

  it('renders markers for every valid camera in the list', async () => {
    const cameras = [
      { id: 'c1', name: 'A', lat: 45.26, lng: 19.83 },
      { id: 'c2', name: 'B', lat: 46.0,  lng: 20.0  },
      { id: 'c3', name: 'C', lat: 47.0,  lng: 21.0  },
    ];
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={cameras} /></MemoryRouter>);
    });
    expect(leafletMock.L.marker).toHaveBeenCalledTimes(3);
  });

  it('excludes cameras with missing coordinates', async () => {
    const cameras = [
      { id: 'c1', name: 'A', lat: 45.26, lng: 19.83 },
      { id: 'c2', name: 'B' /* no lat/lng */ },
      { id: 'c3', name: 'C', lat: null, lng: null },
    ];
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={cameras} /></MemoryRouter>);
    });
    expect(leafletMock.L.marker).toHaveBeenCalledTimes(1);
    expect(leafletMock.L.marker.mock.calls[0][0]).toEqual([45.26, 19.83]);
  });

  it('excludes (0, 0) cameras', async () => {
    const cameras = [
      { id: 'c0', name: 'Zero', lat: 0, lng: 0 },
      { id: 'c1', name: 'Real', lat: 45.26, lng: 19.83 },
    ];
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={cameras} /></MemoryRouter>);
    });
    expect(leafletMock.L.marker).toHaveBeenCalledTimes(1);
    expect(leafletMock.L.marker.mock.calls[0][0]).toEqual([45.26, 19.83]);
  });

  it('renders no markers when no camera has coordinates', async () => {
    const cameras = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B', lat: null, lng: null },
    ];
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={cameras} /></MemoryRouter>);
    });
    expect(leafletMock.L.marker).not.toHaveBeenCalled();
  });
});

describe('MapPanel — popup', () => {
  it('binds a popup that contains the camera name and id', async () => {
    const cameras = [{ id: 'cam-42', name: 'Loading Dock', lat: 45.26, lng: 19.83 }];
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={cameras} /></MemoryRouter>);
    });
    const marker = leafletMock.markerInstances[0];
    expect(marker.bindPopup).toHaveBeenCalledTimes(1);
    const html = marker._popupHtml;
    expect(html).toContain('Loading Dock');
    expect(html).toContain('cam-42');
  });

  it('escapes HTML in the camera name to prevent XSS via popup', async () => {
    const cameras = [{ id: 'evil', name: '<script>alert(1)</script>', lat: 0, lng: 0 }];
    // The (0,0) camera is excluded, so we use a real one with a
    // hostile name to assert the escapeHtml path.
    cameras[0].lat = 45.26; cameras[0].lng = 19.83;
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={cameras} /></MemoryRouter>);
    });
    const marker = leafletMock.markerInstances[0];
    expect(marker._popupHtml).not.toContain('<script>');
    expect(marker._popupHtml).toContain('&lt;script&gt;');
  });
});

describe('MapPanel — selection', () => {
  it('calls onSelectCamera with the clicked camera', async () => {
    const onSelect = vi.fn();
    const cameras = [{ id: 'cam-1', name: 'A', lat: 45.26, lng: 19.83 }];
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={cameras} onSelectCamera={onSelect} /></MemoryRouter>);
    });
    const marker = leafletMock.markerInstances[0];
    const clickHandlers = marker._listeners && marker._listeners.click;
    expect(clickHandlers && clickHandlers.length).toBeGreaterThan(0);
    await act(async () => {
      clickHandlers[0]();
    });
    expect(onSelect).toHaveBeenCalledWith(cameras[0]);
  });

  it('opens the popup automatically for the alarm camera', async () => {
    const cameras = [
      { id: 'alarm-1', name: 'Alarm', lat: 45.26, lng: 19.83 },
      { id: 'other-1', name: 'Other', lat: 46.0,  lng: 20.0 },
    ];
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={cameras} alarmCameraId="alarm-1" /></MemoryRouter>);
    });
    const alarmMarker = leafletMock.markerInstances.find((m) => m._latLng[0] === 45.26);
    const otherMarker = leafletMock.markerInstances.find((m) => m._latLng[0] === 46.0);
    expect(alarmMarker.openPopup).toHaveBeenCalled();
    expect(otherMarker.openPopup).not.toHaveBeenCalled();
  });
});

describe('MapPanel — fitBounds', () => {
  it('calls fitBounds when there are 2+ valid cameras', async () => {
    const cameras = [
      { id: 'a', lat: 45.26, lng: 19.83 },
      { id: 'b', lat: 46.0,  lng: 20.0 },
    ];
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={cameras} /></MemoryRouter>);
    });
    expect(leafletMock.map.fitBounds).toHaveBeenCalledTimes(1);
    expect(leafletMock.map.flyTo).not.toHaveBeenCalled();
  });
  it('calls flyTo (not fitBounds) when there is exactly 1 valid camera', async () => {
    const cameras = [{ id: 'a', lat: 45.26, lng: 19.83 }];
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={cameras} /></MemoryRouter>);
    });
    expect(leafletMock.map.flyTo).toHaveBeenCalledTimes(1);
    expect(leafletMock.map.flyTo.mock.calls[0][0]).toEqual([45.26, 19.83]);
    expect(leafletMock.map.flyTo.mock.calls[0][1]).toBe(14);
    expect(leafletMock.map.fitBounds).not.toHaveBeenCalled();
  });
  it('does not call flyTo/fitBounds when no camera has coordinates', async () => {
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={[{ id: 'a' }]} /></MemoryRouter>);
    });
    expect(leafletMock.map.flyTo).not.toHaveBeenCalled();
    expect(leafletMock.map.fitBounds).not.toHaveBeenCalled();
  });
});

describe('MapPanel — lifecycle', () => {
  it('calls map.remove() on unmount', async () => {
    const { unmount } = render(<MemoryRouter><MapPanel cameras={[]} /></MemoryRouter>);
    unmount();
    expect(leafletMock.map.remove).toHaveBeenCalled();
  });
  it('is robust to cameras prop being null/undefined', async () => {
    await act(async () => {
      render(<MemoryRouter><MapPanel cameras={null} /></MemoryRouter>);
    });
    expect(leafletMock.L.marker).not.toHaveBeenCalled();
    expect(leafletMock.map.flyTo).not.toHaveBeenCalled();
    expect(leafletMock.map.fitBounds).not.toHaveBeenCalled();
  });
});
