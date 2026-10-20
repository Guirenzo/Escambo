import { useQueryClient } from '@tanstack/react-query';
import type { MfaSetup, MfaStatus } from '@escambo/types';
import { Copy, ShieldCheck } from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { QrCodeSvg } from '../../components/QrCodeSvg';
import { Button, Field, Modal, QueryState } from '../../components/ui';
import { api } from '../../lib/api';
import { errorMessage } from '../../lib/errors';
import { dt } from '../../lib/format';
import { qk, useMfaStatus } from '../../lib/hooks';
import { groupSecret, normalizeSecondFactor, normalizeTotp } from '../../lib/mfa';
import { useToast } from '../../lib/toast';
import { RecoveryCodes } from './RecoveryCodes';

/** Abaixo disto, o cartão avisa que é hora de gerar códigos novos. */
const FEW_CODES = 3;

const codeOf = (er: unknown): unknown => (er as { code?: unknown } | null)?.code;

/**
 * Verificação em duas etapas (RF-090, ADR 66): além da senha, o login pede o código de um app
 * autenticador. Não usa o formulário de negócio: é segurança da conta e vale também durante a
 * suspensão, como a troca de senha.
 *
 * Ativar: senha → QR (e a chave em texto, para quem não lê QR) → primeiro código → os códigos de
 * recuperação, mostrados uma vez. Ativa, gerar códigos novos e desativar pedem a senha e um
 * código do app ou de recuperação.
 */
export function DoisFatoresCard() {
  const status = useMfaStatus();
  return (
    <section
      className="card"
      id="dois-fatores"
      aria-labelledby="dois-fatores-title"
      data-testid="dois-fatores"
    >
      <div className="card-head">
        <h3 id="dois-fatores-title">
          <ShieldCheck size={16} /> Verificação em duas etapas
        </h3>
      </div>
      <QueryState
        isLoading={status.isLoading}
        error={status.error}
        data={status.data}
        onRetry={() => void status.refetch()}
      >
        {(s) => <DoisFatores status={s} />}
      </QueryState>
    </section>
  );
}

type Step = 'idle' | 'password' | 'scan' | 'codes';

