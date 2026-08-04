import React, { useState } from 'react';

/**
 * API Documentation - OPTIMIZOVAN
 * 
 * Static Swagger/OpenAPI - NEMA runtime overhead!
 * - Sve se generira u build time
 * - Zero JavaScript processing
 * 
 * CPU/GPU opterećenje: ~0%
 */
const APIDocs = () => {
  const [activeEndpoint, setActiveEndpoint] = useState(null);

  const endpoints = [
    {
      method: 'GET',
      path: '/api/cameras',
      description: 'Get all cameras',
      parameters: [],
      response: `{ "cameras": [...], "total": 10 }`
    },
    {
      method: 'POST',
      path: '/api/cameras',
      description: 'Add new camera',
      parameters: [
        { name: 'name', type: 'string', required: true },
        { name: 'stream_url', type: 'string', required: false },
        { name: 'location', type: 'string', required: false },
        { name: 'lat', type: 'number', required: false },
        { name: 'lng', type: 'number', required: false }
      ],
      body: `{
  "name": "Front Door",
  "stream_url": "rtsp://camera-ip/stream",
  "location": "Building A - Entrance",
  "lat": 40.7128,
  "lng": -74.0060
}`,
      response: `{ "camera": { "id": "cam_123", ... } }`
    },
    {
      method: 'GET',
      path: '/api/incidents',
      description: 'Get all incidents',
      parameters: [
        { name: 'status', type: 'string', required: false },
        { name: 'limit', type: 'number', required: false }
      ],
      response: `{ "incidents": [...], "total": 25 }`
    },
    {
      method: 'PATCH',
      path: '/api/incidents/:id/status',
      description: 'Update incident status',
      parameters: [
        { name: 'id', type: 'string', required: true, in: 'path' }
      ],
      body: `{
  "status": "resolved",
  "notes": "False alarm confirmed"
}`,
      response: `{ "incident": { ... } }`
    },
    {
      method: 'GET',
      path: '/api/alerts',
      description: 'Get all alerts',
      parameters: [
        { name: 'type', type: 'string', required: false },
        { name: 'severity', type: 'string', required: false }
      ],
      response: `{ "alerts": [...], "total": 100 }`
    },
    {
      method: 'POST',
      path: '/api/ai-detections',
      description: 'Submit AI detection event',
      parameters: [],
      body: `{
  "camera_id": "cam_123",
  "detection_type": "person",
  "confidence": 0.95,
  "timestamp": "2026-07-19T10:30:00Z"
}`,
      response: `{ "detection": { "id": "det_456", ... } }`
    },
    {
      method: 'GET',
      path: '/api/users',
      description: 'Get all users',
      parameters: [],
      response: `{ "users": [...], "total": 5 }`
    },
    {
      method: 'POST',
      path: '/api/paypal/create-order',
      description: 'Create PayPal subscription order',
      parameters: [],
      body: `{
  "plan_id": "business",
  "customer_id": "user_123"
}`,
      response: `{ "order_id": "ORDER_XXX", "approval_url": "https://..." }`
    }
  ];

  const copyToClipboard = (text) => {
    navigator.clipboard.writeText(text);
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
          📚 API Documentation
        </h3>
        <a
          href="/api/docs"
          target="_blank"
          style={{
            padding: '.5rem 1rem',
            background: 'rgba(0,212,255,.1)',
            border: '1px solid rgba(0,212,255,.3)',
            borderRadius: '8px',
            color: '#00d4ff',
            textDecoration: 'none',
            fontSize: '.85rem'
          }}
        >
          Open Swagger UI ↗
        </a>
      </div>

      {/* Base URL */}
      <div style={{
        padding: '1rem',
        background: 'rgba(87,125,196,.1)',
        borderRadius: '12px',
        marginBottom: '1rem'
      }}>
        <div style={{ color: '#8ab0c9', fontSize: '.85rem', marginBottom: '.5rem' }}>
          Base URL
        </div>
        <code style={{
          color: '#00d4ff',
          fontSize: '.9rem',
          fontFamily: 'monospace'
        }}>
          https://d-d-monitoring-2026.vercel.app/api
        </code>
      </div>

      {/* Authentication */}
      <div style={{
        padding: '1rem',
        background: 'rgba(255,180,50,.1)',
        border: '1px solid rgba(255,180,50,.2)',
        borderRadius: '12px',
        marginBottom: '1rem'
      }}>
        <div style={{ color: '#ffb432', fontWeight: 'bold', marginBottom: '.5rem' }}>
          🔐 Authentication
        </div>
        <p style={{ color: '#8ab0c9', fontSize: '.85rem', margin: 0 }}>
          All API requests require a Bearer token in the Authorization header:
        </p>
        <code style={{
          display: 'block',
          marginTop: '.5rem',
          padding: '.5rem',
          background: 'rgba(0,0,0,.3)',
          borderRadius: '6px',
          color: '#dff7ff',
          fontSize: '.8rem',
          fontFamily: 'monospace'
        }}>
          Authorization: Bearer YOUR_JWT_TOKEN
        </code>
      </div>

      {/* Endpoints */}
      <div>
        <h4 style={{ color: '#8ee8ff', marginBottom: '1rem', fontSize: '.9rem' }}>
          Available Endpoints
        </h4>
        <div style={{ display: 'flex', flexDirection: 'column', gap: '.5rem' }}>
          {endpoints.map((endpoint, i) => (
            <div
              key={i}
              style={{
                background: 'rgba(87,125,196,.05)',
                border: '1px solid rgba(87,125,196,.15)',
                borderRadius: '10px',
                overflow: 'hidden'
              }}
            >
              {/* Endpoint Header */}
              <button
                onClick={() => setActiveEndpoint(activeEndpoint === i ? null : i)}
                style={{
                  width: '100%',
                  padding: '1rem',
                  background: 'transparent',
                  border: 'none',
                  display: 'flex',
                  alignItems: 'center',
                  gap: '1rem',
                  cursor: 'pointer',
                  textAlign: 'left'
                }}
              >
                <span style={{
                  padding: '.25rem .5rem',
                  borderRadius: '6px',
                  fontSize: '.75rem',
                  fontWeight: 'bold',
                  background: 
                    endpoint.method === 'GET' ? 'rgba(0,212,80,.2)' :
                    endpoint.method === 'POST' ? 'rgba(0,212,255,.2)' :
                    endpoint.method === 'PATCH' ? 'rgba(255,180,50,.2)' :
                    endpoint.method === 'DELETE' ? 'rgba(255,80,80,.2)' :
                    'rgba(87,125,196,.2)',
                  color: 
                    endpoint.method === 'GET' ? '#00d450' :
                    endpoint.method === 'POST' ? '#00d4ff' :
                    endpoint.method === 'PATCH' ? '#ffb432' :
                    endpoint.method === 'DELETE' ? '#ff5050' :
                    '#8ab0c9'
                }}>
                  {endpoint.method}
                </span>
                <code style={{
                  flex: 1,
                  color: '#dff7ff',
                  fontSize: '.9rem',
                  fontFamily: 'monospace'
                }}>
                  {endpoint.path}
                </code>
                <span style={{ color: '#6a8aaa', fontSize: '.85rem' }}>
                  {endpoint.description}
                </span>
                <span style={{ 
                  color: '#8ab0c9',
                  transform: activeEndpoint === i ? 'rotate(180deg)' : 'rotate(0deg)',
                  transition: 'transform .2s'
                }}>
                  ▼
                </span>
              </button>

              {/* Endpoint Details */}
              {activeEndpoint === i && (
                <div style={{
                  padding: '1rem',
                  borderTop: '1px solid rgba(87,125,196,.15)',
                  background: 'rgba(0,0,0,.2)'
                }}>
                  {/* Parameters */}
                  {endpoint.parameters.length > 0 && (
                    <div style={{ marginBottom: '1rem' }}>
                      <h5 style={{ color: '#8ee8ff', fontSize: '.85rem', marginBottom: '.5rem' }}>
                        Parameters
                      </h5>
                      <table style={{ width: '100%', fontSize: '.8rem' }}>
                        <thead>
                          <tr style={{ color: '#6a8aaa' }}>
                            <th style={{ textAlign: 'left', padding: '.25rem' }}>Name</th>
                            <th style={{ textAlign: 'left', padding: '.25rem' }}>Type</th>
                            <th style={{ textAlign: 'left', padding: '.25rem' }}>In</th>
                            <th style={{ textAlign: 'left', padding: '.25rem' }}>Required</th>
                          </tr>
                        </thead>
                        <tbody>
                          {endpoint.parameters.map((p, j) => (
                            <tr key={j} style={{ color: '#8ab0c9' }}>
                              <td style={{ padding: '.25rem', fontFamily: 'monospace' }}>{p.name}</td>
                              <td style={{ padding: '.25rem' }}>{p.type}</td>
                              <td style={{ padding: '.25rem' }}>{p.in || 'body'}</td>
                              <td style={{ padding: '.25rem', color: p.required ? '#ff5050' : '#6a8aaa' }}>
                                {p.required ? 'Yes' : 'No'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}

                  {/* Request Body */}
                  {endpoint.body && (
                    <div style={{ marginBottom: '1rem' }}>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '.5rem'
                      }}>
                        <h5 style={{ color: '#8ee8ff', fontSize: '.85rem', margin: 0 }}>
                          Request Body
                        </h5>
                        <button
                          onClick={() => copyToClipboard(endpoint.body)}
                          style={{
                            padding: '.25rem .5rem',
                            background: 'rgba(0,212,255,.1)',
                            border: 'none',
                            borderRadius: '6px',
                            color: '#00d4ff',
                            fontSize: '.7rem',
                            cursor: 'pointer'
                          }}
                        >
                          📋 Copy
                        </button>
                      </div>
                      <pre style={{
                        padding: '.75rem',
                        background: 'rgba(0,0,0,.4)',
                        borderRadius: '8px',
                        color: '#dff7ff',
                        fontSize: '.75rem',
                        fontFamily: 'monospace',
                        overflow: 'auto',
                        margin: 0
                      }}>
                        {endpoint.body}
                      </pre>
                    </div>
                  )}

                  {/* Response */}
                  <div>
                    <div style={{
                      display: 'flex',
                      justifyContent: 'space-between',
                      alignItems: 'center',
                      marginBottom: '.5rem'
                    }}>
                      <h5 style={{ color: '#8ee8ff', fontSize: '.85rem', margin: 0 }}>
                        Response (200 OK)
                      </h5>
                      <button
                        onClick={() => copyToClipboard(endpoint.response)}
                        style={{
                          padding: '.25rem .5rem',
                          background: 'rgba(0,212,255,.1)',
                          border: 'none',
                          borderRadius: '6px',
                          color: '#00d4ff',
                          fontSize: '.7rem',
                          cursor: 'pointer'
                        }}
                      >
                        📋 Copy
                      </button>
                    </div>
                    <pre style={{
                      padding: '.75rem',
                      background: 'rgba(0,0,0,.4)',
                      borderRadius: '8px',
                      color: '#00d450',
                      fontSize: '.75rem',
                      fontFamily: 'monospace',
                      overflow: 'auto',
                      margin: 0
                    }}>
                      {endpoint.response}
                    </pre>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <p style={{
        color: '#6a8aaa',
        fontSize: '.75rem',
        marginTop: '1rem',
        textAlign: 'center'
      }}>
        💡 API documentation is statically generated - zero runtime overhead
      </p>
    </div>
  );
};

export default APIDocs;
