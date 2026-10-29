import type { CpfStatus } from '@escambo/types';
import { BadgeCheck, IdCard } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { BusinessForm } from '../../components/BusinessActions';
import { Button, Field, QueryState } from '../../components/ui';
import { formatCpfTyping, isValidCpf } from '../../lib/documents';
import { errorMessage } from '../../lib/errors';
import { dt } from '../../lib/format';
import { useCpfStatus, useVerifyCpf } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

export const CPF_INVALID = 'CPF inválido: confira os 11 dígitos.';

/** "1990-05-17" → "17/05/1990", sem passar pelo fuso (é uma data, não um instante). */
const dayLabel = (day: string): string => day.split('-').reverse().join('/');

/** Hoje no relógio do aparelho, como o campo de data quer (o limite de verdade é o da API). */
const todayInput = (): string => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * Dados para receber (RF-020, RN-009, RN-075): o CPF e a data de nascimento do freelancer. A API
 * confere os dígitos verificadores, se o CPF já não está em outra conta e se a pessoa tem 18 anos;
 * não é consulta à Receita, e o texto diz isso. Validado, o CPF aparece só mascarado e não se
 * altera aqui: a correção é pelo suporte. A Carteira manda para cá quando o saque pede o CPF.
 */
export function CpfCard() {
  const status = useCpfStatus();
  return (
    <section
      className="card"
      id="dados-recebimento"
      aria-labelledby="dados-recebimento-title"
      data-testid="cpf-card"
      tabIndex={-1}
      data-hash-target
    >
      <div className="card-head">
        <h3 id="dados-recebimento-title">
          <IdCard size={16} /> Dados para receber
        </h3>
      </div>
      <QueryState
        isLoading={status.isLoading}
        error={status.error}
        data={status.data}
        onRetry={() => void status.refetch()}
      >
        {(s) => <CpfContent status={s} />}
      </QueryState>
    </section>
  );
}

function CpfContent({ status }: { status: CpfStatus }) {
  if (status.verified) {
    return (
      <div className="stack" data-testid="cpf-validado">
        <p className="cpf-ok">
          <BadgeCheck size={18} aria-hidden="true" />
          <span>
            CPF validado: <strong>{status.maskedCpf}</strong>
          </span>
        </p>
        <dl className="lookup-list">
          {status.birthDate && (
            <div>
              <dt className="muted tiny">Nascimento</dt>
              <dd>{dayLabel(status.birthDate)}</dd>
            </div>
          )}
          {status.verifiedAt && (
            <div>
              <dt className="muted tiny">Validado em</dt>
              <dd>{dt(status.verifiedAt)}</dd>
            </div>
          )}
        </dl>
        <p className="muted tiny">
          O CPF não se altera por aqui. Se ele estiver errado,{' '}
          <Link to="/suporte">fale com o suporte</Link>.
        </p>
      </div>
    );
  }
  if (!status.available) {
    return (
      <p className="muted" data-testid="cpf-indisponivel">
        A validação de CPF ainda não está disponível: o servidor ainda não tem a chave de cifragem
        que protege o documento.
        {status.required &&
          ' Enquanto isso, o saque do que você recebe por trabalhos fica bloqueado.'}{' '}
        Se precisar sacar, <Link to="/suporte">fale com o suporte</Link>.
      </p>
    );
  }
  if (!status.hasFreelancerProfile) {
    return (
      <p className="muted" data-testid="cpf-sem-perfil">
        O CPF fica no perfil de freelancer: salve primeiro os seus dados de freelancer, nesta mesma
        página, e volte aqui.
      </p>
    );
  }
  return <CpfForm required={status.required} />;
}

function CpfForm({ required }: { required: boolean }) {
  const verify = useVerifyCpf();
  const toast = useToast();
  const [cpf, setCpf] = useState('');
  const [birthDate, setBirthDate] = useState('');
  const [error, setError] = useState<string | null>(null);
  const cpfRef = useRef<HTMLInputElement>(null);

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    setError(null);
    if (!isValidCpf(cpf)) {
      setError(CPF_INVALID);
      cpfRef.current?.focus();
      return;
    }
    try {
      await verify.mutateAsync({ cpf, birthDate });
      toast.success('CPF validado.');
    } catch (er) {
      setError(errorMessage(er, 'Não foi possível validar o CPF. Tente de novo.'));
      cpfRef.current?.focus();
    }
  }

  return (
    <BusinessForm className="stack" onSubmit={(e) => void submit(e)} aria-label="Validar CPF">
      <p className="muted tiny" id="cpf-dica">
        {required ? 'O saque do que você recebe por trabalhos pede o CPF validado. ' : ''}
        Conferimos os dígitos do CPF, se ele já não está em outra conta e se você tem 18 anos ou
        mais. Não é uma consulta à Receita Federal. O CPF é guardado cifrado, aparece só mascarado
        e, depois de validado, só o suporte corrige.
      </p>
      <Field label="CPF">
        <input
          ref={cpfRef}
          value={cpf}
          onChange={(e) => {
            setCpf(formatCpfTyping(e.target.value));
            setError(null);
          }}
          inputMode="numeric"
          autoComplete="off"
          required
          maxLength={14}
          placeholder="000.000.000-00"
          aria-invalid={error !== null}
          aria-describedby={error ? 'cpf-erro cpf-dica' : 'cpf-dica'}
        />
      </Field>
      <Field label="Data de nascimento">
        <input
          type="date"
          value={birthDate}
          onChange={(e) => setBirthDate(e.target.value)}
          required
          min="1900-01-01"
          max={todayInput()}
          autoComplete="bday"
        />
      </Field>
      {error && (
        <p className="error" id="cpf-erro" role="alert">
          {error}
        </p>
      )}
      <div className="svc-actions">
        <Button type="submit" disabled={verify.isPending}>
          {verify.isPending ? 'Validando…' : 'Validar CPF'}
        </Button>
      </div>
    </BusinessForm>
  );
}
