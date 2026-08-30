import { useNavigate } from 'react-router-dom';

export default function BackToDashboard() {
  const navigate = useNavigate();

  return (
    <button
      onClick={() => navigate('/dashboard')}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: '.5rem',
        padding: '.5rem 1rem',
        marginBottom: '1.5rem',
        background: 'rgba(255,255,255,0.04)',
        color: '#dfe9f2',
        border: '1px solid rgba(87,140,255,.25)',
        borderRadius: '999px',
        cursor: 'pointer',
        fontSize: '.85rem',
        fontWeight: 600,
        transition: 'all .2s',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = 'rgba(0,212,255,.15)';
        e.currentTarget.style.borderColor = 'rgba(0,212,255,.5)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = 'rgba(255,255,255,0.04)';
        e.currentTarget.style.borderColor = 'rgba(87,140,255,.25)';
      }}
    >
      ← Dashboard
    </button>
  );
}
