/**
 * MapPanel — real global interactive map for the Dashboard.
 *
 * Replaces the prior hand-rolled CSS/DIV "map" that hard-coded a
 * 0.06°×0.03° box around lat 45.80, lng 15.94 (≈ central Croatia)
 * and could only render a single static pin.
 *
 * Implementation notes:
 *   - Leaflet 1.9.x (BSD-2-Clause). No react-leaflet wrapper — the
 *     surface area we need (one map, one tile layer, a set of
 *     Markers, fitBounds, click handler) is small enough that a
 *     direct L.map() instance is clearer and avoids a second
 *     dependency.
 *   - Tiles come from CARTO's public basemap CDN
 *     ({a,b,c,d}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png). This
 *     provider serves OpenStreetMap-derived raster tiles, is keyless,
 *     has no per-request token, has a stable production SLA, and is the
 *     standard recommendation for production Leaflet deployments.
 *   - We previously used OpenFreeMap's raster URL
 *     (https://tiles.openfreemap.org/{z}/{x}/{y}.png), but that path
 *     returns HTTP 403 — only the /styles/liberty and /styles/bright
 *     vector-style JSON endpoints are publicly reachable, and those
 *     require a MapLibre GL vector renderer (not Leaflet raster).
 *     For a Leaflet-only integration, CARTO is the simpler, more
 *     reliable choice. OSMF's tile.openstreetmap.org also returns 200
 *     but its tile usage policy explicitly forbids production use, so
 *     it is not an option here.
 *   - Marker icon assets: Leaflet's default icon URLs point to
 *     `images/marker-icon.png` etc. inside the leaflet package. With
 *     Vite those files are NOT auto-resolved. We therefore merge the
 *     bundled asset URLs into `L.Icon.Default` once at module load.
 *   - Tenant scoping is upstream — the parent Dashboard already
 *     fetches only cameras the authenticated user is allowed to see
 *     (see `api/cameras.js` and `lib/_auth.js#getAccessibleCameraIds`).
 *     This component is purely a renderer.
 *   - Coordinate validation: a camera is plotted only if BOTH
 *     latitude and longitude are present (not null / not undefined
 *     / not empty string), parse as finite numbers, AND are not
 *     exactly (0, 0). (0, 0) is a valid geographic coordinate
 *     (Null Island, in the Atlantic) but in this product context it
 *     almost always means "operator never set coordinates" — see
 *     Dashboard.jsx buildCameraGeo. The Dashboard is the
 *     authoritative filter; this component applies a defensive
 *     second check so a stray row cannot render a misleading pin.
 *   - No browser geolocation. No CDN scripts.
 */
import { useEffect, useMemo, useRef } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import iconUrl from 'leaflet/dist/images/marker-icon.png';
import iconRetinaUrl from 'leaflet/dist/images/marker-icon-2x.png';
import shadowUrl from 'leaflet/dist/images/marker-shadow.png';

// Patch Leaflet's default-icon URL once at module load. Without this,
// every marker renders with a broken-image icon in Vite-built apps.
L.Icon.Default.mergeOptions({
  iconUrl,
  iconRetinaUrl,
  shadowUrl,
});

// CARTO "Positron" (formerly Light) raster tile URL. The four
// subdomains a/b/c/d are used in parallel by Leaflet to speed up
// loading. CARTO's CDN is keyless, has a published production SLA,
// and serves OpenStreetMap-derived raster tiles. We do NOT use
// tile.openstreetmap.org (OSMF policy forbids production use) and
// we do NOT use the OpenFreeMap /styles/* vector styles (Leaflet
// can't render vector tiles without MapLibre GL).
const CARTO_TILE_URL =
  'https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}.png';
const CARTO_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors ' +
  '&copy; <a href="https://carto.com/attributions">CARTO</a>';

// Initial center used when there are zero cameras with coordinates
// (so the map still shows the world instead of a blank canvas). The
// auto-fit logic below replaces this as soon as we have at least one
// camera with a real lat/lng.
const WORLD_CENTER = [20, 0];
const WORLD_ZOOM = 2;

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/**
 * Decide whether a camera row has coordinates we can plot.
 *
 * Rejects:
 *   - null / undefined / empty-string lat or lng
 *   - non-finite numbers (NaN, Infinity)
 *   - exactly (0, 0) — see file comment
 *
 * Accepts numeric strings (e.g. "45.26") and floats.
 */
export function hasValidCoord(camera) {
  if (!camera) return false;
  const latRaw = camera.lat;
  const lngRaw = camera.lng;
  if (latRaw === null || latRaw === undefined || latRaw === '') return false;
  if (lngRaw === null || lngRaw === undefined || lngRaw === '') return false;
  const lat = Number(latRaw);
  const lng = Number(lngRaw);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return false;
  if (lat === 0 && lng === 0) return false;
  return true;
}