function DoisFatores({ status: loaded }: { status: MfaStatus }) {
  const qc = useQueryClient();
  // Lida a cada render direto do cache: o que este cartão grava nele (ativou, desativou) vale já
  // nesta passada, e o foco encontra o botão certo em vez do que está saindo da tela.
  const status = qc.getQueryData<MfaStatus>(qk.mfaStatus) ?? loaded;
  const [step, setStep] = useState<Step>('idle');
  const [setup, setSetup] = useState<MfaSetup | null>(null);
  const [codes, setCodes] = useState<string[]>([]);
  const [modal, setModal] = useState<'disable' | 'regenerate' | null>(null);
  /** Para onde o foco volta quando um passo some da tela (senão ele cai no topo da página). */
  const [focusBack, setFocusBack] = useState<'activate' | 'summary' | null>(null);
  const activateRef = useRef<HTMLButtonElement>(null);
  const summaryRef = useRef<HTMLParagraphElement>(null);

  // Roda a cada render: o destino pode só aparecer depois que a situação relida chega.
  useEffect(() => {
    if (!focusBack) return;
    const target =
      focusBack === 'activate' ? (activateRef.current ?? summaryRef.current) : summaryRef.current;
    if (!target) return;
    target.focus();
    setFocusBack(null);
  });

  const refresh = (): void => void qc.invalidateQueries({ queryKey: qk.mfaStatus });

  /** Volta ao cartão; a situação é relida da API (outra aba pode ter mudado a 2FA). */
  function backToCard(focus: 'activate' | 'summary'): void {
    setStep('idle');
    setSetup(null);
    setCodes([]);
    setFocusBack(focus);
    refresh();
  }

  if (step === 'password') {
    return (
      <PasswordStep
        onCancel={() => backToCard('activate')}
        onReady={(next) => {
          setSetup(next);
          setStep('scan');
        }}
      />
    );
  }
  if (step === 'scan' && setup) {
    return (
      <ScanStep
        setup={setup}
        onCancel={() => backToCard('activate')}
        onRestart={() => {
          setSetup(null);
          setStep('password');
        }}
        onEnabled={(next) => {
          // A situação só é relida no "Concluir": uma falha nessa leitura trocaria o cartão pelo
          // erro e levaria junto os códigos, que não aparecem de novo.
          setCodes(next);
          setSetup(null);
          setStep('codes');
        }}
      />
    );
  }
  if (step === 'codes') {
    return (
      <RecoveryCodes
        codes={codes}
        onDone={() => {
          // Ativa a partir de agora: o cartão já mostra isso, e a leitura da API confirma.
          qc.setQueryData<MfaStatus>(qk.mfaStatus, (s) =>
            s
              ? {
                  ...s,
                  enabled: true,
                  confirmedAt: s.confirmedAt ?? new Date().toISOString(),
                  recoveryCodesLeft: codes.length,
                }
              : s,
          );
          backToCard('summary');
        }}
      />
    );
  }

  if (!status.enabled && !status.available) {
    return (
      <p className="muted" data-testid="mfa-indisponivel">
        A verificação em duas etapas ainda não está disponível: o servidor ainda não tem a chave de
        cifragem que protege o segredo do app autenticador. Quando ela for configurada, a ativação
        aparece aqui.
      </p>
    );
  }

  if (!status.enabled) {
    return (
      <div className="stack">
        <p className="muted tiny" ref={summaryRef} tabIndex={-1}>
          Além da senha, o login passa a pedir um código de 6 dígitos de um app autenticador no seu
          celular (Google Authenticator, Microsoft Authenticator, 2FAS, Aegis ou outro). Quem
          descobrir sua senha não entra sem ele.
        </p>
        {status.required && (
          <p className="notice" data-testid="mfa-obrigatoria">
            Sua conta é de administração: o painel só abre com a verificação em duas etapas ativa.
          </p>
        )}
        <div className="acts">
          <button type="button" ref={activateRef} onClick={() => setStep('password')}>
            <ShieldCheck size={16} /> Ativar
          </button>
        </div>
      </div>
    );
  }

  const left = status.recoveryCodesLeft;
  return (
    <div className="stack">
      <p ref={summaryRef} tabIndex={-1} data-testid="mfa-ativa">
        <strong>Ativa{status.confirmedAt ? ` desde ${dt(status.confirmedAt)}` : ''}.</strong> O
        login pede a senha e o código do app autenticador.
      </p>
      <p
        className={left <= FEW_CODES ? 'notice' : 'muted tiny'}
        data-testid="mfa-codigos-restantes"
      >
        Códigos de recuperação restantes: {left}.
        {left <= FEW_CODES ? ' Restam poucos: gere códigos novos e guarde-os.' : ''}
      </p>
      <div className="acts">
        <Button type="button" variant="secondary" onClick={() => setModal('regenerate')}>
          Gerar novos códigos
        </Button>
        <Button type="button" variant="danger" onClick={() => setModal('disable')}>
          Desativar
        </Button>
      </div>
      {modal && (
        <ConfirmModal
          kind={modal}
          onClose={() => {
            setModal(null);
            refresh();
          }}
          onDisabled={() => {
            setModal(null);
            // A situação nova entra na hora (o botão que abriu o diálogo some junto); a leitura
            // da API confirma em seguida.
            qc.setQueryData<MfaStatus>(qk.mfaStatus, (s) =>
              s ? { ...s, enabled: false, confirmedAt: null, recoveryCodesLeft: 0 } : s,
            );
            setFocusBack('activate');
            refresh();
          }}
        />
      )}
    </div>
  );
}

/** Ativar, passo 1: a senha confirma que é o titular e a API devolve o segredo novo. */
function PasswordStep({
  onCancel,
  onReady,
}: {
  onCancel: () => void;
  onReady: (setup: MfaSetup) => void;
}) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [wrong, setWrong] = useState(false);
  const [saving, setSaving] = useState(false);
  const passwordRef = useRef<HTMLInputElement>(null);
  const errorId = useId();

  useEffect(() => {
    passwordRef.current?.focus();
  }, []);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setSaving(true);
    setError(null);
    setWrong(false);
    try {
      onReady(await api.mfaSetup(password));
    } catch (er) {
      const code = codeOf(er);
      const message = errorMessage(er, 'Não foi possível começar a ativação. Tente de novo.');
      // Já ativa (outra aba) ou indisponível: o cartão relido mostra a situação certa.
      if (code === 'mfa_already_enabled' || code === 'mfa_unavailable') {
        toast.error(message);
        onCancel();
        return;
      }
      setError(message);
      setWrong(code === 'wrong_password');
      passwordRef.current?.focus();
      setSaving(false);
    }
  }

  return (
    <form
      className="stack"
      onSubmit={(e) => void submit(e)}
      aria-label="Ativar a verificação em duas etapas"
    >
      <p className="muted tiny">Para começar, confirme a senha da conta.</p>
      <Field label="Senha atual">
        <input
          ref={passwordRef}
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          required
          autoComplete="current-password"
          aria-invalid={wrong}
          aria-describedby={error ? errorId : undefined}
        />
      </Field>
      {error && (
        <p className="error" id={errorId} role="alert">
          {error}
        </p>
      )}
      <div className="acts">
        <Button type="submit" disabled={saving}>
          {saving ? 'Conferindo…' : 'Continuar'}
        </Button>
        <Button type="button" variant="secondary" onClick={onCancel}>
          Cancelar
        </Button>
      </div>
    </form>
  );
}

