import { ArrowLeftRight, CheckCircle2, KeyRound, MailCheck, XCircle } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router-dom';
import { Button, Field, Input } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { usePageTitle } from '../../lib/title';

/** Página pública pequena (fora do app shell) com a marca e um cartão. */
function PublicCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="auth-simple">
      <Link to="/login" className="brand">
        <span className="brand-mark">
          <ArrowLeftRight size={18} strokeWidth={2.5} />
        </span>
        <span className="brand-name">Escambo</span>
      </Link>
      <section className="card auth-card">
        <h2>{title}</h2>
        {children}
      </section>
    </main>
  );
}

/** /esqueci-senha — pede o e-mail; a resposta é a mesma exista ou não a conta. */
export function ForgotPasswordView() {
  usePageTitle('Esqueci minha senha');
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setLoading(true);
    setError(null);
    try {
      await api.forgotPassword(email);
      setSent(true);
    } catch (er) {
      setError(er instanceof Error ? er.message : 'Erro ao enviar');
    } finally {
      setLoading(false);
    }
  }

  return (
    <PublicCard title="Esqueci minha senha">
      {sent ? (
        <div className="stack center" data-testid="forgot-sent">
          <span className="done-ico">
            <MailCheck size={28} />
          </span>
          <p className="muted">
            Se existir uma conta para <strong>{email}</strong>, enviamos um link para criar uma nova
            senha. Ele vale por 1 hora.
          </p>
          <Link to="/login">Voltar para entrar</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="stack">
          <p className="muted tiny">
            Informe o e-mail da sua conta. Você recebe um link para definir uma nova senha.
          </p>
          <Field label="E-mail">
            <Input
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              autoComplete="email"
              placeholder="voce@exemplo.com"
            />
          </Field>
          {error && <p className="error">{error}</p>}
          <Button type="submit" className="full" disabled={loading}>
            {loading ? '…' : 'Enviar link'}
          </Button>
          <p className="muted tiny center">
            <Link to="/login">Voltar para entrar</Link>
          </p>
        </form>
      )}
    </PublicCard>
  );
}

/** /redefinir-senha?token=… — define a nova senha com o token do e-mail. */
export function ResetPasswordView() {
  usePageTitle('Redefinir senha');
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const token = params.get('token') ?? '';
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (password !== confirm) {
      setError('As senhas não conferem');
      return;
    }
    setLoading(true);
    setError(null);
    try {
      await api.resetPassword(token, password);
      setDone(true);
      setTimeout(() => navigate('/login', { replace: true }), 2500);
    } catch (er) {
      setError(er instanceof Error ? er.message : 'Erro ao redefinir');
    } finally {
      setLoading(false);
    }
  }

  if (!token) {
    return (
      <PublicCard title="Redefinir senha">
        <p className="muted">Link incompleto. Peça um novo em "Esqueci minha senha".</p>
        <Link to="/esqueci-senha">Pedir novo link</Link>
      </PublicCard>
    );
  }

  return (
    <PublicCard title="Redefinir senha">
      {done ? (
        <div className="stack center" data-testid="reset-done">
          <span className="done-ico">
            <CheckCircle2 size={28} />
          </span>
          <p className="muted">
            Senha alterada. Todas as sessões anteriores foram encerradas; entre de novo.
          </p>
          <Link to="/login">Entrar</Link>
        </div>
      ) : (
        <form onSubmit={submit} className="stack">
          <Field label="Nova senha">
            <Input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
              placeholder="mínimo 8 caracteres"
            />
          </Field>
          <Field label="Confirmar nova senha">
            <Input
              type="password"
              value={confirm}
              onChange={(e) => setConfirm(e.target.value)}
              required
              minLength={8}
              autoComplete="new-password"
            />
          </Field>
          {error && <p className="error">{error}</p>}
          <Button type="submit" className="full" disabled={loading}>
            <KeyRound size={16} /> {loading ? '…' : 'Salvar nova senha'}
          </Button>
        </form>
      )}
    </PublicCard>
  );
}

/** /verificar-email?token=… — confirma o e-mail assim que abre. */
export function VerifyEmailView() {
  usePageTitle('Confirmar e-mail');
  const [params] = useSearchParams();
  const { user, refreshUser } = useAuth();
  const token = params.get('token') ?? '';
  const [state, setState] = useState<'loading' | 'ok' | 'error'>(token ? 'loading' : 'error');
  const [message, setMessage] = useState<string>(token ? '' : 'Link incompleto.');
  const ran = useRef(false);

  useEffect(() => {
    if (!token || ran.current) return;
    ran.current = true; // StrictMode monta duas vezes; o token é de uso único
    api
      .verifyEmail(token)
      .then(async () => {
        setState('ok');
        await refreshUser();
      })
      .catch((er: unknown) => {
        setState('error');
        setMessage(er instanceof Error ? er.message : 'Link inválido ou vencido');
      });
  }, [token, refreshUser]);

  return (
    <PublicCard title="Confirmação de e-mail">
      {state === 'loading' && <p className="muted">Confirmando…</p>}
      {state === 'ok' && (
        <div className="stack center" data-testid="verify-ok">
          <span className="done-ico">
            <CheckCircle2 size={28} />
          </span>
          <p className="muted">E-mail confirmado. Obrigado!</p>
          <Link to={user ? '/' : '/login'}>{user ? 'Ir para o app' : 'Entrar'}</Link>
        </div>
      )}
      {state === 'error' && (
        <div className="stack center" data-testid="verify-error">
          <span className="done-ico err">
            <XCircle size={28} />
          </span>
          <p className="muted">{message}</p>
          <Link to={user ? '/perfil' : '/login'}>{user ? 'Reenviar pelo app' : 'Entrar'}</Link>
        </div>
      )}
    </PublicCard>
  );
}
