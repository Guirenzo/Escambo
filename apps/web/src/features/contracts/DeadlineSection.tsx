import { CalendarClock, Check, Clock, X } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { ContractWithHistory } from '@escambo/types';
import { Button, Field, Input, Modal } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import {
  addDaysToDay,
  dayIn,
  deadlineInfo,
  deadlinePill,
  deadlineText,
  deadlineZoneNote,
  endOfDayIn,
  momentText,
  sameClock,
  todayIn,
} from '../../lib/deadline';
import { DEFAULT_TIMEZONE, timezoneLabel } from '../../lib/timezones';
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

/** Revisão parada há esse tempo: o Escambo avisa as duas partes uma vez (ADR 58, RN-081). */
const REVISION_STALL_DAYS = 7;

/**
 * Desde quando a revisão está pedida (ADR 58), para cada parte. Não há hora-limite: nada muda
 * sozinho, e qualquer parte pode abrir uma disputa. Sem a hora do pedido (contratação antiga antes
 * do reparo), nada.
 */
function revisionText(
  requestedAt: string,
  who: 'client' | 'freelancer',
  moment: (iso: string | null) => string,
  now: number,
): string {
  const days = Math.floor((now - Date.parse(requestedAt)) / 86_400_000);
  const since = moment(requestedAt);
  if (who === 'client') {
    return days >= REVISION_STALL_DAYS
      ? `Revisão pedida em ${since}, há ${days} dias, sem nova entrega. Nada muda sozinho: combine pelo chat ou abra uma disputa pela Sala.`
      : `Revisão pedida em ${since}. Não há hora-limite: nada muda sozinho. Se a nova entrega não vier, combine pelo chat ou abra uma disputa pela Sala; se ela não vier em ${REVISION_STALL_DAYS} dias, o Escambo lembra vocês dois, uma vez.`;
  }
  return days >= REVISION_STALL_DAYS
    ? `Revisão pedida em ${since}, há ${days} dias: registre a nova entrega. O cliente pode abrir uma disputa a qualquer momento.`
    : `Revisão pedida em ${since}: registre a nova entrega. Não há hora-limite, mas o cliente pode abrir uma disputa a qualquer momento.`;
}

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
 * Revisão em aberto numa contratação SEM prazo (troca, ou criada sem data): a seção do prazo não
 * aparece, mas as duas partes veem desde quando a revisão está pedida (ADR 58, RN-081). Com prazo,
 * a mesma linha fica dentro da seção do prazo.
 */
export function RevisionSince({ contract, myId }: { contract: ContractWithHistory; myId: number }) {
  const { user } = useAuth();
  const who =
    contract.freelancerId === myId ? 'freelancer' : contract.clientId === myId ? 'client' : null;
  if (
    contract.deadlineAt ||
    contract.status !== 'revision_requested' ||
    !contract.revisionRequestedAt ||
    !who
  ) {
    return null;
  }
  return (
    <section className="card" data-testid="revision" aria-labelledby="revision-title">
      <div className="card-head">
        <h3 id="revision-title">
          <Clock size={16} /> Revisão pedida
        </h3>
      </div>
      <p className="tiny" data-testid="revision-since">
        {revisionText(
          contract.revisionRequestedAt,
          who,
          (iso) => (iso ? momentText(iso, user?.timezone) : ''),
          Date.now(),
        )}
      </p>
    </section>
  );
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
  // O prazo é um dia no fuso de quem entrega (ADR 58); a API antiga (deploy) não manda: Brasília.
  const dz = contract.deadlineZone ?? DEFAULT_TIMEZONE;
  const d = contract.deadline;
  const pill = deadlinePill(contract);
  const isFreelancer = contract.freelancerId === myId;
  const isClient = contract.clientId === myId;
  const ext = contract.extension;
  // A data pedida vale até 23:59 no fuso dela (a API antiga não manda: o do prazo).
  const ez = ext?.deadlineZone ?? dz;
  const moment = (iso: string | null): string => (iso ? momentText(iso, zone) : '');
  const late = d.state === 'due' || d.state === 'grace';
  const counting = d.state === 'running' || late;
  const canAsk = isFreelancer && counting && d.extensionRequestsLeft > 0;
  const info = deadlineInfo(contract.deadlineAt, dz);
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
        <strong data-testid="deadline-date">{deadlineText(contract.deadlineAt, dz)}</strong>
        {deadlineZoneNote(contract.deadlineAt, dz, zone) && (
          <span className="muted tiny" data-testid="deadline-zone">
            {deadlineZoneNote(contract.deadlineAt, dz, zone).trim()}
          </span>
        )}
        {contract.deadlineExtendedAt && (
          <span className="muted tiny">
            estendido em {moment(contract.deadlineExtendedAt)} · extensão usada
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
            <strong>
              Extensão pedida: novo prazo {deadlineText(ext.deadlineAt, ez)}
              {deadlineZoneNote(ext.deadlineAt, ez, zone)}
            </strong>
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
            : `Houve entrega${d.firstDeliveredAt ? ` em ${moment(d.firstDeliveredAt)}` : ''}: o prazo não abre mais disputa sozinho.`}
        </p>
      )}

      {contract.status === 'revision_requested' &&
        contract.revisionRequestedAt &&
        (isFreelancer || isClient) && (
          <p className="tiny" data-testid="revision-since">
            {revisionText(
              contract.revisionRequestedAt,
              isFreelancer ? 'freelancer' : 'client',
              moment,
              now,
            )}
          </p>
        )}

      {counting && ext?.status === 'declined' && (
        <p className="muted tiny" data-testid="extension-outcome">
          Pedido de extensão (novo prazo {deadlineText(ext.deadlineAt, ez)}
          {deadlineZoneNote(ext.deadlineAt, ez, zone)}) recusado; vale o prazo atual.
          {isFreelancer && d.extensionRequestsLeft === 1
            ? ' Você ainda pode fazer mais um pedido.'
            : ''}
        </p>
      )}
      {counting && ext?.status === 'expired' && (
        <p className="muted tiny" data-testid="extension-outcome">
          Pedido de extensão (novo prazo {deadlineText(ext.deadlineAt, ez)}
          {deadlineZoneNote(ext.deadlineAt, ez, zone)}) sem resposta até{' '}
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
  const dz = contract.deadlineZone ?? DEFAULT_TIMEZONE;
  const viewer = user?.timezone ?? DEFAULT_TIMEZONE;
  const afterCurrent = addDaysToDay(dayIn(dz, contract.deadlineAt!), 1);
  const tomorrow = addDaysToDay(todayIn(dz), 1);
  const min = afterCurrent > tomorrow ? afterCurrent : tomorrow;
  const otherClock = !sameClock(dz, viewer);
  const [date, setDate] = useState(addDaysToDay(min, 6));
  const [reason, setReason] = useState('');

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault();
    try {
      const c = await ask.mutateAsync({
        id: contract.id,
        deadlineAt: endOfDayIn(dz, date),
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
          Prazo atual: {deadlineText(contract.deadlineAt!, dz)}
          {deadlineZoneNote(contract.deadlineAt!, dz, viewer)}. Você pode pedir até 2 vezes nesta
          contratação (resta {left}), e só uma extensão pode ser aceita. O cliente tem até {hours} h
          para responder; sem resposta, o pedido expira. Enquanto ele decide, a disputa automática
          espera.
        </p>
        <Field
          label={`Novo prazo (vale até 23:59 do dia${otherClock ? `, no horário de ${timezoneLabel(dz)}` : ''})`}
        >
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
