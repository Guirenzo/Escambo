import { CalendarClock, Check, Clock, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { ContractWithHistory } from '@escambo/types';
import { Button, Field, Input, Modal } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { deadlinePill, momentText } from '../../lib/deadline';
import { addDays, dateInputValue, deadlineInfo, dt, endOfDayIso } from '../../lib/format';
import { usePublicSettings, useRequestExtension, useResolveExtension } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

/** O que falta a quem entrega, na frase: "registre a entrega", "entregue os 2 marcos que faltam". */
function actionText(c: ContractWithHistory): string {
  const ask = c.deadline.extensionRequestsLeft > 0 ? ' ou peça a extensão' : '';
  if (!c.hasMilestones) return `registre a entrega${ask}`;
  const n = c.deadline.undeliveredMilestones;
  return `${n === 1 ? 'entregue o marco que falta' : `entregue os ${n} marcos que faltam`}${ask}`;
}

/** Marco entregue ainda em aberto (esperando o cliente, ou em revisão) trava o cancelamento. */
const openDelivered = (c: ContractWithHistory): boolean =>
  c.milestones.some((m) => m.status === 'delivered' || (m.status === 'funded' && !!m.deliveredAt));

const capitalize = (s: string): string => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * O que a Sala diz com o prazo vencido (ADR 57), para cada parte. Nunca "sem entrega" quando houve
 * marco entregue; a oferta do cancelamento só quando ele está aberto (marco entregue em aberto
 * trava); e, com o aviso projetado já no passado (job atrasado), "a qualquer momento".
 */
function lateText(
  c: ContractWithHistory,
  who: 'client' | 'freelancer',
  moment: (iso: string | null) => string,
  now: number,
): string {
  const d = c.deadline;
  const partial =
    c.hasMilestones && d.undeliveredMilestones > 0 && d.undeliveredMilestones < d.totalMilestones;
  const missing = partial ? 'as entregas que faltam' : 'entrega';
  const cancelOpen = !openDelivered(c);
  if (d.state === 'grace') {
    if (who === 'freelancer') {
      return `Prazo vencido. Até ${moment(d.mediationAt)}: ${actionText(c)}, senão a disputa abre sozinha e o valor fica congelado até a decisão da mediação.${
        cancelOpen ? ' O cliente já pode cancelar com reembolso integral.' : ''
      }`;
    }
    const lead = partial
      ? `Faltam ${d.undeliveredMilestones} de ${d.totalMilestones} marcos. Prazo vencido. `
      : 'Prazo vencido sem entrega. ';
    const rest = `sem ${missing} nem extensão aceita até ${moment(d.mediationAt)}, a disputa abre sozinha e a mediação do Escambo decide.`;
    return cancelOpen
      ? `${lead}Você pode cancelar com reembolso integral, ou esperar: ${rest}`
      : `${lead}${capitalize(rest)}`;
  }
  // due: o prazo venceu e o aviso ainda não saiu
  const lead = partial
    ? `O prazo venceu com ${d.undeliveredMilestones === 1 ? 'um marco' : `${d.undeliveredMilestones} marcos`} por entregar.`
    : 'O prazo venceu sem entrega.';
  const already = d.noticeAt !== null && Date.parse(d.noticeAt) <= now;
  if (who === 'freelancer') {
    const when = already ? 'a qualquer momento' : `a partir de ${moment(d.noticeAt)}`;
    const then = cancelOpen
      ? already
        ? ', e o cliente já pode cancelar com reembolso integral'
        : ', e daí em diante o cliente pode cancelar com reembolso integral'
      : '';
    return `${lead} O Escambo avisa vocês dois ${when}${then}. ${capitalize(actionText(c))}${already ? '' : ' antes disso'}.`;
  }
  const wait = `sem ${missing}, a disputa abre sozinha a partir de ${moment(d.mediationAt)}.`;
  if (already) {
    return cancelOpen
      ? `${lead} Você já pode cancelar com reembolso integral, ou esperar: ${wait}`
      : `${lead} ${capitalize(wait)}`;
  }
  return cancelOpen
    ? `${lead} O Escambo avisa o freelancer a partir de ${moment(d.noticeAt)}; daí em diante você pode cancelar com reembolso integral, ou esperar: ${wait}`
    : `${lead} O Escambo avisa o freelancer a partir de ${moment(d.noticeAt)}: ${wait}`;
}

/**
 * Prazo de entrega da contratação (RN-028 / RN-029, ADR 57). O estado vem da API
 * (`contract.deadline`), com as horas já gravadas ou projetadas: quando sai o aviso de atraso,
 * a partir de quando a disputa automática abre, até quando o cliente responde a um pedido. As
 * horas aparecem no fuso de quem lê. Com o trabalho entregue o prazo não cobra mais.
 */
export function DeadlineSection({
  contract,
  myId,
}: {
  contract: ContractWithHistory;
  myId: number;
}) {
  const { user } = useAuth();
  const toast = useToast();
  const resolve = useResolveExtension();
  const [asking, setAsking] = useState(false);
  if (!contract.deadlineAt) return null;

  const zone = user?.timezone;
  const d = contract.deadline;
  const pill = deadlinePill(contract);
  const isFreelancer = contract.freelancerId === myId;
  const isClient = contract.clientId === myId;
  const ext = contract.extension;
  const moment = (iso: string | null): string => (iso ? momentText(iso, zone) : '');
  const late = d.state === 'due' || d.state === 'grace';
  const counting = d.state === 'running' || late;
  const canAsk = isFreelancer && counting && d.extensionRequestsLeft > 0;
  const info = deadlineInfo(contract.deadlineAt);
  const now = Date.now();
  const deadlinePassed = new Date(contract.deadlineAt).getTime() <= now;

  async function decide(decision: 'accept' | 'decline'): Promise<void> {
    try {
      await resolve.mutateAsync({ id: contract.id, decision, seq: ext?.seq });
      toast.success(
        decision === 'accept'
          ? 'Prazo estendido. O freelancer foi avisado.'
          : 'Extensão recusada; vale o prazo atual.',
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
        {pill && (
          <span className={`pill deadline-${pill.tone}`} data-testid="deadline-state">
            {pill.label}
          </span>
        )}
      </div>

      <div className="deadline-main">
        <strong data-testid="deadline-date">{dt(contract.deadlineAt)}</strong>
        {contract.deadlineExtendedAt && (
          <span className="muted tiny">
            estendido em {dt(contract.deadlineExtendedAt)} · extensão usada
          </span>
        )}
      </div>

      {d.state === 'running' && info && info.daysLeft <= 3 && d.noticeAt && d.mediationAt && (
        <ul className="deadline-plan muted tiny" data-testid="deadline-plan">
          <li>Se não houver entrega: aviso às duas partes {moment(d.noticeAt)}</li>
          <li>Disputa automática: a partir de {moment(d.mediationAt)}</li>
        </ul>
      )}

      {late && (isFreelancer || isClient) && (
        <p className="notice danger" data-testid="deadline-late">
          {lateText(contract, isFreelancer ? 'freelancer' : 'client', moment, now)}
        </p>
      )}

      {d.state === 'paused' && ext && (
        <div className="ext-request" data-testid="extension-request">
          <div>
            <strong>Extensão pedida: novo prazo {dt(ext.deadlineAt)}</strong>
            <div className="muted tiny">{ext.reason}</div>
            {isClient && ext.respondBy && (
              <div className="tiny" data-testid="extension-respond-by">
                Responda até {moment(ext.respondBy)}. Sem resposta, o pedido expira e vale o prazo
                atual.{deadlinePassed ? ' Enquanto você decide, a disputa automática espera.' : ''}
              </div>
            )}
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
              {ext.respondBy ? ` até ${moment(ext.respondBy)}` : ''}
            </span>
          )}
        </div>
      )}

      {d.state === 'met' && (
        <p className="muted tiny" data-testid="deadline-met">
          {contract.hasMilestones
            ? 'Todos os marcos foram entregues: o prazo não abre mais disputa sozinho; cada marco segue a própria aprovação.'
            : `Houve entrega${d.firstDeliveredAt ? ` em ${moment(d.firstDeliveredAt)}` : ''}: o prazo não abre mais disputa sozinho.${
                isClient && contract.status === 'revision_requested'
                  ? ' Se a revisão não vier, abra uma disputa pela Sala.'
                  : ''
              }`}
        </p>
      )}

      {counting && ext?.status === 'declined' && (
        <p className="muted tiny" data-testid="extension-outcome">
          Pedido de extensão (novo prazo {dt(ext.deadlineAt)}) recusado; vale o prazo atual.
          {isFreelancer && d.extensionRequestsLeft === 1
            ? ' Você ainda pode fazer mais um pedido.'
            : ''}
        </p>
      )}
      {counting && ext?.status === 'expired' && (
        <p className="muted tiny" data-testid="extension-outcome">
          Pedido de extensão (novo prazo {dt(ext.deadlineAt)}) sem resposta até{' '}
          {moment(ext.respondBy ?? ext.resolvedAt)}: vale o prazo atual.
          {isFreelancer && d.extensionRequestsLeft === 1
            ? ' Você ainda pode fazer mais um pedido.'
            : ''}
        </p>
      )}

      {canAsk && (
        <div className="svc-actions">
          <Button type="button" variant="secondary" onClick={() => setAsking(true)}>
            Pedir extensão de prazo
          </Button>
          <span className="muted tiny" data-testid="extension-left">
            {d.extensionRequestsLeft >= 2
              ? 'até 2 pedidos; só um pode ser aceito'
              : 'resta 1 pedido'}
          </span>
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
  const { user } = useAuth();
  const toast = useToast();
  const ask = useRequestExtension();
  const settings = usePublicSettings();
  const hours = settings.data?.extensionResponseHours ?? 48;
  const left = contract.deadline.extensionRequestsLeft;
  const current = new Date(contract.deadlineAt!);
  const tomorrow = addDays(new Date(), 1);
  const floor = current.getTime() > tomorrow.getTime() ? addDays(current, 1) : tomorrow;
  const min = dateInputValue(floor);
  const [date, setDate] = useState(dateInputValue(addDays(floor, 6)));
  const [reason, setReason] = useState('');

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      const c = await ask.mutateAsync({
        id: contract.id,
        deadlineAt: endOfDayIso(date),
        reason: reason.trim(),
      });
      toast.success(
        c.extension?.respondBy
          ? `Pedido enviado. O cliente tem até ${momentText(c.extension.respondBy, user?.timezone)} para responder.`
          : 'Pedido enviado. O cliente decide pela Sala.',
      );
      onClose();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível pedir a extensão');
    }
  }

  return (
    <Modal title="Pedir extensão de prazo" onClose={onClose}>
      <form className="stack" onSubmit={submit}>
        <p className="muted tiny" data-testid="extension-rules">
          Prazo atual: {dt(contract.deadlineAt!)}. Você pode pedir até 2 vezes nesta contratação
          (resta {left}), e só uma extensão pode ser aceita. O cliente tem até {hours} h para
          responder; sem resposta, o pedido expira. Enquanto ele decide, a disputa automática
          espera.
        </p>
        <Field label="Novo prazo (vale até 23:59 do dia)">
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