/** Ativar, passo 2: o app lê o QR (ou a chave digitada) e o primeiro código confirma. */
function ScanStep({
  setup,
  onCancel,
  onRestart,
  onEnabled,
}: {
  setup: MfaSetup;
  onCancel: () => void;
  onRestart: () => void;
  onEnabled: (recoveryCodes: string[]) => void;
}) {
  const toast = useToast();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLHeadingElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const errorId = useId();
  const secretId = useId();

  // O passo troca o formulário da senha: o foco vai para o título, de onde começa a instrução.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  function fail(message: string, onField: boolean): void {
    setError(message);
    setInvalid(onField);
    codeRef.current?.focus();
  }

  async function copySecret(): Promise<void> {
    try {
      await navigator.clipboard.writeText(setup.secret);
      toast.success('Chave copiada.');
    } catch {
      toast.info('Não deu para copiar daqui: selecione a chave e copie.');
    }
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const digits = normalizeTotp(code);
    if (!digits) return fail('Digite os 6 dígitos que o app mostra agora.', true);
    setSaving(true);
    setError(null);
    setInvalid(false);
    try {
      const res = await api.mfaEnable(digits);
      toast.success('Verificação em duas etapas ativada. As outras sessões foram encerradas.');
      onEnabled(res.recoveryCodes);
    } catch (er) {
      const kind = codeOf(er);
      const message = errorMessage(er, 'Não foi possível ativar. Tente de novo.');
      setSaving(false);
      // O segredo pendente sumiu (venceu ou outra aba começou de novo): recomeça pela senha.
      if (kind === 'mfa_not_started') {
        toast.error(message);
        onRestart();
        return;
      }
      if (kind === 'mfa_already_enabled') {
        toast.error(message);
        onCancel();
        return;
      }
      fail(message, kind === 'invalid_mfa_code');
    }
  }

  return (
    <div className="stack">
      <h4 className="mfa-step-title" ref={titleRef} tabIndex={-1}>
        Adicione a conta no app autenticador
      </h4>
      <p className="muted tiny">
        No app, escolha adicionar uma conta e aponte a câmera para o QR code. Sem câmera, ou usando
        leitor de tela, digite a chave que aparece em texto.
      </p>
      <div className="mfa-qr">
        <QrCodeSvg value={setup.otpauthUrl} label="QR code para o app autenticador" />
        <div className="stack">
          <p className="muted tiny" id={secretId}>
            Chave para digitar no app
          </p>
          <p className="mfa-secret" aria-labelledby={secretId} data-testid="mfa-secret">
            {groupSecret(setup.secret)}
          </p>
          <p className="muted tiny">
            Se o app perguntar: conta Escambo, baseada em tempo (TOTP), 6 dígitos, a cada 30
            segundos.
          </p>
          <div>
            <Button type="button" variant="secondary" onClick={() => void copySecret()}>
              <Copy size={14} /> Copiar chave
            </Button>
          </div>
        </div>
      </div>
      <form
        className="stack"
        onSubmit={(e) => void submit(e)}
        aria-label="Confirmar o código do app"
      >
        <Field label="Código do app autenticador">
          <input
            ref={codeRef}
            value={code}
            onChange={(e) => setCode(e.target.value)}
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={7}
            spellCheck={false}
            aria-invalid={invalid}
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          />
        </Field>
        <span className="muted tiny" id={hintId}>
          Os 6 dígitos que o app mostra agora para a conta Escambo (mudam a cada 30 segundos).
        </span>
        {error && (
          <p className="error" id={errorId} role="alert">
            {error}
          </p>
        )}
        <div className="acts">
          <Button type="submit" disabled={saving}>
            {saving ? 'Confirmando…' : 'Confirmar'}
          </Button>
          <Button type="button" variant="secondary" onClick={onCancel}>
            Cancelar
          </Button>
        </div>
      </form>
    </div>
  );
}

