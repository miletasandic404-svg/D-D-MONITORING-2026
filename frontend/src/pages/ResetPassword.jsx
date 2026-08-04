import React, { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';

const PAGE_CSS = `
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  .pg{position:relative;min-height:100vh;width:100%;overflow-x:hidden;font-family:'Space Grotesk',sans-serif;color:var(--text-primary, #e5eef7);background:radial-gradient(circle at 16% 18%,rgba(0,212,255,.15),transparent 24%),radial-gradient(circle at 82% 14%,rgba(52,120,255,.12),transparent 22%),linear-gradient(180deg,#050b16 0%,#040914 60%,#030710 100%);display:flex;align-items:center;justify-content:center;}
  .pg::before{content:'';position:fixed;inset:0;background:linear-gradient(rgba(87,125,196,.06) 1px,transparent 1px),linear-gradient(90deg,rgba(87,125,196,.05) 1px,transparent 1px);background-size:68px 68px;opacity:.18;pointer-events:none;z-index:0;}
  .card{position:relative;z-index:1;max-width:420px;width:100%;margin:2rem;border-radius:24px;padding:2.5rem 2rem;background:linear-gradient(160deg,rgba(10,14,32,.97),rgba(4,7,18,.98));border:1px solid rgba(128,165,255,.2);box-shadow:0 8px 40px rgba(0,0,0,.5),0 0 30px rgba(135,62,255,.1);}
  .kicker{font-size:.7rem;letter-spacing:.34em;text-transform:uppercase;color:#8ee8ff;margin-bottom:.3rem;}
  .title{font-family:'Orbitron',sans-serif;font-size:1.2rem;font-weight:700;text-transform:uppercase;letter-spacing:.14em;color:var(--text-primary, #dff7ff);margin-bottom:.5rem;}
  .desc{color:var(--text-secondary, #8ab0c9);line-height:1.65;font-size:.88rem;margin-bottom:1.6rem;}
  .form{display:grid;gap:1.1rem;}
  .field{display:grid;gap:.45rem;}
  .field span{font-size:.7rem;text-transform:uppercase;letter-spacing:.18em;color:#8ccfff;}
  .field input{width:100%;border-radius:12px;border:1px solid rgba(109,162,255,.22);background:rgba(4,10,28,.86);color:#ecf7ff;padding:.9rem 1rem;outline:none;font-family:inherit;font-size:1rem;transition:border-color 180ms,box-shadow 180ms;}
  .field input::placeholder{color:var(--text-muted, #6a8aaa);}
  .field input:focus{border-color:rgba(80,208,255,.75);box-shadow:0 0 0 1px rgba(67,206,255,.18),0 0 22px rgba(63,181,255,.18);}
  .btn{margin-top:.4rem;width:100%;border:0;border-radius:12px;padding:1.05rem;cursor:pointer;font-family:'Orbitron',sans-serif;font-weight:700;font-size:.82rem;text-transform:uppercase;letter-spacing:.2em;color:#03101c;background:linear-gradient(135deg,var(--accent-primary, #00d4ff) 0%,var(--accent-secondary, #8c4dff) 52%,#ff55cc 100%);box-shadow:0 4px 20px rgba(0,212,255,.2);transition:transform 180ms,filter 180ms;}
  .btn:hover{transform:translateY(-2px);filter:brightness(1.10);}
  .btn:disabled{opacity:.5;cursor:not-allowed;transform:none;filter:none;}
  .error{color:#ff7676;font-size:.83rem;margin-top:.75rem;padding:.75rem;border-radius:8px;background:rgba(255,118,118,.1);border:1px solid rgba(255,118,118,.2);}
  .success{color:var(--accent-success, #00d450);font-size:.83rem;margin-top:.75rem;padding:.75rem;border-radius:8px;background:rgba(0,212,80,.1);border:1px solid rgba(0,212,80,.2);}
  .loading{color:var(--text-secondary, #8ab0c9);font-size:.83rem;margin-top:.75rem;text-align:center;}
`;

export default function ResetPassword() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const token = searchParams.get('token') || searchParams.get('code') || '';
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(token ? '' : 'Invalid or expired reset link. Please request a new password reset from the login page.');
  const [success, setSuccess] = useState('');

  const handleResetPassword = async (e) => {
    e.preventDefault();
    setError('');
    setSuccess('');
    setLoading(true);

    if (password.length < 6) {
      setError('Password must be at least 6 characters long.');
      setLoading(false);
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match.');
      setLoading(false);
      return;
    }

    try {
      // Call Better Auth reset-password endpoint
      const res = await fetch('/api/auth/reset-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          newPassword: password,
          token: token,
        }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || data.message || 'Failed to reset password. The link may have expired.');
        setLoading(false);
        return;
      }

      setSuccess('Password updated successfully! Redirecting to login...');
      
      // Redirect to home after 2 seconds
      setTimeout(() => {
        navigate('/');
      }, 2000);
    } catch (err) {
      setError('Failed to update password: ' + err.message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <style>{PAGE_CSS}</style>
      <main className="pg">
        <div className="card">
          <p className="kicker">Password reset</p>
          <h1 className="title">SET NEW PASSWORD</h1>
          <p className="desc">Enter your new password below. Make sure it's secure and memorable.</p>

          <form onSubmit={handleResetPassword} className="form">
            <label className="field">
              <span>New Password</span>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Enter new password"
                required
                minLength={6}
                autoComplete="new-password"
              />
            </label>

            <label className="field">
              <span>Confirm Password</span>
              <input
                type="password"
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Confirm new password"
                required
                minLength={6}
                autoComplete="new-password"
              />
            </label>

            <button type="submit" className="btn" disabled={loading}>
              {loading ? 'Updating...' : 'Update Password'}
            </button>

            {error && <p className="error" role="alert">{error}</p>}
            {success && <p className="success" role="status">{success}</p>}
            {loading && <p className="loading">Updating your password...</p>}
          </form>
        </div>
      </main>
    </>
  );
}
