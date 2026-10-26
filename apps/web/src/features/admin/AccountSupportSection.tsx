import type { AdminAccountLookup, UserRole, UserStatus } from '@escambo/types';
import { Search, ShieldOff, UserCog } from 'lucide-react';
import { useId, useRef, useState, type FormEvent } from 'react';
import { Button, ErrorState, Field, Modal, Skeleton } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { dt } from '../../lib/format';
import { useAdminAccountLookup, useAdminResetMfa } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { SectionHead } from './SectionHead';

const ROLE_LABEL: Record<UserRole, string> = {
  client: 'Cliente',
  freelancer: 'Freelancer',
  company: 'Empresa',
  admin: 'Administração',
};

const STATUS_LABEL: Record<UserStatus, string> = {
  active: 'Ativa',
  suspended: 'Suspensa',
  banned: 'Banida',
  pending_verification: 'Aguardando confirmação do e-mail',
};

/** O motivo fica no registro do atendimento (admin_actions): curto demais não explica nada. */
const REASON_MIN = 10;
const REASON_MAX = 500;

const isNotFound = (er: unknown): boolean => (er as { status?: unknown } | null)?.status === 404;

/**
 * Atendimento: conta (RF-090, ADR 66). O admin acha a conta pelo e-mail e, para quem perdeu o
 * celular e os códigos de recuperação, tira a verificação em duas etapas. A API derruba as sessões
 * da conta, avisa o titular por e-mail e registra quem fez e por quê.
 */
export function AccountSupportSection() {
  const [draft, setDraft] = useState('');
  const [email, setEmail] = useState<string | null>(null);
  const [resetting, setResetting] = useState<AdminAccountLookup | null>(null);
  const lookup = useAdminAccountLookup(email);
  const resultId = useId();

  function search(e: FormEvent): void {
    e.preventDefault();
    const target = draft.trim();
    if (target === email) void lookup.refetch();
    else setEmail(target);
  }

  const found = lookup.data && !lookup.error ? lookup.data : null;
  const result = !email
    ? ''
    : lookup.isFetching
      ? 'Buscando…'
      : found
        ? 'Conta encontrada.'
        : isNotFound(lookup.error)
          ? `Nenhuma conta com o e-mail ${email}.`
          : '';

  return (
    <section className="card" id="atendimento-conta" aria-labelledby="atendimento-conta-title">
      <SectionHead
        icon={UserCog}
        tone="blue"
        title="Atendimento: conta"
        titleId="atendimento-conta-title"
        subtitle="Ache a conta pelo e-mail. Desativar a verificação em duas etapas é para quem perdeu o celular e os códigos de recuperação: confirme antes que é o titular (pelo chamado de suporte, por exemplo) e registre o motivo."
      />
      <form className="lookup-form" onSubmit={search} aria-label="Buscar conta por e-mail">
        <Field label="E-mail da conta">
          <input
            type="email"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            required
            maxLength={255}
            autoComplete="off"
            aria-describedby={resultId}
          />
        </Field>
        <div>
          <Button type="submit" variant="secondary" disabled={lookup.isFetching}>
            <Search size={14} /> Buscar
          </Button>
        </div>
      </form>
      {/* Região viva sempre na página: o resultado da busca é lido quando chega. */}
      <p className="muted tiny" id={resultId} role="status" data-testid="lookup-result">
        {result}
      </p>
      {email && lookup.isLoading && <Skeleton lines={2} />}
      {email && lookup.error && !isNotFound(lookup.error) && (
        <ErrorState error={lookup.error} onRetry={() => void lookup.refetch()} />
      )}
      {found && (
        <div className="stack" data-testid="lookup-account">
          <dl className="lookup-list">
            <div>
              <dt className="muted tiny">E-mail</dt>
              <dd className="email-addr">{found.email}</dd>
            </div>
            <div>
              <dt className="muted tiny">Tipo de conta</dt>
              <dd>{ROLE_LABEL[found.role] ?? found.role}</dd>
            </div>
            <div>
              <dt className="muted tiny">Situação</dt>
              <dd>{STATUS_LABEL[found.status] ?? found.status}</dd>
            </div>
            <div>
              <dt className="muted tiny">Criada em</dt>
              <dd>{dt(found.createdAt)}</dd>
            </div>
            <div>
              <dt className="muted tiny">Verificação em duas etapas</dt>
              <dd data-testid="lookup-mfa">{found.mfaEnabled ? 'Ativa' : 'Desativada'}</dd>
            </div>
          </dl>
          {found.mfaEnabled && (
            <div>
              <Button type="button" variant="danger" onClick={() => setResetting(found)}>
                <ShieldOff size={14} /> Desativar verificação em duas etapas
              </Button>
            </div>
          )}
        </div>
      )}
      {resetting && <ResetMfaModal account={resetting} onClose={() => setResetting(null)} />}
    </section>
  );
}

/** Confirmação com o motivo obrigatório: o titular recebe o aviso e o registro guarda o porquê. */
function ResetMfaModal({ account, onClose }: { account: AdminAccountLookup; onClose: () => void }) {
  const toast = useToast();
  const reset = useAdminResetMfa();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState(false);
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  const hintId = useId();
  const errorId = useId();

  function fail(message: string, onField: boolean): void {
    setError(message);
    setInvalid(onField);
    if (onField) reasonRef.current?.focus();
  }

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    const text = reason.trim();
    if (text.length < REASON_MIN) {
      return fail(`Escreva o motivo com pelo menos ${REASON_MIN} caracteres.`, true);
    }
    setError(null);
    setInvalid(false);
    try {
      await reset.mutateAsync({ ulid: account.ulid, reason: text });
      toast.success(
        'Verificação em duas etapas desativada. As sessões da conta caíram e o titular foi avisado por e-mail.',
      );
      onClose();
    } catch (er) {
      fail(errorMessage(er, 'Não foi possível desativar. Tente de novo.'), false);
    }
  }

  return (
    <Modal title="Desativar a verificação em duas etapas" onClose={onClose}>
      <form
        className="stack"
        onSubmit={(e) => void submit(e)}
        aria-label="Desativar a 2FA da conta"
      >
        <p className="muted tiny">
          Conta <strong className="email-addr">{account.email}</strong>. A verificação sai na hora,
          as sessões abertas da conta caem e o titular recebe um e-mail avisando. Para voltar a
          usar, ele ativa de novo no Perfil.
        </p>
        <label>
          Motivo (fica no registro do atendimento)
          <textarea
            ref={reasonRef}
            className="textarea"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            required
            maxLength={REASON_MAX}
            rows={3}
            aria-invalid={invalid}
            aria-describedby={error ? `${hintId} ${errorId}` : hintId}
          />
        </label>
        <span className="muted tiny" id={hintId}>
          De {REASON_MIN} a {REASON_MAX} caracteres. Ex.: perdeu o celular; titularidade confirmada
          no chamado de suporte.
        </span>
        {error && (
          <p className="error" id={errorId} role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="danger" disabled={reset.isPending}>
          <ShieldOff size={16} /> {reset.isPending ? 'Desativando…' : 'Desativar'}
        </Button>
      </form>
    </Modal>
  );
}