/**
 * Gerar códigos novos ou desativar: as duas pedem a senha e um código (do app ou de recuperação),
 * para quem pegou o aparelho destravado não conseguir tirar a proteção.
 */
function ConfirmModal({
  kind,
  onClose,
  onDisabled,
}: {
  kind: 'disable' | 'regenerate';
  onClose: () => void;
  onDisabled: () => void;
}) {
  const toast = useToast();
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [badField, setBadField] = useState<'password' | 'code' | null>(null);
  const [saving, setSaving] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  const codeRef = useRef<HTMLInputElement>(null);
  const hintId = useId();
  const errorId = useId();
  const disabling = kind === 'disable';

  function fail(message: string, field: 'password' | 'code' | null): void {
    setError(message);
    setBadField(field);
    if (field === 'password') passwordRef.current?.focus();
    else codeRef.current?.focus();
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const second = normalizeSecondFactor(code);
    if (!second) {
      return fail('Digite os 6 dígitos do app ou um código de recuperação (XXXX-XXXX).', 'code');
    }
    setSaving(true);
    setError(null);
    setBadField(null);
    try {
      if (disabling) {
        await api.mfaDisable({ password, code: second });
        toast.success('Verificação em duas etapas desativada. Você recebe um aviso por e-mail.');
        onDisabled();
        return;
      }
      const res = await api.mfaRecoveryCodes({ password, code: second });
      setCodes(res.recoveryCodes);
    } catch (er) {
      const kindOf = codeOf(er);
      const message = errorMessage(er, 'Não foi possível concluir. Tente de novo.');
      // Desativada por outra aba ou pelo atendimento: fecha, e o cartão relido mostra isso.
      if (kindOf === 'mfa_not_enabled') {
        toast.error(message);
        onClose();
        return;
      }
      fail(
        message,
        kindOf === 'wrong_password' ? 'password' : kindOf === 'invalid_mfa_code' ? 'code' : null,
      );
    } finally {
      setSaving(false);
    }
  }

  const describedBy = (field: 'password' | 'code'): string | undefined =>
    [field === 'code' ? hintId : null, error ? errorId : null].filter(Boolean).join(' ') ||
    undefined;

  return (
    <Modal
      title={disabling ? 'Desativar a verificação em duas etapas' : 'Gerar novos códigos'}
      onClose={onClose}
    >
      {codes ? (
        <RecoveryCodes codes={codes} onDone={onClose} />
      ) : (
        <form
          className="stack"
          onSubmit={(e) => void submit(e)}
          aria-label={disabling ? 'Desativar a verificação' : 'Gerar novos códigos de recuperação'}
        >
          <p className="muted tiny">
            {disabling
              ? 'Sem ela, só a senha protege sua conta. Confirme com a senha e um código.'
              : 'Os códigos que você tem hoje deixam de valer. Confirme com a senha e um código.'}
          </p>
          <Field label="Senha atual">
            <input
              ref={passwordRef}
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              aria-invalid={badField === 'password'}
              aria-describedby={describedBy('password')}
            />
          </Field>
          <Field label="Código do app ou de recuperação">
            <input
              ref={codeRef}
              value={code}
              onChange={(e) => setCode(e.target.value)}
              required
              autoComplete="one-time-code"
              autoCapitalize="characters"
              maxLength={11}
              spellCheck={false}
              aria-invalid={badField === 'code'}
              aria-describedby={describedBy('code')}
            />
          </Field>
          <span className="muted tiny" id={hintId}>
            Os 6 dígitos do app autenticador, ou um código de recuperação (XXXX-XXXX).
          </span>
          {error && (
            <p className="error" id={errorId} role="alert">
              {error}
            </p>
          )}
          <Button type="submit" variant={disabling ? 'danger' : 'primary'} disabled={saving}>
            {saving ? 'Confirmando…' : disabling ? 'Desativar' : 'Gerar códigos'}
          </Button>
        </form>
      )}
    </Modal>
  );
}
