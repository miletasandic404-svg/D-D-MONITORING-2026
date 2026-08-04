import React, { useState, useEffect } from 'react';

// Dark Mode koristi SAMO CSS - NEMA JavaScript processing!
const DarkMode = () => {
  const [isDark, setIsDark] = useState(() => {
    const saved = localStorage.getItem('theme');
    if (saved) return saved === 'dark';
    return window.matchMedia('(prefers-color-scheme: dark)').matches;
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', isDark ? 'dark' : 'light');
    localStorage.setItem('theme', isDark ? 'dark' : 'light');
  }, [isDark]);

  return (
    <button
      onClick={() => setIsDark(!isDark)}
      style={{
        background: 'rgba(87,125,196,.15)',
        border: '1px solid rgba(87,125,196,.3)',
        borderRadius: '10px',
        padding: '.5rem .75rem',
        cursor: 'pointer',
        display: 'flex',
        alignItems: 'center',
        gap: '.5rem',
        color: '#8ab0c9',
        fontSize: '.85rem'
      }}
      title={isDark ? 'Switch to Light Mode' : 'Switch to Dark Mode'}
    >
      {isDark ? '☀️' : '🌙'}
      <span>{isDark ? 'Light' : 'Dark'}</span>
    </button>
  );
};

export default DarkMode;