function popupHtml(camera) {
  const name = escapeHtml(camera.name || camera.id || 'Unknown camera');
  const id = escapeHtml(camera.id || '');
  const location = camera.location
    ? `<br/><span class="map-popup-location">${escapeHtml(camera.location)}</span>`
    : '';
  return `<div class="map-popup"><strong class="map-popup-name">${name}</strong>` +
    `<br/><span class="map-popup-id">${id}</span>${location}</div>`;
}

export default function MapPanel({
  cameras,
  selectedCameraId = null,
  alarmCameraId = null,
  onSelectCamera,
}) {
  const containerRef = useRef(null);
  const mapRef = useRef(null);
  const markerLayerRef = useRef(null);

  // Filter once per render so the marker effect below stays simple
  // and the test surface is easy to assert against.
  const validCameras = useMemo(
    () => (Array.isArray(cameras) ? cameras.filter(hasValidCoord) : []),
    [cameras],
  );

  // ── Create the Leaflet map exactly once on mount ──────────────
  useEffect(() => {
    if (!containerRef.current) return undefined;
    const map = L.map(containerRef.current, {
      center: WORLD_CENTER,
      zoom: WORLD_ZOOM,
      // worldCopyJump: panning past the antimeridian copies the
      // world so users do not see an empty strip.
      worldCopyJump: true,
      preferCanvas: false,
    });
    L.tileLayer(CARTO_TILE_URL, {
      maxZoom: 19,
      // Subdomains a/b/c/d must be declared so Leaflet can rotate
      // between them in parallel (matches the {s}. placeholder in
      // CARTO_TILE_URL). CARTO's CDN serves from all four.
      subdomains: 'abcd',
      attribution: CARTO_ATTRIBUTION,
    }).addTo(map);
    const markerLayer = L.layerGroup().addTo(map);
    mapRef.current = map;
    markerLayerRef.current = markerLayer;
    return () => {
      markerLayer.clearLayers();
      map.remove();
      mapRef.current = null;
      markerLayerRef.current = null;
    };
  }, []);

  // ── Recompute markers + fitBounds whenever the camera set changes ──
  useEffect(() => {
    const map = mapRef.current;
    const markerLayer = markerLayerRef.current;
    if (!map || !markerLayer) return;
    markerLayer.clearLayers();

    if (validCameras.length === 0) return;

    const latLngs = [];
    for (const cam of validCameras) {
      const lat = Number(cam.lat);
      const lng = Number(cam.lng);
      const isAlarm = alarmCameraId != null && cam.id === alarmCameraId;
      const isSelected = selectedCameraId != null && cam.id === selectedCameraId;

      // Distinguish alarm markers from regular camera markers.
      // We swap the class on the marker's icon element so the CSS
      // can colour it (red glow for alarm, default blue for camera).
      // We also open the popup on the alarm marker so the operator
      // sees which camera is in alarm without an extra click.
      const marker = L.marker([lat, lng], {
        title: cam.name || cam.id || '',
        keyboard: true,
        riseOnHover: true,
      });
      marker.on('click', () => {
        if (typeof onSelectCamera === 'function') onSelectCamera(cam);
      });
      marker.bindPopup(popupHtml(cam));
      if (isAlarm || isSelected) {
        marker.openPopup();
      }
      marker.addTo(markerLayer);

      // Apply the alarm/selected CSS class. Leaflet exposes the
      // icon element as marker._icon, but it can be null until the
      // marker has been rendered; we set the data attribute on the
      // marker itself and let the CSS target it via
      // .leaflet-marker-icon (we attach the class after addTo so the
      // icon element exists).
      if (isAlarm) {
        // Defer one tick so the icon element is mounted.
        setTimeout(() => {
          const el = marker.getElement && marker.getElement();
          if (el) el.classList.add('map-marker-alarm');
        }, 0);
      } else if (isSelected) {
        setTimeout(() => {
          const el = marker.getElement && marker.getElement();
          if (el) el.classList.add('map-marker-selected');
        }, 0);
      }
      latLngs.push([lat, lng]);
    }

    if (latLngs.length === 1) {
      // Single camera: Leaflet fitBounds with one point degenerates,
      // so we fly to a sensible zoom instead.
      map.flyTo(latLngs[0], 14, { duration: 0.6 });
    } else {
      // Multiple cameras: auto-fit. We add a small padding so pins
      // do not sit on the very edge of the viewport.
      const bounds = L.latLngBounds(latLngs);
      map.fitBounds(bounds, { padding: [32, 32], maxZoom: 16, duration: 0.6 });
    }
  }, [validCameras, selectedCameraId, alarmCameraId, onSelectCamera]);

  return (
    <div
      ref={containerRef}
      className="map-panel-container"
      data-testid="map-panel"
      role="region"
      aria-label="Camera locations map"
    />
  );
}

export { CARTO_TILE_URL, CARTO_ATTRIBUTION };
