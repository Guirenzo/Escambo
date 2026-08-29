import { LoginForm } from './features/auth/LoginForm';
import { Shell } from './features/shell/Shell';
import { useAuth } from './lib/auth';
import './styles.css';

export function App() {
  const { user, loading } = useAuth();
  if (loading) return <div className="splash">Carregando…</div>;
  return user ? <Shell /> : <LoginForm />;
}
