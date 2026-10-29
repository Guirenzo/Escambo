import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useLocation, useNavigate } from 'react-router-dom';
import type { GoogleSignupChallenge, MfaChallenge } from '@escambo/types';
import { BrandMark } from '../../components/BrandMark';
import { Button, Field, Select, Spinner } from '../../components/ui';
import { GOOGLE_START_URL } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { errorMessage } from '../../lib/errors';
import { forgetGoogleRole, googleRole, rememberSuggestedName } from '../../lib/google';
import { usePageTitle } from '../../lib/title';
import { AuthPanel } from './AuthPanel';
import { MfaStep } from './LoginForm';
import './auth.css';

/**
 * A volta do Google (RF-002), em /entrar/google#codigo=…: a API não põe sessão no endereço, só
 * um código de uso único no fragmento (não vai ao servidor do web nem ao Referer). A tela tira o
 * código do endereço na hora e o troca uma vez: entra, ou pede o código da verificação em duas
 * etapas, ou abre "Concluir cadastro" para a conta Google que ainda não tem conta no Escambo.
 */

type Phase =
  | { kind: 'loading' }
  | { kind: 'mfa'; challenge: MfaChallenge }
  | { kind: 'signup'; challenge: GoogleSignupChallenge }
  | { kind: 'error'; message: string };

const NO_CODE =
  'O endereço de volta do Google não trouxe um código válido. Comece de novo pelo botão "Entrar com Google".';

/** A moldura das telas de entrar: a marca, o cartão e o painel escuro ao lado. */
function AuthFrame({ children }: { children: ReactNode }) {
  return (
    <main className="au">
      <div className="au-side">
        <div className="au-top">
          <Link to="/" className="brand au-brand">
            <BrandMark />
            <span className="brand-name">Escambo</span>
          </Link>
        </div>
        <div className="au-body">{children}</div>
      </div>
      <AuthPanel />
    </main>
  );
}

/** O primeiro nome, para o cumprimento ("Ana Souza" → "Ana"). */
const firstName = (name: string | null): string | null => name?.trim().split(/\s+/)[0] || null;

/**
 * "Concluir cadastro": a conta Google ainda não tem conta no Escambo. Os mesmos passos do cadastro,
 * menos a senha: o papel e o aceite dos Termos e da Política (empresa continua pelo cadastro com
 * CNPJ). O e-mail é o que o Google confirmou.
 */
