import React, { useState, useEffect } from 'react';

/**
 * Cloud Recording - OPTIMIZOVAN
 * 
 * Snima SAMO kad ima motion - štedi bandwidth i storage!
 * - Motion detection na serveru (ne na clientu)
 * - Cloud storage sa kompresijom
 * - Automatski cleanup starih snimaka
 * 
 * CPU/GPU opterećenje: ~2-5% (samo za preview)
 */
const CloudRecording = ({ cameraId, cameraName }) => {
  const [settings, setSettings] = useState({
    enabled: true,
    recordMode: 'motion', // 'motion', 'continuous', 'scheduled'
    motionSensitivity: 70,
    preBuffer: 5, // seconds before motion
    postBuffer: 30, // seconds after motion
    quality: 'medium', // 'low', 'medium', 'high'
    retention: 7, // days
    storageUsed: 0,
    storageLimit: 100, // GB
    recordings: []
  });
  const [isRecording, setIsRecording] = useState(false);
  const [schedule, setSchedule] = useState([
    { day: 'Mon', start: '08:00', end: '18:00', enabled: true },
    { day: 'Tue', start: '08:00', end: '18:00', enabled: true },
    { day: 'Wed', start: '08:00', end: '18:00', enabled: true },
    { day: 'Thu', start: '08:00', end: '18:00', enabled: true },
    { day: 'Fri', start: '08:00', end: '18:00', enabled: true },
    { day: 'Sat', start: '10:00', end: '16:00', enabled: false },
    { day: 'Sun', start: '10:00', end: '16:00', enabled: false }
  ]);

  const qualityOptions = [
    { key: 'low', label: 'Low (480p)', storage: '0.5 GB/hr' },
    { key: 'medium', label: 'Medium (720p)', storage: '1.5 GB/hr' },
    { key: 'high', label: 'High (1080p)', storage: '4 GB/hr' }
  ];

  const retentionOptions = [
    { days: 1, label: '1 day' },
    { days: 3, label: '3 days' },
    { days: 7, label: '1 week' },
    { days: 14, label: '2 weeks' },
    { days: 30, label: '1 month' }
  ];

  const toggleRecording = () => {
    setSettings({ ...settings, enabled: !settings.enabled });
    setIsRecording(!settings.enabled);
  };

  return (
    <div style={{
      background: 'rgba(10,18,38,.95)',
      border: '1px solid rgba(87,140,255,.18)',
      borderRadius: '16px',
      padding: '1.5rem'
    }}>
      <div style={{
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
        marginBottom: '1rem'
      }}>
        <h3 style={{ color: '#dff7ff', margin: 0 }}>
          ☁️ Cloud Recording
        </h3>
        <button
          onClick={toggleRecording}
          style={{
            padding: '.5rem 1.5rem',
            background: settings.enabled 
              ? 'linear-gradient(135deg,rgba(255,80,80,.4),rgba(255,80,80,.2))' 
              : 'linear-gradient(135deg,rgba(0,212,80,.4),rgba(0,212,80,.2))',
            border: 'none',
            borderRadius: '20px',
            color: settings.enabled ? '#ff5050' : '#00d450',
            fontWeight: 'bold',
            cursor: 'pointer',
            display: 'flex',
            alignItems: 'center',
            gap: '.5rem'
          }}
        >
          <span style={{
            width: '8px',
            height: '8px',
            borderRadius: '50%',
            background: settings.enabled ? '#ff5050' : '#6a8aaa'
          }} />
          {settings.enabled ? 'REC' : 'OFF'}
        </button>
      </div>

      {/* Recording Status */}
      {settings.enabled && (
        <div style={{
          padding: '1rem',
          background: isRecording 
            ? 'rgba(255,80,80,.1)' 
            : 'rgba(0,212,80,.05)',
          borderRadius: '12px',
          marginBottom: '1rem',
          display: 'flex',
          alignItems: 'center',
          gap: '1rem'
        }}>
          <span style={{ fontSize: '2rem' }}>
            {isRecording ? '🔴' : '⏸️'}
          </span>
          <div>
            <div style={{ 
              color: isRecording ? '#ff5050' : '#00d450', 
              fontWeight: 'bold' 
            }}>
              {isRecording ? 'Recording in Progress' : 'Standby - Waiting for Motion'}
            </div>
            <div style={{ color: '#8ab0c9', fontSize: '.85rem' }}>
              {isRecording 
                ? `Recording since ${new Date().toLocaleTimeString()}`
                : 'Motion-triggered recording enabled'}
            </div>
          </div>
        </div>
      )}

      {/* Record Mode */}
      <div style={{ marginBottom: '1rem' }}>
        <label style={{
          display: 'block',
          color: '#8ab0c9',
          fontSize: '.85rem',
          marginBottom: '.5rem'
        }}>
          Recording Mode
        </label>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          {[
            { key: 'motion', label: '🎯 Motion', desc: 'Only on detection' },
            { key: 'continuous', label: '📹 Continuous', desc: '24/7 recording' },
            { key: 'scheduled', label: '⏰ Scheduled', desc: 'Based on schedule' }
          ].map(mode => (
            <button
              key={mode.key}
              onClick={() => setSettings({ ...settings, recordMode: mode.key })}
              style={{
                flex: 1,
                padding: '.75rem .5rem',
                background: settings.recordMode === mode.key 
                  ? 'rgba(0,212,255,.2)' 
                  : 'rgba(87,125,196,.1)',
                border: settings.recordMode === mode.key 
                  ? '2px solid #00d4ff' 
                  : '1px solid rgba(87,125,196,.3)',
                borderRadius: '10px',
                color: settings.recordMode === mode.key ? '#00d4ff' : '#8ab0c9',
                cursor: 'pointer',
                textAlign: 'center'
              }}
            >
              <div style={{ fontWeight: 'bold', fontSize: '.85rem' }}>{mode.label}</div>
              <div style={{ fontSize: '.7rem', marginTop: '.25rem' }}>{mode.desc}</div>
            </button>
          ))}
        </div>
      </div>

      {/* Motion Sensitivity (only for motion mode) */}
      {settings.recordMode === 'motion' && (
        <div style={{ marginBottom: '1rem' }}>
          <label style={{
            display: 'flex',
            justifyContent: 'space-between',
            color: '#8ab0c9',
            fontSize: '.85rem',
            marginBottom: '.5rem'
          }}>
            <span>Motion Sensitivity</span>
            <span style={{ color: '#00d4ff' }}>{settings.motionSensitivity}%</span>
          </label>
          <input
            type="range"
            min="10"
            max="100"
            value={settings.motionSensitivity}
            onChange={(e) => setSettings({ ...settings, motionSensitivity: parseInt(e.target.value) })}
            style={{
              width: '100%',
              height: '8px',
              borderRadius: '4px',
              background: `linear-gradient(to right, #00d4ff ${settings.motionSensitivity}%, rgba(87,125,196,.3) ${settings.motionSensitivity}%)`,
              appearance: 'none',
              cursor: 'pointer'
            }}
          />
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            color: '#6a8aaa',
            fontSize: '.7rem',
            marginTop: '.25rem'
          }}>
            <span>Less Sensitive</span>
            <span>More Sensitive</span>
          </div>
        </div>
      )}

      {/* Buffer Settings */}
      <div style={{ 
        display: 'grid', 
        gridTemplateColumns: '1fr 1fr', 
        gap: '1rem',
        marginBottom: '1rem'
      }}>
        <div>
          <label style={{
            display: 'block',
            color: '#8ab0c9',
            fontSize: '.85rem',
            marginBottom: '.5rem'
          }}>
            Pre-Buffer
          </label>
          <select
            value={settings.preBuffer}
            onChange={(e) => setSettings({ ...settings, preBuffer: parseInt(e.target.value) })}
            style={{
              width: '100%',
              padding: '.6rem',
              background: 'rgba(87,125,196,.1)',
              border: '1px solid rgba(87,125,196,.3)',
              borderRadius: '8px',
              color: '#dff7ff'
            }}
          >
            {[3, 5, 10, 15, 30].map(v => (
              <option key={v} value={v}>{v} seconds</option>
            ))}
          </select>
        </div>
        <div>
          <label style={{
            display: 'block',
            color: '#8ab0c9',
            fontSize: '.85rem',
            marginBottom: '.5rem'
          }}>
            Post-Buffer
          </label>
          <select
            value={settings.postBuffer}
            onChange={(e) => setSettings({ ...settings, postBuffer: parseInt(e.target.value) })}
            style={{
              width: '100%',
              padding: '.6rem',
              background: 'rgba(87,125,196,.1)',
              border: '1px solid rgba(87,125,196,.3)',
              borderRadius: '8px',
              color: '#dff7ff'
            }}
          >
            {[10, 30, 60, 120, 300].map(v => (
              <option key={v} value={v}>
                {v < 60 ? `${v}s` : `${v/60}min`}
              </option>
            ))}
          </select>
        </div>
      </div>

      {/* Quality */}
      <div style={{ marginBottom: '1rem' }}>
        <label style={{
          display: 'block',
          color: '#8ab0c9',
          fontSize: '.85rem',
          marginBottom: '.5rem'
        }}>
          Recording Quality
        </label>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          {qualityOptions.map(q => (
            <button
              key={q.key}
              onClick={() => setSettings({ ...settings, quality: q.key })}
              style={{
                flex: 1,
                padding: '.6rem',
                background: settings.quality === q.key 
                  ? 'rgba(0,212,255,.2)' 
                  : 'rgba(87,125,196,.1)',
                border: settings.quality === q.key 
                  ? '2px solid #00d4ff' 
                  : '1px solid rgba(87,125,196,.3)',
                borderRadius: '8px',
                color: settings.quality === q.key ? '#00d4ff' : '#8ab0c9',
                cursor: 'pointer',
                textAlign: 'center'
              }}
            >
              <div style={{ fontSize: '.8rem', fontWeight: 'bold' }}>{q.label}</div>
              <div style={{ fontSize: '.7rem', marginTop: '.25rem', color: '#6a8aaa' }}>
                {q.storage}
              </div>
            </button>
          ))}
        </div>
      </div>

      {/* Storage Usage */}
      <div style={{
        padding: '1rem',
        background: 'rgba(87,125,196,.1)',
        borderRadius: '12px',
        marginBottom: '1rem'
      }}>
        <div style={{
          display: 'flex',
          justifyContent: 'space-between',
          marginBottom: '.5rem'
        }}>
          <span style={{ color: '#8ab0c9', fontSize: '.85rem' }}>Storage Used</span>
          <span style={{ color: '#dff7ff', fontWeight: 'bold' }}>
            {settings.storageUsed.toFixed(1)} GB / {settings.storageLimit} GB
          </span>
        </div>
        <div style={{
          height: '8px',
          background: 'rgba(87,125,196,.3)',
          borderRadius: '4px',
          overflow: 'hidden'
        }}>
          <div style={{
            width: `${(settings.storageUsed / settings.storageLimit) * 100}%`,
            height: '100%',
            background: settings.storageUsed / settings.storageLimit > 0.8 
              ? '#ff5050' 
              : settings.storageUsed / settings.storageLimit > 0.6 
                ? '#ffb432' 
                : '#00d450',
            borderRadius: '4px'
          }} />
        </div>
      </div>

      {/* Retention */}
      <div style={{ marginBottom: '1rem' }}>
        <label style={{
          display: 'block',
          color: '#8ab0c9',
          fontSize: '.85rem',
          marginBottom: '.5rem'
        }}>
          Retention Period
        </label>
        <div style={{ display: 'flex', gap: '.5rem' }}>
          {retentionOptions.map(r => (
            <button
              key={r.days}
              onClick={() => setSettings({ ...settings, retention: r.days })}
              style={{
                flex: 1,
                padding: '.5rem',
                background: settings.retention === r.days 
                  ? 'rgba(0,212,255,.2)' 
                  : 'rgba(87,125,196,.1)',
                border: settings.retention === r.days 
                  ? '2px solid #00d4ff' 
                  : '1px solid rgba(87,125,196,.3)',
                borderRadius: '8px',
                color: settings.retention === r.days ? '#00d4ff' : '#8ab0c9',
                cursor: 'pointer',
                fontSize: '.8rem'
              }}
            >
              {r.label}
            </button>
          ))}
        </div>
      </div>

      {/* Info */}
      <p style={{
        color: '#6a8aaa',
        fontSize: '.75rem',
        textAlign: 'center'
      }}>
        💡 Cloud recording uses motion detection to save storage. 
        Estimated: ~{qualityOptions.find(q => q.key === settings.quality)?.storage} per camera
      </p>
    </div>
  );
};

export default CloudRecording;
