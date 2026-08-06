import { useMemo, useState } from 'react';

function useDebounce(value, delay = 250) {
  const [debounced, setDebounced] = useState(value);
  const [timer, setTimer] = useState(null);

  if (timer) clearTimeout(timer);
  const newTimer = setTimeout(() => setDebounced(value), delay);
  setTimer(newTimer);

  return debounced;
}

export function useIncidentFilters(incidents) {
  const [filterCamera, setFilterCamera] = useState('');
  const [filterZone, setFilterZone] = useState('');
  const [filterDirection, setFilterDirection] = useState('');
  const [filterDwellMin, setFilterDwellMin] = useState('');
  const [globalSearchTerm, setGlobalSearchTerm] = useState('');
  const [filterObjectType, setFilterObjectType] = useState('');
  const [filterColor, setFilterColor] = useState('');

  // False Alarm suppression
  const [suppressEnabled, setSuppressEnabled] = useState(false);
  const [suppressThreshold, setSuppressThreshold] = useState(85);

  // Debounced versions of text-input filter states
  const dFilterObjectType = useDebounce(filterObjectType);
  const dFilterZone = useDebounce(filterZone);
  const dFilterDwellMin = useDebounce(filterDwellMin);
  const dFilterColor = useDebounce(filterColor);
  const dGlobalSearchTerm = useDebounce(globalSearchTerm);

  // Client-side filter + false-alarm suppression applied to incidents list
  const filteredIncidents = useMemo(() => (incidents || []).filter((item) => {
    if (suppressEnabled && Number(item.confidence) < suppressThreshold / 100) return false;
    if (filterCamera && String(item.camera_id || '').toLowerCase() !== filterCamera.toLowerCase()) return false;
    if (dFilterZone && !String(item.zone || item.location || '').toLowerCase().includes(dFilterZone.toLowerCase())) return false;
    if (filterDirection && !String(item.direction || '').toLowerCase().includes(filterDirection.toLowerCase())) return false;
    if (dFilterDwellMin && Number(item.dwell_seconds || 0) < Number(dFilterDwellMin)) return false;
    if (dFilterObjectType && !String(item.object_type || '').toLowerCase().includes(dFilterObjectType.toLowerCase())) return false;
    if (dFilterColor) {
      const hasColor = (item.attributes || []).some(
        (a) => String(a.attribute_type || a.type || '').toLowerCase() === 'color' &&
               String(a.attribute_value || a.value || '').toLowerCase().includes(dFilterColor.toLowerCase())
      );
      if (!hasColor) return false;
    }
    return true;
  }), [incidents, suppressEnabled, suppressThreshold, filterCamera, dFilterZone, filterDirection, dFilterDwellMin, dFilterObjectType, dFilterColor]);

  const globalSearchNeedle = globalSearchTerm.trim().toLowerCase();

  const clearFilters = () => {
    setFilterObjectType('');
    setFilterCamera('');
    setFilterZone('');
    setFilterDirection('');
    setFilterDwellMin('');
    setFilterColor('');
    setSuppressEnabled(false);
  };

  const hasActiveFilters = filterObjectType || filterCamera || filterZone || filterDirection || filterDwellMin || filterColor || suppressEnabled;

  return {
    filterCamera,
    setFilterCamera,
    filterZone,
    setFilterZone,
    filterDirection,
    setFilterDirection,
    filterDwellMin,
    setFilterDwellMin,
    globalSearchTerm,
    setGlobalSearchTerm,
    filterObjectType,
    setFilterObjectType,
    filterColor,
    setFilterColor,
    suppressEnabled,
    setSuppressEnabled,
    suppressThreshold,
    setSuppressThreshold,
    filteredIncidents,
    globalSearchNeedle,
    clearFilters,
    hasActiveFilters,
  };
}
