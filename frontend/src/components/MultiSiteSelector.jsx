import React, { useState } from 'react';

/**
 * Multi-Site Selector - OPTIMIZOVAN
 * 
 * Samo UI filter - NEMA additional processing!
 * - Dropdown meni za odabir lokacije
 * - Sve ostalo se filtrira na API nivou
 * 
 * CPU/GPU opterećenje: ~0%
 */
const MultiSiteSelector = ({ sites = [], currentSite, onSiteChange }) => {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');

  const filteredSites = sites.filter(site => 
    site.name.toLowerCase().includes(search.toLowerCase())
  );

  const currentSiteData = sites.find(s => s.id === currentSite) || { name: 'All Sites', icon: '🌐' };

  return (
    <div style={{ position: 'relative' }}>
      {/* Dropdown Trigger */}
      <button
        onClick={() => setIsOpen(!isOpen)}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: '.75rem',
          padding: '.75rem 1rem',
          background: 'rgba(87,125,196,.15)',
          border: '1px solid rgba(87,125,196,.3)',
          borderRadius: '12px',
          color: '#dff7ff',
          cursor: 'pointer',
          minWidth: '200px'
        }}
      >
        <span style={{ fontSize: '1.25rem' }}>{currentSiteData.icon}</span>
        <span style={{ flex: 1, textAlign: 'left' }}>{currentSiteData.name}</span>
        <span style={{ 
          color: '#8ab0c9',
          transform: isOpen ? 'rotate(180deg)' : 'rotate(0deg)',
          transition: 'transform .2s'
        }}>
          ▼
        </span>
      </button>

      {/* Dropdown Menu */}
      {isOpen && (
        <>
          {/* Backdrop */}
          <div
            onClick={() => setIsOpen(false)}
            style={{
              position: 'fixed',
              top: 0,
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 999
            }}
          />

          {/* Menu */}
          <div style={{
            position: 'absolute',
            top: '100%',
            left: 0,
            marginTop: '.5rem',
            background: 'rgba(10,18,38,.98)',
            border: '1px solid rgba(87,140,255,.3)',
            borderRadius: '12px',
            minWidth: '280px',
            zIndex: 1000,
            overflow: 'hidden',
            boxShadow: '0 10px 40px rgba(0,0,0,.5)'
          }}>
            {/* Search */}
            <div style={{ padding: '.75rem', borderBottom: '1px solid rgba(87,125,196,.2)' }}>
              <input
                type="text"
                placeholder="Search sites..."
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                style={{
                  width: '100%',
                  padding: '.6rem',
                  background: 'rgba(87,125,196,.1)',
                  border: '1px solid rgba(87,125,196,.3)',
                  borderRadius: '8px',
                  color: '#dff7ff',
                  fontSize: '.9rem'
                }}
              />
            </div>

            {/* Sites List */}
            <div style={{ maxHeight: '300px', overflowY: 'auto' }}>
              {/* All Sites Option */}
              <button
                onClick={() => { onSiteChange(null); setIsOpen(false); }}
                style={{
                  width: '100%',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '.75rem',
                  padding: '.75rem 1rem',
                  background: currentSite === null ? 'rgba(0,212,255,.1)' : 'transparent',
                  border: 'none',
                  color: '#dff7ff',
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
              >
                <span style={{ fontSize: '1.25rem' }}>🌐</span>
                <div>
                  <div style={{ fontWeight: 'bold' }}>All Sites</div>
                  <div style={{ color: '#6a8aaa', fontSize: '.75rem' }}>
                    {sites.length} locations
                  </div>
                </div>
                {currentSite === null && (
                  <span style={{ marginLeft: 'auto', color: '#00d450' }}>✓</span>
                )}
              </button>

              {/* Individual Sites */}
              {filteredSites.map(site => (
                <button
                  key={site.id}
                  onClick={() => { onSiteChange(site.id); setIsOpen(false); }}
                  style={{
                    width: '100%',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '.75rem',
                    padding: '.75rem 1rem',
                    background: currentSite === site.id ? 'rgba(0,212,255,.1)' : 'transparent',
                    border: 'none',
                    color: '#dff7ff',
                    cursor: 'pointer',
                    textAlign: 'left'
                  }}
                >
                  <span style={{ fontSize: '1.25rem' }}>{site.icon || '📍'}</span>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontWeight: 'bold' }}>{site.name}</div>
                    <div style={{ color: '#6a8aaa', fontSize: '.75rem' }}>
                      {site.cameras || 0} cameras • {site.location || 'No location'}
                    </div>
                  </div>
                  {currentSite === site.id && (
                    <span style={{ color: '#00d450' }}>✓</span>
                  )}
                </button>
              ))}

              {filteredSites.length === 0 && (
                <div style={{
                  padding: '2rem',
                  textAlign: 'center',
                  color: '#6a8aaa'
                }}>
                  No sites found
                </div>
              )}
            </div>

            {/* Add New Site */}
            <div style={{
              padding: '.75rem',
              borderTop: '1px solid rgba(87,125,196,.2)'
            }}>
              <button
                onClick={() => { setIsOpen(false); }}
                style={{
                  width: '100%',
                  padding: '.75rem',
                  background: 'rgba(0,212,255,.1)',
                  border: '1px dashed rgba(0,212,255,.3)',
                  borderRadius: '8px',
                  color: '#00d4ff',
                  cursor: 'pointer',
                  fontSize: '.9rem'
                }}
              >
                + Add New Site
              </button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default MultiSiteSelector;