function CompleteSignup({
  challenge,
  onExpired,
}: {
  challenge: GoogleSignupChallenge;
  onExpired: (message: string) => void;
}) {
  const { completeGoogleSignup } = useAuth();
  const [role, setRole] = useState<'client' | 'freelancer'>(() => googleRole() ?? 'client');
  const [accepted, setAccepted] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const hello = firstName(challenge.name);

  // A tela troca de "Entrando…" para o formulário: o foco vai ao título, que diz onde a pessoa está.
  // O papel lembrado do cadastro já foi lido: sai da aba.
  useEffect(() => {
    headingRef.current?.focus();
    forgetGoogleRole();
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setError(null);
    try {
      await completeGoogleSignup({ signupToken: challenge.signupToken, role, legalAccepted: true });
      // O nome da conta Google vira a sugestão do nome no Perfil (a pessoa confirma ao salvar).
      rememberSuggestedName(challenge.name);
    } catch (er) {
      setSaving(false);
      const code = (er as { code?: unknown } | null)?.code;
      const message = errorMessage(er, 'Não foi possível criar a conta. Tente de novo.');
      // O passe venceu ou a conta passou a existir: só recomeçar pelo Google resolve.
      if (code === 'invalid_signup_token' || code === 'email_taken') return onExpired(message);
      setError(message);
    }
  }

  return (
    <form className="au-card" onSubmit={(e) => void submit(e)} aria-labelledby={titleId}>
      <div className="au-head">
        <h1 id={titleId} className="au-title" ref={headingRef} tabIndex={-1}>
          Concluir cadastro
        </h1>
        <p className="au-sub">
          {hello ? `Falta pouco, ${hello}. ` : 'Falta pouco. '}A conta vai entrar com o Google de{' '}
          <strong className="email-addr">{challenge.email}</strong>, já confirmado.
        </p>
      </div>
      <Field label="Eu sou">
        <Select
          value={role}
          onChange={(e) => setRole(e.target.value as 'client' | 'freelancer')}
          aria-describedby="google-role-hint"
        >
          <option value="client">Cliente — quero contratar</option>
          <option value="freelancer">Freelancer — quero oferecer</option>
        </Select>
      </Field>
      <p className="muted tiny" id="google-role-hint">
        Com a mesma conta você também contrata e oferece serviços. Empresa?{' '}
        <Link to="/cadastro?perfil=empresa">Cadastre com o CNPJ</Link>.
      </p>
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
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      <Button type="submit" className="full au-submit" disabled={saving || !accepted}>
        {saving ? '…' : 'Criar conta'}
      </Button>
      <p className="au-alt">
        <Link to="/login">Voltar para entrar</Link>
      </p>
    </form>
  );
}

export function GoogleReturnView() {
  const { user, loading, loginWithGoogle } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  /** O código vale uma vez: a troca não se repete (o StrictMode roda o efeito duas vezes). */
  const started = useRef(false);
  usePageTitle(phase.kind === 'signup' ? 'Concluir cadastro' : 'Entrar com Google');

  useEffect(() => {
    // Espera a sessão guardada ser conferida: quem já está dentro não troca código nenhum (um
    // endereço com o código de outra pessoa não troca a conta aberta) e vai para o Início, que
    // substitui este endereço no histórico.
    if (loading || user || started.current) return;
    started.current = true;
    const code = new URLSearchParams(location.hash.replace(/^#/, '')).get('codigo');
    // O código sai do endereço antes de qualquer coisa: não fica no histórico nem num favorito.
    navigate(location.pathname, { replace: true });
    if (!code) {
      setPhase({ kind: 'error', message: NO_CODE });
      return;
    }
    loginWithGoogle(code)
      .then((next) => {
        if (next && 'mfaRequired' in next) setPhase({ kind: 'mfa', challenge: next });
        else if (next) setPhase({ kind: 'signup', challenge: next });
      })
      .catch((er: unknown) =>
        setPhase({
          kind: 'error',
          message: errorMessage(er, 'Não foi possível entrar com o Google. Tente de novo.'),
        }),
      );
  }, [loading, user, location.hash, location.pathname, loginWithGoogle, navigate]);

  // Com a sessão aberta (direto, depois da 2FA ou do cadastro), vai para o Início.
  if (user) return <Navigate to="/" replace />;

  const fail = (message: string): void => setPhase({ kind: 'error', message });

  return (
    <AuthFrame>
      {phase.kind === 'loading' && (
        <div className="au-card au-google-wait">
          <Spinner label="Entrando com o Google…" />
        </div>
      )}
      {phase.kind === 'mfa' && (
        <MfaStep
          email={null}
          challenge={phase.challenge}
          onBack={() => navigate('/login', { replace: true })}
          onExpired={() =>
            fail('O tempo para digitar o código acabou. Entre de novo com o Google ou com a senha.')
          }
        />
      )}
      {phase.kind === 'signup' && <CompleteSignup challenge={phase.challenge} onExpired={fail} />}
      {phase.kind === 'error' && (
        <div className="au-card">
          <div className="au-head">
            <h1 className="au-title">Não foi possível entrar com o Google</h1>
            <p className="error" role="alert">
              {phase.message}
            </p>
          </div>
          <a className="btn secondary au-google-btn" href={GOOGLE_START_URL}>
            Tentar de novo com o Google
          </a>
          <p className="au-alt">
            <Link to="/login">Voltar para entrar</Link>
          </p>
        </div>
      )}
    </AuthFrame>
  );
}
