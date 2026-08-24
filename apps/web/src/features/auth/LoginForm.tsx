import { useState, type FormEvent } from 'react';
import { useAuth } from './useAuth';

export function LoginForm() {
  const { auth, error, loading, login, logout } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    void login({ email, password });
  }

  if (auth) {
    return (
      <div className="card">
        <div className="ok-badge">✓ Autenticado</div>
        <p className="lead">
          <strong>{auth.user.email}</strong>
          <span className="role">{auth.user.role}</span>
        </p>
        <p className="token">access: {auth.accessToken.slice(0, 28)}…</p>
        <button className="ghost" onClick={logout}>
          Sair
        </button>
      </div>
    );
  }

  return (
    <form className="card" onSubmit={handleSubmit}>
      <h2>Entrar</h2>
      <label>
        E-mail
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="voce@exemplo.com"
          required
        />
      </label>
      <label>
        Senha
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          placeholder="••••••••"
          required
        />
      </label>
      {error && <p className="error">{error}</p>}
      <button type="submit" disabled={loading}>
        {loading ? 'Entrando…' : 'Entrar'}
      </button>
    </form>
  );
}
