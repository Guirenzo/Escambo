import { ArrowLeftRight, Coins, ShieldCheck, type LucideIcon } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button, Field, Input, Select } from '../../components/ui';
import { useAuth } from '../../lib/auth';

const HIGHLIGHTS: { Icon: LucideIcon; title: string; text: string }[] = [
  { Icon: ArrowLeftRight, title: 'Troque serviço por serviço', text: 'O escambo que dá nome ao app — com torna justa e escrow.' },
  { Icon: Coins, title: 'Créditos Escambo', text: 'Trabalhe, ganhe créditos e gaste em qualquer serviço.' },
  { Icon: ShieldCheck, title: 'Confiança de verdade', text: 'Escambo Score, pagamento protegido e chat em tempo real.' },
];

export function LoginForm() {
  const { login, register, error } = useAuth();
  const [mode, setMode] = useState<'login' | 'register'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'client' | 'freelancer'>('client');
  const [loading, setLoading] = useState(false);

  async function handleSubmit(e: FormEvent): Promise<void> {
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
      <section className="auth-hero">
        <div className="brand brand-light">
          <span className="brand-mark">
            <ArrowLeftRight size={18} strokeWidth={2.5} />
          </span>
          <span className="brand-name">Escambo</span>
        </div>
        <h1>
          Troque. Contrate.
          <br />
          <span className="accent">Evolua.</span>
        </h1>
        <p className="lead">O iFood dos serviços — do mecânico ao dev, com a confiança que faltava.</p>
        <ul className="highlights">
          {HIGHLIGHTS.map(({ Icon, title, text }) => (
            <li key={title}>
              <span className="hl-ico">
                <Icon size={18} />
              </span>
              <div>
                <strong>{title}</strong>
                <span>{text}</span>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <section className="auth-panel">
        <form className="card auth-card" onSubmit={handleSubmit}>
          <div className="tabs">
            <button type="button" className={mode === 'login' ? 'active' : ''} onClick={() => setMode('login')}>
              Entrar
            </button>
            <button type="button" className={mode === 'register' ? 'active' : ''} onClick={() => setMode('register')}>
              Criar conta
            </button>
          </div>
          <h2>{mode === 'login' ? 'Bem-vindo de volta' : 'Crie sua conta'}</h2>
          <Field label="E-mail">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              placeholder="voce@exemplo.com"
              autoComplete="email"
            />
          </Field>
          <Field label="Senha">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              placeholder="••••••••"
              autoComplete={mode === 'login' ? 'current-password' : 'new-password'}
            />
          </Field>
          {mode === 'register' && (
            <Field label="Eu sou">
              <Select value={role} onChange={(e) => setRole(e.target.value as 'client' | 'freelancer')}>
                <option value="client">Cliente — quero contratar</option>
                <option value="freelancer">Freelancer — quero oferecer</option>
              </Select>
            </Field>
          )}
          {error && <p className="error">{error}</p>}
          <Button type="submit" disabled={loading} className="full">
            {loading ? '…' : mode === 'login' ? 'Entrar' : 'Criar conta'}
          </Button>
          <p className="muted tiny center">
            {mode === 'login' ? 'Novo por aqui? ' : 'Já tem conta? '}
            <button type="button" className="link" onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
              {mode === 'login' ? 'Crie sua conta' : 'Entrar'}
            </button>
          </p>
        </form>
      </section>
    </main>
  );
}
