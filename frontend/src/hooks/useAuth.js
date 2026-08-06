import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { getSession, signOut } from '../services/auth-client';

export function useAuth() {
  const navigate = useNavigate();
  const [authChecked, setAuthChecked] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);

  useEffect(() => {
    (async () => {
      try {
        const session = await getSession();
        if (!session || !session.user) {
          localStorage.removeItem('currentUser');
          await signOut();
          navigate('/', { replace: true });
        } else {
          localStorage.setItem('currentUser', JSON.stringify(session.user));
          setCurrentUser(session.user);
          setAuthChecked(true);
        }
      } catch (err) {
        localStorage.removeItem('currentUser');
        navigate('/', { replace: true });
      }
    })();
  }, [navigate]);

  return { authChecked, currentUser };
}
