import { useEffect, useMemo, useRef, useState } from 'react';
import api from '../services/api';

export function useIncidents(authChecked) {
  const [incidents, setIncidents] = useState([]);
  const [incidentsLoaded, setIncidentsLoaded] = useState(false);
  const [updatingIncidentId, setUpdatingIncidentId] = useState(null);
  const [error, setError] = useState(null);
  const prevNewIncidentsRef = useRef(null);

  // Audio alarm - 3 beeps via Web Audio API
  const playAlarmBeep = () => {
    try {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      [0, 0.45, 0.9].forEach((delay) => {
        const osc = ctx.createOscillator();
        const gainNode = ctx.createGain();
        osc.connect(gainNode);
        gainNode.connect(ctx.destination);
        osc.frequency.value = 880;
        osc.type = 'sine';
        gainNode.gain.setValueAtTime(0.35, ctx.currentTime + delay);
        gainNode.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + delay + 0.3);
        osc.start(ctx.currentTime + delay);
        osc.stop(ctx.currentTime + delay + 0.35);
      });
    } catch (e) { /* AudioContext unavailable or blocked */ }
  };

  // Fetch incidents once auth is confirmed
  useEffect(() => {
    if (!authChecked) return;

    api
      .get('/incidents')
      .then((res) => {
        setIncidents(res.data.incidents || []);
        setIncidentsLoaded(true);
      })
      .catch((err) => setError(err.message));
  }, [authChecked]);

  // Audio alarm: play 3 beeps when new 'New' incidents arrive
  useEffect(() => {
    if (!incidentsLoaded) return;
    const newCount = incidents.filter((i) => i.status === 'New').length;
    if (prevNewIncidentsRef.current !== null && newCount > prevNewIncidentsRef.current) {
      playAlarmBeep();
    }
    prevNewIncidentsRef.current = newCount;
  }, [incidents, incidentsLoaded]);

  const updateIncidentStatus = async (eventId, status) => {
    try {
      setUpdatingIncidentId(eventId);
      await api.patch(`/incidents/${eventId}/status`, { status });
      setIncidents((previous) => previous.map((incident) => (
        incident.event_id === eventId ? { ...incident, status } : incident
      )));
    } catch (err) {
      alert(`Failed to update incident: ${err.message}`);
    } finally {
      setUpdatingIncidentId(null);
    }
  };

  const statusClassName = (status) => {
    if (status === 'False Alarm') return 'neutral';
    if (status === 'Resolved') return 'good';
    if (status === 'In Progress' || status === 'Acknowledged') return 'warning';
    return 'warning';
  };

  const nextActionsForStatus = (status) => {
    switch (status) {
      case 'New':
        return ['Acknowledged', 'In Progress', 'False Alarm'];
      case 'Acknowledged':
        return ['In Progress', 'Resolved', 'False Alarm'];
      case 'In Progress':
        return ['Resolved', 'False Alarm'];
      case 'Resolved':
        return ['In Progress', 'False Alarm'];
      case 'False Alarm':
        return ['New', 'Acknowledged'];
      default:
        return ['Acknowledged'];
    }
  };

  const recentAlerts = incidents.filter((incident) => ['New', 'Acknowledged', 'In Progress'].includes(incident.status)).length;

  const recentEvents = useMemo(() => incidents.slice(0, 20).map((item) => ({
    id: `evt-${item.event_id}-${item.detection_id}`,
    eventId: item.event_id,
    title: `${item.object_type} detection`,
    subtitle: item.subtitle || `Confidence ${Math.round(Number(item.confidence) * 100)}%`,
    source: item.source || `Event #${item.event_id}`,
    time: item.timestamp,
    status: item.status || 'New',
    confidence: item.confidence,
    camera_id: item.camera_id,
    zone: item.zone || item.location,
    direction: item.direction,
    dwell_seconds: item.dwell_seconds,
  })), [incidents]);

  return {
    incidents,
    incidentsLoaded,
    updatingIncidentId,
    error,
    recentAlerts,
    recentEvents,
    updateIncidentStatus,
    statusClassName,
    nextActionsForStatus,
  };
}
