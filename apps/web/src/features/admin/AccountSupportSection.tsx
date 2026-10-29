import type { AdminAccountLookup, UserRole, UserStatus } from '@escambo/types';
import { IdCard, Search, ShieldOff, UserCog } from 'lucide-react';
import { useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Button, ErrorState, Field, Modal, Skeleton } from '../../components/ui';
import { errorMessage } from '../../lib/errors';
import { formatCnpj } from '../../lib/documents';
import { dt } from '../../lib/format';
import { useAdminAccountLookup, useAdminResetCpf, useAdminResetMfa } from '../../lib/hooks';
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
 * da conta, avisa o titular por e-mail e registra quem fez e por quê. Também apaga o CPF validado
 * para o titular corrigir (RF-020): a tela não altera um CPF validado, e o atendimento só o vê
 * mascarado. Na conta de empresa (RF-018), mostra o nome fantasia e o CNPJ.
 */
export function AccountSupportSection() {
  const [draft, setDraft] = useState('');
  const [email, setEmail] = useState<string | null>(null);
  const [resetting, setResetting] = useState<AdminAccountLookup | null>(null);
  const [resettingCpf, setResettingCpf] = useState<AdminAccountLookup | null>(null);
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
        subtitle="Ache a conta pelo e-mail. Desativar a verificação em duas etapas é para quem perdeu o celular e os códigos de recuperação; apagar o CPF, para quem o informou errado. Nos dois casos, confirme antes que é o titular (pelo chamado de suporte, por exemplo) e registre o motivo."
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
            {found.cpf && (
              <div>
                <dt className="muted tiny">CPF</dt>
                <dd data-testid="lookup-cpf">
                  {found.cpf.maskedCpf
                    ? `${found.cpf.maskedCpf} · ${found.cpf.verified ? 'validado' : 'não validado'}${
                        found.cpf.verifiedAt ? ` em ${dt(found.cpf.verifiedAt)}` : ''
                      }`
                    : 'Não informado'}
                </dd>
              </div>
            )}
            {found.company && (
              <div>
                <dt className="muted tiny">Empresa</dt>
                <dd data-testid="lookup-company">
                  {found.company.tradeName} · CNPJ {formatCnpj(found.company.cnpj)}
                </dd>
              </div>
            )}
          </dl>
          {(found.mfaEnabled || found.cpf?.maskedCpf) && (
            <div className="svc-actions">
              {found.mfaEnabled && (
                <Button type="button" variant="danger" onClick={() => setResetting(found)}>
                  <ShieldOff size={14} /> Desativar verificação em duas etapas
                </Button>
              )}
              {found.cpf?.maskedCpf && (
                <Button type="button" variant="danger" onClick={() => setResettingCpf(found)}>
                  <IdCard size={14} /> Apagar o CPF para correção
                </Button>
              )}
            </div>
          )}
        </div>
      )}
      {resetting && <ResetMfaModal account={resetting} onClose={() => setResetting(null)} />}
      {resettingCpf && (
        <ResetCpfModal account={resettingCpf} onClose={() => setResettingCpf(null)} />
      )}
    </section>
  );
}

/** Desativa a 2FA de quem perdeu o celular e os códigos de recuperação (ADR 66). */
function ResetMfaModal({ account, onClose }: { account: AdminAccountLookup; onClose: () => void }) {
  const reset = useAdminResetMfa();
  return (
    <ReasonModal
      account={account}
      onClose={onClose}
      run={(reason) => reset.mutateAsync({ ulid: account.ulid, reason })}
      pending={reset.isPending}
      title="Desativar a verificação em duas etapas"
      formLabel="Desativar a 2FA da conta"
      intro="A verificação sai na hora, as sessões abertas da conta caem e o titular recebe um e-mail avisando. Para voltar a usar, ele ativa de novo no Perfil."
      example="Ex.: perdeu o celular; titularidade confirmada no chamado de suporte."
      icon={<ShieldOff size={16} />}
      submit={['Desativar', 'Desativando…']}
      success="Verificação em duas etapas desativada. As sessões da conta caíram e o titular foi avisado por e-mail."
      failure="Não foi possível desativar. Tente de novo."
    />
  );
}

/** Apaga o CPF validado para o titular informar o certo no Perfil (RF-020). */
function ResetCpfModal({ account, onClose }: { account: AdminAccountLookup; onClose: () => void }) {
  const reset = useAdminResetCpf();
  return (
    <ReasonModal
      account={account}
      onClose={onClose}
      run={(reason) => reset.mutateAsync({ ulid: account.ulid, reason })}
      pending={reset.isPending}
      title="Apagar o CPF para correção"
      formLabel="Apagar o CPF da conta"
      intro="O CPF, a data de nascimento e a validação saem na hora, e o titular recebe um e-mail para informar o CPF certo no Perfil. Até lá, o saque do que ele recebe por trabalhos fica bloqueado. Confira o documento antes, fora do sistema."
      example="Ex.: titular digitou o CPF errado; documento conferido no chamado de suporte."
      icon={<IdCard size={16} />}
      submit={['Apagar o CPF', 'Apagando…']}
      success="CPF apagado. O titular foi avisado por e-mail para informar de novo."
      failure="Não foi possível apagar o CPF. Tente de novo."
    />
  );
}

/** Confirmação com o motivo obrigatório: o titular recebe o aviso e o registro guarda o porquê. */
function ReasonModal({
  account,
  onClose,
  run,
  pending,
  title,
  formLabel,
  intro,
  example,
  icon,
  submit: [submitLabel, pendingLabel],
  success,
  failure,
}: {
  account: AdminAccountLookup;
  onClose: () => void;
  run: (reason: string) => Promise<unknown>;
  pending: boolean;
  title: string;
  formLabel: string;
  intro: string;
  example: string;
  icon: ReactNode;
  submit: [string, string];
  success: string;
  failure: string;
}) {
  const toast = useToast();
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
      await run(text);
      toast.success(success);
      onClose();
    } catch (er) {
      fail(errorMessage(er, failure), false);
    }
  }

  return (
    <Modal title={title} onClose={onClose}>
      <form className="stack" onSubmit={(e) => void submit(e)} aria-label={formLabel}>
        <p className="muted tiny">
          Conta <strong className="email-addr">{account.email}</strong>. {intro}
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
          De {REASON_MIN} a {REASON_MAX} caracteres. {example}
        </span>
        {error && (
          <p className="error" id={errorId} role="alert">
            {error}
          </p>
        )}
        <Button type="submit" variant="danger" disabled={pending}>
          {icon} {pending ? pendingLabel : submitLabel}
        </Button>
      </form>
    </Modal>
  );
}
