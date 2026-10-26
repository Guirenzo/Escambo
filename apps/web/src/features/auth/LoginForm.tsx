import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import type { MfaChallenge } from '@escambo/types';
import { Button, Field, Input, Select } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';
import { normalizeRecoveryCode, normalizeTotp } from '../../lib/mfa';
import { usePageTitle } from '../../lib/title';
import { AuthPanel } from './AuthPanel';
import './auth.css';
import { BrandMark } from '../../components/BrandMark';

/**
 * Passo 2 do login numa conta com verificação em duas etapas (RF-090): a senha já foi conferida e
 * falta o código do app autenticador, ou um de recuperação para quem está sem o celular.
 */
function MfaStep({
  email,
  challenge,
  onBack,
  onExpired,
}: {
  email: string;
  challenge: MfaChallenge;
  onBack: () => void;
  onExpired: () => void;
}) {
  const { loginMfa } = useAuth();
  const [recovery, setRecovery] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const titleId = useId();
  const hintId = useId();
  const errorId = useId();

  // O passo toma o lugar do formulário da senha (e trocar o tipo de código troca o campo): o foco
  // vai para o campo novo, que é o que a pessoa precisa preencher.
  useEffect(() => {
    inputRef.current?.focus();
  }, [recovery]);

  function fail(message: string, onField: boolean): void {
    setError(message);
    setInvalid(onField);
    inputRef.current?.focus();
  }

  function toggle(): void {
    setRecovery((r) => !r);
    setCode('');
    setError(null);
    setInvalid(false);
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const value = recovery ? normalizeRecoveryCode(code) : normalizeTotp(code);
    if (!value) {
      return fail(
        recovery
          ? 'Digite o código de recuperação inteiro, no formato XXXX-XXXX.'
          : 'Digite os 6 dígitos que o app mostra agora.',
        true,
      );
    }
    setLoading(true);
    setError(null);
    setInvalid(false);
    try {
      await loginMfa({ mfaToken: challenge.mfaToken, code: value });
    } catch (er) {
      setLoading(false);
      const kind = (er as { code?: unknown } | null)?.code;
      // O pedido do segundo fator venceu (vale alguns minutos): recomeça pela senha, com o aviso.
      if (kind === 'invalid_mfa_token') return onExpired();
      fail(
        errorMessage(er, 'Não foi possível entrar. Tente de novo.'),
        kind === 'invalid_mfa_code',
      );
    }
  }

  return (
    <form className="au-card" onSubmit={(e) => void submit(e)} aria-labelledby={titleId}>
      <h1 id={titleId} className="au-title">
        Verificação em duas etapas
      </h1>
      <p className="au-sub">
        Entrando como <strong className="email-addr">{email}</strong>.
      </p>
      <Field label={recovery ? 'Código de recuperação' : 'Código do app autenticador'}>
        <input
          key={recovery ? 'recuperacao' : 'app'}
          ref={inputRef}
          value={code}
          onChange={(e) => setCode(e.target.value)}
          required
          inputMode={recovery ? 'text' : 'numeric'}
          autoComplete={recovery ? 'off' : 'one-time-code'}
          autoCapitalize={recovery ? 'characters' : 'off'}
          spellCheck={false}
          maxLength={recovery ? 11 : 7}
          placeholder={recovery ? 'XXXX-XXXX' : '123456'}
          aria-invalid={invalid}
          aria-describedby={error ? `${hintId} ${errorId}` : hintId}
        />
      </Field>
      <p className="muted tiny" id={hintId}>
        {recovery
          ? 'Um dos códigos que você guardou ao ativar a verificação. Cada um vale uma vez só.'
          : 'Abra o app autenticador no celular e digite o código de 6 dígitos da conta Escambo.'}
      </p>
      {error && (
        <p className="error" id={errorId} role="alert">
          {error}
        </p>
      )}
      <Button type="submit" disabled={loading} className="full au-submit">
        {loading ? '…' : 'Confirmar'}
      </Button>
      <p className="muted tiny center">
        <button type="button" className="link mfa-link" onClick={toggle}>
          {recovery ? 'Usar o código do app' : 'Usar um código de recuperação'}
        </button>
      </p>
      <p className="muted tiny center">
        <button type="button" className="link mfa-link" onClick={onBack}>
          Voltar
        </button>
      </p>
    </form>
  );
}

export type AuthMode = 'login' | 'register';
export type SignupRole = 'client' | 'freelancer';

/**
 * Entrar e criar conta no mesmo formulário. /login abre em "Entrar"; /cadastro, em "Criar conta",
 * com o "Eu sou" já escolhido por ?perfil= (ver App). Trocar de modo troca o endereço junto (sem
 * empilhar no histórico e guardando para onde voltar depois), e o título da aba acompanha.
 */
