import { CalendarClock, Check, Clock, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { ContractWithHistory } from '@escambo/types';
import { Button, Field, Input, Modal } from '../../components/ui';
import { addDays, dateInputValue, deadlineInfo, dt, endOfDayIso } from '../../lib/format';
import { useRequestExtension, useResolveExtension } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

/** Status em que o prazo está correndo (a mesma lista da API). */
const ACTIVE = ['accepted', 'in_progress', 'revision_requested'];
/** Carência da plataforma antes da disputa automática (platform_settings.deadline_grace_hours). */
const GRACE_HOURS = 24;

/**
 * Prazo de entrega da contratação (RN-028 / RN-029): quanto falta ou há quanto tempo estourou,
 * o pedido de extensão do freelancer (uma vez, com aceite do cliente) e o aviso de que, sem
 * entrega nem extensão, a mediação é aberta automaticamente.
 */
export function DeadlineSection({
  contract,
  myId,
}: {
  contract: ContractWithHistory;
  myId: number;
}) {
  const toast = useToast();
  const resolve = useResolveExtension();
  const [asking, setAsking] = useState(false);
  if (!contract.deadlineAt) return null;

  const active = ACTIVE.includes(contract.status);
  const info = deadlineInfo(contract.deadlineAt);
  const isFreelancer = contract.freelancerId === myId;
  const isClient = contract.clientId === myId;
  const ext = contract.extension;
  const pending = ext?.status === 'pending';
  const canAsk = isFreelancer && active && !pending && !contract.deadlineExtendedAt;
  const late = active && info?.tone === 'late';

  async function decide(decision: 'accept' | 'decline'): Promise<void> {
    try {
      await resolve.mutateAsync({ id: contract.id, decision });
      toast.success(
        decision === 'accept'
          ? 'Prazo estendido. O freelancer foi avisado.'
          : 'Extensão recusada; o prazo original continua valendo.',
      );
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível responder');
    }
  }

  return (
    <section
      className={`card deadline ${late ? 'late' : ''}`}
      data-testid="deadline"
      aria-labelledby="deadline-title"
    >
      <div className="card-head">
        <h3 id="deadline-title">
          <CalendarClock size={16} /> Prazo de entrega
        </h3>
        {active && info && (
          <span className={`pill deadline-${info.tone}`} data-testid="deadline-state">
            {info.label}
          </span>
        )}
      </div>

      <div className="deadline-main">
        <strong data-testid="deadline-date">{dt(contract.deadlineAt)}</strong>
        {contract.deadlineExtendedAt && (
          <span className="muted tiny">
            estendido em {dt(contract.deadlineExtendedAt)} · única extensão usada
          </span>
        )}
      </div>

      {late && (
        <p className="notice danger">
          Prazo estourado.{' '}
          {isFreelancer
            ? `Registre a entrega${contract.deadlineExtendedAt ? '' : ' ou peça extensão'}`
            : `Sem entrega${contract.deadlineExtendedAt ? '' : ' nem pedido de extensão'}`}{' '}
          em até {GRACE_HOURS}h após o aviso, a mediação do Escambo é aberta automaticamente e o
          escrow fica congelado até a decisão (RN-029).
        </p>
      )}

      {pending && ext && (
        <div className="ext-request" data-testid="extension-request">
          <div>
            <strong>Extensão pedida: até {dt(ext.deadlineAt)}</strong>
            <div className="muted tiny">{ext.reason}</div>
          </div>
          {isClient ? (
            <div className="svc-actions">
              <Button
                type="button"
                onClick={() => void decide('accept')}
                disabled={resolve.isPending}
              >
                <Check size={14} /> Aceitar novo prazo
              </Button>
              <Button
                type="button"
                variant="secondary"
                onClick={() => void decide('decline')}
                disabled={resolve.isPending}
              >
                <X size={14} /> Recusar
              </Button>
            </div>
          ) : (
            <span className="muted tiny">
              <Clock size={12} /> aguardando o cliente
            </span>
          )}
        </div>
      )}

      {ext?.status === 'declined' && active && (
        <p className="muted tiny">
          Pedido de extensão (até {dt(ext.deadlineAt)}) recusado pelo cliente; o prazo original
          continua.
        </p>
      )}

      {canAsk && (
        <div className="svc-actions">
          <Button type="button" variant="secondary" onClick={() => setAsking(true)}>
            Pedir extensão de prazo
          </Button>
          <span className="muted tiny">uma vez por contratação, com aceite do cliente</span>
        </div>
      )}

      {asking && <ExtensionModal contract={contract} onClose={() => setAsking(false)} />}
    </section>
  );
}

/** Freelancer propõe o novo prazo e explica o motivo (o cliente lê antes de decidir). */
function ExtensionModal({
  contract,
  onClose,
}: {
  contract: ContractWithHistory;
  onClose: () => void;
}) {
  const toast = useToast();
  const ask = useRequestExtension();
  const current = new Date(contract.deadlineAt!);
  const min = dateInputValue(addDays(current, 1));
  const [date, setDate] = useState(dateInputValue(addDays(current, 7)));
  const [reason, setReason] = useState('');

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      await ask.mutateAsync({
        id: contract.id,
        deadlineAt: endOfDayIso(date),
        reason: reason.trim(),
      });
      toast.success('Pedido enviado. O cliente decide pela Sala.');
      onClose();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível pedir a extensão');
    }
  }

  return (
    <Modal title="Pedir extensão de prazo" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted tiny">
          Prazo atual: {dt(contract.deadlineAt!)}. Você pode pedir uma única extensão por
          contratação (RN-028); ela só vale se o cliente aceitar.
        </p>
        <Field label="Novo prazo">
          <Input
            type="date"
            min={min}
            value={date}
            onChange={(e) => setDate(e.target.value)}
            required
          />
        </Field>
        <Field label="Motivo (o cliente lê)">
          <textarea
            className="textarea"
            rows={3}
            minLength={5}
            maxLength={500}
            required
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Ex.: o material do cliente chegou 3 dias depois do combinado"
          />
        </Field>
        <Button type="submit" disabled={ask.isPending || reason.trim().length < 5}>
          {ask.isPending ? 'Enviando…' : 'Enviar pedido'}
        </Button>
      </form>
    </Modal>
  );
}
