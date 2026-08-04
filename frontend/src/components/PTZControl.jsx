import React, { useState } from 'react';
import api from '../services/api';

/**
 * PTZ Control - OPTIMIZOVAN
 * 
 * Koristi SAMO HTTP komande - NEMA video processing!
 * - Pan/Tilt/Zoom se šalje kao jednostavni HTTP request
 * - Kamera sama izvršava pokrete
 * - Browser samo čeka odgovor
 * 
 * CPU/GPU opterećenje: ~0%
 */
const PTZControl = ({ cameraId, cameraName, enabled = true }) => {
  const [position, setPosition] = useState({ pan: 0, tilt: 0, zoom: 50 });
  const [moving, setMoving] = useState(null);
  const [presets, setPresets] = useState([
    { id: 1, name: 'Home', position: { pan: 0, tilt: 0, zoom: 50 } },
    { id: 2, name: 'Entrance', position: { pan: -45, tilt: 10, zoom: 75 } },
    { id: 3, name: 'Parking', position: { pan: 90, tilt: -5, zoom: 80 } }
  ]);

  // Send PTZ command to camera
  const sendPTZCommand = async (action, value = 1) => {
    if (!enabled || moving) return;
    
    setMoving(action);
    
    try {
      // HTTP komanda - VRLO LAK server processing
      await api.post(`/cameras/${cameraId}/ptz`, {
        action,
        value,
        speed: 5
      });
      
      // Update local position for immediate feedback
      setPosition(prev => {
        switch (action) {
          case 'pan_left': return { ...prev, pan: Math.max(-180, prev.pan - 5) };
          case 'pan_right': return { ...prev, pan: Math.min(180, prev.pan + 5) };
          case 'tilt_up': return { ...prev, tilt: Math.min(90, prev.tilt + 5) };
          case 'tilt_down': return { ...prev, tilt: Math.min(-45, prev.tilt - 5) };
          case 'zoom_in': return { ...prev, zoom: Math.min(100, prev.zoom + 10) };
          case 'zoom_out': return { ...prev, zoom: Math.max(10, prev.zoom - 10) };
          default: return prev;
        }
      });
    } catch (err) {
      console.error('PTZ command failed:', err);
    }
    
    setTimeout(() => setMoving(null), 200);
  };

  // Go to preset
  const goToPreset = async (preset) => {
    setPosition(preset.position);
    // Send HTTP command to move to preset
    try {
      await api.post(`/cameras/${cameraId}/ptz/preset`, { presetId: preset.id });
    } catch (err) {
      console.error('Preset failed:', err);
    }
  };

  if (!enabled) {
    return (
      <div style={{
        padding: '1rem',
        background: 'rgba(255,80,80,.1)',
        border: '1px solid rgba(255,80,80,.3)',
        borderRadius: '12px',
        textAlign: 'center',
        color: '#ff5050'
      }}>
        📷 PTZ Control not available for this camera
      </div>
    );
  }

  return (
    <div style={{
      background: 'rgba(10,18,38,.95)',
      border: '1px solid rgba(87,140,255,.18)',
      borderRadius: '16px',
      padding: '1.5rem'
    }}>
      <h3 style={{ color: '#dff7ff', marginBottom: '1rem' }}>
        📷 PTZ Control
      </h3>

      <div style={{
        display: 'grid',
        gridTemplateColumns: '1fr 1fr',
        gap: '1rem'
      }}>
        {/* Left: PTZ Controls */}
        <div>
          {/* Zoom controls */}
          <div style={{
            display: 'flex',
            gap: '.5rem',
            marginBottom: '1rem',
            justifyContent: 'center'
          }}>
            <button
              onClick={() => sendPTZCommand('zoom_out')}
              disabled={moving !== null}
              style={{
                flex: 1,
                padding: '.75rem',
                background: 'rgba(87,125,196,.2)',
                border: 'none',
                borderRadius: '8px',
                color: '#8ab0c9',
                cursor: 'pointer',
                fontSize: '1.2rem'
              }}
            >
              ➖
            </button>
            <span style={{
              padding: '.75rem 1rem',
              background: 'rgba(0,212,255,.1)',
              borderRadius: '8px',
              color: '#00d4ff',
              fontWeight: 'bold',
              minWidth: '60px',
              textAlign: 'center'
            }}>
              {position.zoom}%
            </span>
            <button
              onClick={() => sendPTZCommand('zoom_in')}
              disabled={moving !== null}
              style={{
                flex: 1,
                padding: '.75rem',
                background: 'rgba(87,125,196,.2)',
                border: 'none',
                borderRadius: '8px',
                color: '#8ab0c9',
                cursor: 'pointer',
                fontSize: '1.2rem'
              }}
            >
              ➕
            </button>
          </div>

          {/* Direction pad */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(3, 1fr)',
            gap: '.5rem'
          }}>
            <div />
            <button
              onMouseDown={() => sendPTZCommand('tilt_up')}
              onMouseUp={() => setMoving(null)}
              onMouseLeave={() => setMoving(null)}
              style={{
                padding: '.75rem',
                background: moving === 'tilt_up' ? 'rgba(0,212,255,.3)' : 'rgba(87,125,196,.2)',
                border: 'none',
                borderRadius: '8px',
                color: '#8ab0c9',
                cursor: 'pointer',
                fontSize: '1.2rem'
              }}
            >
              ▲
            </button>
            <div />
            
            <button
              onMouseDown={() => sendPTZCommand('pan_left')}
              onMouseUp={() => setMoving(null)}
              onMouseLeave={() => setMoving(null)}
              style={{
                padding: '.75rem',
                background: moving === 'pan_left' ? 'rgba(0,212,255,.3)' : 'rgba(87,125,196,.2)',
                border: 'none',
                borderRadius: '8px',
                color: '#8ab0c9',
                cursor: 'pointer',
                fontSize: '1.2rem'
              }}
            >
              ◀
            </button>
            <div style={{
              padding: '.75rem',
              background: 'rgba(0,212,255,.1)',
              borderRadius: '8px',
              textAlign: 'center'
            }}>
              <div style={{ fontSize: '.7rem', color: '#00d450' }}>●</div>
            </div>
            <button
              onMouseDown={() => sendPTZCommand('pan_right')}
              onMouseUp={() => setMoving(null)}
              onMouseLeave={() => setMoving(null)}
              style={{
                padding: '.75rem',
                background: moving === 'pan_right' ? 'rgba(0,212,255,.3)' : 'rgba(87,125,196,.2)',
                border: 'none',
                borderRadius: '8px',
                color: '#8ab0c9',
                cursor: 'pointer',
                fontSize: '1.2rem'
              }}
            >
              ▶
            </button>
            
            <div />
            <button
              onMouseDown={() => sendPTZCommand('tilt_down')}
              onMouseUp={() => setMoving(null)}
              onMouseLeave={() => setMoving(null)}
              style={{
                padding: '.75rem',
                background: moving === 'tilt_down' ? 'rgba(0,212,255,.3)' : 'rgba(87,125,196,.2)',
                border: 'none',
                borderRadius: '8px',
                color: '#8ab0c9',
                cursor: 'pointer',
                fontSize: '1.2rem'
              }}
            >
              ▼
            </button>
            <div />
          </div>
        </div>

        {/* Right: Position & Presets */}
        <div>
          {/* Position display */}
          <div style={{
            padding: '1rem',
            background: 'rgba(87,125,196,.1)',
            borderRadius: '12px',
            marginBottom: '1rem'
          }}>
            <h4 style={{ color: '#8ee8ff', marginBottom: '.75rem', fontSize: '.85rem' }}>
              Position
            </h4>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '.5rem' }}>
              <div>
                <span style={{ color: '#6a8aaa', fontSize: '.75rem' }}>Pan</span>
                <div style={{ color: '#dff7ff', fontWeight: 'bold' }}>{position.pan}°</div>
              </div>
              <div>
                <span style={{ color: '#6a8aaa', fontSize: '.75rem' }}>Tilt</span>
                <div style={{ color: '#dff7ff', fontWeight: 'bold' }}>{position.tilt}°</div>
              </div>
            </div>
          </div>

          {/* Presets */}
          <h4 style={{ color: '#8ee8ff', marginBottom: '.75rem', fontSize: '.85rem' }}>
            Presets
          </h4>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
            {presets.map(preset => (
              <button
                key={preset.id}
                onClick={() => goToPreset(preset)}
                style={{
                  padding: '.5rem .75rem',
                  background: 'rgba(87,125,196,.15)',
                  border: '1px solid rgba(87,125,196,.2)',
                  borderRadius: '8px',
                  color: '#8ab0c9',
                  cursor: 'pointer',
                  textAlign: 'left',
                  fontSize: '.85rem'
                }}
              >
                📍 {preset.name}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default PTZControl;