export function LoginForm({
  initialMode = 'login',
  initialRole = 'client',
}: {
  initialMode?: AuthMode;
  initialRole?: SignupRole;
} = {}) {
  const { login, register, error } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [mode, setMode] = useState<AuthMode>(initialMode);
  usePageTitle(mode === 'login' ? 'Entrar' : 'Criar conta');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<SignupRole>(initialRole);
  const [loading, setLoading] = useState(false);
  const [accepted, setAccepted] = useState(false);
  /** Senha certa numa conta com 2FA: o passo 2 toma o lugar do formulário. */
  const [challenge, setChallenge] = useState<MfaChallenge | null>(null);
  /** Aviso ao voltar do passo 2 sem entrar (o pedido do código venceu). */
  const [notice, setNotice] = useState<string | null>(null);
  const [focusPassword, setFocusPassword] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);

  // De volta do passo 2, o e-mail continua preenchido: o foco vai para a senha.
  useEffect(() => {
    if (!focusPassword || challenge) return;
    passwordRef.current?.focus();
    setFocusPassword(false);
  }, [focusPassword, challenge]);

  async function handleSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setLoading(true);
    setNotice(null);
    try {
      if (mode === 'login') {
        const next = await login({ email, password });
        if (next) setChallenge(next);
      } else await register({ email, password, role, legalAccepted: true });
    } catch {
      /* erro exibido pelo contexto */
    } finally {
      setLoading(false);
    }
  }

  function switchMode(next: AuthMode): void {
    setMode(next);
    const path = next === 'login' ? '/login' : '/cadastro';
    if (location.pathname !== path) navigate(path, { replace: true, state: location.state });
  }

  /** Sai do passo 2: a senha é pedida de novo (o pedido do código não vale mais para nada). */
  function leaveMfa(message: string | null): void {
    setChallenge(null);
    setPassword('');
    setNotice(message);
    setFocusPassword(true);
  }

  return (
    <main className="au">
      <div className="au-side">
        <div className="au-top">
          <Link to="/" className="brand au-brand">
            <BrandMark />
            <span className="brand-name">Escambo</span>
          </Link>
        </div>
        <div className="au-body">
          {challenge ? (
            <MfaStep
              email={email}
              challenge={challenge}
              onBack={() => leaveMfa(null)}
              onExpired={() =>
                leaveMfa('O tempo para digitar o código acabou. Entre de novo com a sua senha.')
              }
            />
          ) : (
            <form className="au-card" onSubmit={handleSubmit}>
              {/* Os dois modos são botões de alternância: o estado sai em aria-pressed, não só na cor. */}
              <div className="au-switch" role="group" aria-label="Entrar ou criar conta">
                <button
                  type="button"
                  className={mode === 'login' ? 'active' : ''}
                  aria-pressed={mode === 'login'}
                  onClick={() => switchMode('login')}
                >
                  Entrar
                </button>
                <button
                  type="button"
                  className={mode === 'register' ? 'active' : ''}
                  aria-pressed={mode === 'register'}
                  onClick={() => switchMode('register')}
                >
                  Criar conta
                </button>
              </div>
              <div className="au-head">
                <h1 className="au-title">
                  {mode === 'login' ? 'Bem-vindo de volta' : 'Crie sua conta'}
                </h1>
                <p className="au-sub">
                  {mode === 'login'
                    ? 'Entre para contratar, trocar e acompanhar as suas contratações.'
                    : 'É grátis. Com a mesma conta você contrata e oferece serviços.'}
                </p>
              </div>
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
                <input
                  ref={passwordRef}
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
                  <Select value={role} onChange={(e) => setRole(e.target.value as SignupRole)}>
                    <option value="client">Cliente — quero contratar</option>
                    <option value="freelancer">Freelancer — quero oferecer</option>
                  </Select>
                </Field>
              )}
              {mode === 'register' && (
                <label className="consent">
                  <input
                    type="checkbox"
                    checked={accepted}
                    onChange={(e) => setAccepted(e.target.checked)}
                    required
                  />
                  <span>
                    Li e aceito os{' '}
                    <a href="/termos" target="_blank" rel="noreferrer">
                      Termos de Uso
                    </a>{' '}
                    e a{' '}
                    <a href="/privacidade" target="_blank" rel="noreferrer">
                      Política de Privacidade
                    </a>
                    .
                  </span>
                </label>
              )}
              {mode === 'login' && (
                <p className="au-forgot">
                  <Link to="/esqueci-senha">Esqueci minha senha</Link>
                </p>
              )}
              {notice && (
                <p className="error" role="alert">
                  {notice}
                </p>
              )}
              {error && (
                <p className="error" role="alert">
                  {error}
                </p>
              )}
              <Button
                type="submit"
                disabled={loading || (mode === 'register' && !accepted)}
                className="full au-submit"
              >
                {loading ? '…' : mode === 'login' ? 'Entrar' : 'Criar conta'}
              </Button>
              <p className="au-alt">
                {mode === 'login' ? 'Novo por aqui? ' : 'Já tem conta? '}
                <button
                  type="button"
                  className="link"
                  onClick={() => switchMode(mode === 'login' ? 'register' : 'login')}
                >
                  {mode === 'login' ? 'Crie sua conta' : 'Entrar'}
                </button>
              </p>
            </form>
          )}
        </div>
      </div>
      <AuthPanel />
    </main>
  );
}
