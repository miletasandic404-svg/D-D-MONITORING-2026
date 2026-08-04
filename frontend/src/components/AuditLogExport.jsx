import React, { useState } from 'react';
import api from '../services/api';

/**
 * Audit Log Export - OPTIMIZOVAN
 * 
 * CSV generacija na SERVERU - NEMA client CPU/GPU!
 * - Server generiše CSV
 * - Client samo skida fajl
 * - PDF se također generira na serveru
 * 
 * CPU/GPU opterećenje: ~0% na clientu
 */
const AuditLogExport = ({ logs = [], title = 'Audit Log' }) => {
  const [exporting, setExporting] = useState(false);
  const [format, setFormat] = useState('csv');
  const [dateRange, setDateRange] = useState({
    start: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    end: new Date().toISOString().split('T')[0]
  });
  const [filters, setFilters] = useState({
    type: 'all',
    user: 'all',
    severity: 'all'
  });

  // Export logs (server-side generation)
  const handleExport = async () => {
    setExporting(true);
    
    try {
      if (format === 'csv') {
        // Server-side CSV generation
        const response = await api.get('/api/audit/export', {
          params: {
            format: 'csv',
            start: dateRange.start,
            end: dateRange.end,
            type: filters.type,
            user: filters.user,
            severity: filters.severity
          },
          responseType: 'blob'
        });
        
        // Download file
        const url = window.URL.createObjectURL(new Blob([response.data]));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `audit-log-${dateRange.start}-${dateRange.end}.csv`);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
        
      } else if (format === 'pdf') {
        // Server-side PDF generation
        const response = await api.get('/api/audit/export', {
          params: {
            format: 'pdf',
            start: dateRange.start,
            end: dateRange.end,
            type: filters.type,
            user: filters.user,
            severity: filters.severity
          },
          responseType: 'blob'
        });
        
        const url = window.URL.createObjectURL(new Blob([response.data], { type: 'application/pdf' }));
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `audit-log-${dateRange.start}-${dateRange.end}.pdf`);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
        
      } else if (format === 'json') {
        // JSON export (also server-side)
        const response = await api.get('/api/audit/export', {
          params: {
            format: 'json',
            start: dateRange.start,
            end: dateRange.end,
            type: filters.type,
            user: filters.user,
            severity: filters.severity
          }
        });
        
        const blob = new Blob([JSON.stringify(response.data, null, 2)], { type: 'application/json' });
        const url = window.URL.createObjectURL(blob);
        const link = document.createElement('a');
        link.href = url;
        link.setAttribute('download', `audit-log-${dateRange.start}-${dateRange.end}.json`);
        document.body.appendChild(link);
        link.click();
        link.remove();
        window.URL.revokeObjectURL(url);
      }
    } catch (err) {
      console.error('Export failed:', err);
      alert('Export failed. Please check your connection and try again.');
    }
    
    setExporting(false);
  };

  return (
    <div style={{
      background: 'rgba(10,18,38,.95)',
      border: '1px solid rgba(87,140,255,.18)',
      borderRadius: '16px',
      padding: '1.5rem'
    }}>
      <h3 style={{ color: '#dff7ff', marginBottom: '1rem' }}>
        📋 {title}
      </h3>

      {/* Date Range */}
      <div style={{ marginBottom: '1rem' }}>
        <label style={{
          display: 'block',
          color: '#8ab0c9',
          fontSize: '.85rem',
          marginBottom: '.5rem'
        }}>
          Date Range
        </label>
        <div style={{ display: 'flex', gap: '1rem' }}>
          <input
            type="date"
            value={dateRange.start}
            onChange={(e) => setDateRange({ ...dateRange, start: e.target.value })}
            style={{
              flex: 1,
              padding: '.6rem',
              background: 'rgba(87,125,196,.1)',
              border: '1px solid rgba(87,125,196,.3)',
              borderRadius: '8px',
              color: '#dff7ff'
            }}
          />
          <span style={{ color: '#8ab0c9', display: 'flex', alignItems: 'center' }}>to</span>
          <input
            type="date"
            value={dateRange.end}
            onChange={(e) => setDateRange({ ...dateRange, end: e.target.value })}
            style={{
              flex: 1,
              padding: '.6rem',
              background: 'rgba(87,125,196,.1)',
              border: '1px solid rgba(87,125,196,.3)',
              borderRadius: '8px',
              color: '#dff7ff'
            }}
          />
        </div>
      </div>

      {/* Filters */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: '.75rem', marginBottom: '1rem' }}>
        <div>
          <label style={{ display: 'block', color: '#8ab0c9', fontSize: '.75rem', marginBottom: '.25rem' }}>
            Type
          </label>
          <select
            value={filters.type}
            onChange={(e) => setFilters({ ...filters, type: e.target.value })}
            style={{
              width: '100%',
              padding: '.5rem',
              background: 'rgba(87,125,196,.1)',
              border: '1px solid rgba(87,125,196,.3)',
              borderRadius: '8px',
              color: '#dff7ff',
              fontSize: '.85rem'
            }}
          >
            <option value="all">All Types</option>
            <option value="login">Login</option>
            <option value="camera">Camera</option>
            <option value="alert">Alert</option>
            <option value="settings">Settings</option>
            <option value="user">User</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', color: '#8ab0c9', fontSize: '.75rem', marginBottom: '.25rem' }}>
            User
          </label>
          <select
            value={filters.user}
            onChange={(e) => setFilters({ ...filters, user: e.target.value })}
            style={{
              width: '100%',
              padding: '.5rem',
              background: 'rgba(87,125,196,.1)',
              border: '1px solid rgba(87,125,196,.3)',
              borderRadius: '8px',
              color: '#dff7ff',
              fontSize: '.85rem'
            }}
          >
            <option value="all">All Users</option>
            <option value="admin">Admin</option>
            <option value="operator">Operator</option>
            <option value="viewer">Viewer</option>
          </select>
        </div>

        <div>
          <label style={{ display: 'block', color: '#8ab0c9', fontSize: '.75rem', marginBottom: '.25rem' }}>
            Severity
          </label>
          <select
            value={filters.severity}
            onChange={(e) => setFilters({ ...filters, severity: e.target.value })}
            style={{
              width: '100%',
              padding: '.5rem',
              background: 'rgba(87,125,196,.1)',
              border: '1px solid rgba(87,125,196,.3)',
              borderRadius: '8px',
              color: '#dff7ff',
              fontSize: '.85rem'
            }}
          >
            <option value="all">All Levels</option>
            <option value="info">Info</option>
            <option value="warning">Warning</option>
            <option value="critical">Critical</option>
          </select>
        </div>
      </div>

      {/* Export Format */}
      <div style={{ marginBottom: '1rem' }}>
        <label style={{
          display: 'block',
          color: '#8ab0c9',
          fontSize: '.85rem',
          marginBottom: '.5rem'
        }}>
          Export Format
        </label>
        <div style={{ display: 'flex', gap: '.75rem' }}>
          {[
            { key: 'csv', label: 'CSV', icon: '📊' },
            { key: 'pdf', label: 'PDF', icon: '📄' },
            { key: 'json', label: 'JSON', icon: '{ }' }
          ].map(item => (
            <button
              key={item.key}
              onClick={() => setFormat(item.key)}
              style={{
                flex: 1,
                padding: '.75rem',
                background: format === item.key 
                  ? 'rgba(0,212,255,.2)' 
                  : 'rgba(87,125,196,.1)',
                border: format === item.key 
                  ? '2px solid #00d4ff' 
                  : '1px solid rgba(87,125,196,.3)',
                borderRadius: '10px',
                color: format === item.key ? '#00d4ff' : '#8ab0c9',
                cursor: 'pointer',
                fontWeight: format === item.key ? 'bold' : 'normal'
              }}
            >
              <div style={{ fontSize: '1.5rem', marginBottom: '.25rem' }}>{item.icon}</div>
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {/* Export Button */}
      <button
        onClick={handleExport}
        disabled={exporting}
        style={{
          width: '100%',
          padding: '1rem',
          background: exporting 
            ? 'rgba(87,125,196,.2)' 
            : 'linear-gradient(135deg,#00d4ff,#8c4dff)',
          border: 'none',
          borderRadius: '12px',
          color: exporting ? '#8ab0c9' : '#03101c',
          fontWeight: 'bold',
          fontSize: '1rem',
          cursor: exporting ? 'not-allowed' : 'pointer',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          gap: '.75rem'
        }}
      >
        {exporting ? (
          <>⏳ Generating...</>
        ) : (
          <>📥 Export {format.toUpperCase()}</>
        )}
      </button>

      {/* Info */}
      <p style={{
        color: '#6a8aaa',
        fontSize: '.75rem',
        marginTop: '1rem',
        textAlign: 'center'
      }}>
        💡 Exports are generated server-side to minimize your device's CPU usage
      </p>
    </div>
  );
};

export default AuditLogExport;
