import { useState, type FormEvent } from 'react';
import { useAuth } from '../../lib/auth';

export function LoginForm() {
  const { login, register, error } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'client' | 'freelancer'>('client');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      if (mode === 'login') await login({ email, password });
      else await register({ email, password, role });
    } catch {
      /* erro exibido pelo contexto */
    } finally {
      setLoading(false);
    }
  }

  return (
    <main className="auth">
      <div className="auth-hero">
        <h1>Escambo</h1>
        <p>O iFood dos serviços — contrate, troque, evolua.</p>
      </div>
      <form className="card auth-card" onSubmit={handleSubmit}>
        <div className="tabs">
          <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
            Entrar
          </button>
          <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
            Criar conta
          </button>
        </div>
        <label>
          E-mail
          <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required placeholder="voce@exemplo.com" />
        </label>
        <label>
          Senha
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} required placeholder="••••••••" />
        </label>
        {mode === 'register' && (
          <label>
            Eu sou
            <select value={role} onChange={(e) => setRole(e.target.value as 'client' | 'freelancer')}>
              <option value="client">Cliente</option>
              <option value="freelancer">Freelancer</option>
            </select>
          </label>
        )}
        {error && <p className="error">{error}</p>}
        <button type="submit" disabled={loading}>
          {loading ? '…' : mode === 'login' ? 'Entrar' : 'Criar conta'}
        </button>
      </form>
    </main>
  );
}
