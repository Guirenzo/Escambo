import { ArrowRight, Clock } from 'lucide-react';
import { useNavigate } from 'react-router-dom';
import type { Contract } from '@escambo/types';
import { CompanyTag } from '../../components/CompanyTag';
import { Pill } from '../../components/ui';
import { useAuth } from '../../lib/auth';
import { dayIn, deadlinePill } from '../../lib/deadline';
import { statusLabel, brl } from '../../lib/format';
import { DEFAULT_TIMEZONE } from '../../lib/timezones';
import { ContractActions } from '../contracts/ContractActions';

const MODE_LABEL: Record<string, string> = {
  cash: 'Dinheiro',
  credits: 'Créditos',
  barter: 'Troca',
};

const MONTH_SHORT = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
];
const MONTH_LONG = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
];

/** Etapa de 1 a 4 (proposta, aceita, entregue, concluída); fora do caminho (cancelada…), null. */
const STAGE: Partial<Record<string, number>> = {
  pending: 1,
  accepted: 2,
  in_progress: 2,
  revision_requested: 2,
  delivered: 3,
  completed: 4,
};

/** A etapa em 4 traços que ocupam a largura do cartão, com o texto "Etapa 2 de 4" ao lado. */
function Stage({ status }: { status: string }) {
  const at = STAGE[status];
  if (!at) return null;
  return (
    <div className="deal-progress">
      <span className="stage" aria-hidden="true">
        {[1, 2, 3, 4].map((n) => (
          <span key={n} className={n <= at ? 'stage-dot on' : 'stage-dot'} />
        ))}
      </span>
      <span className="deal-progress-label">Etapa {at} de 4</span>
    </div>
  );
}

/**
 * O bloco de data do cartão: o dia do prazo (no fuso em que o prazo vale, ADR 58) ou, sem prazo,
 * o dia em que a contratação foi criada. O mês curto e o dia grande são só visuais: o leitor de
 * tela ouve a data por extenso.
 */
export function DateBlock({ contract: c }: { contract: Contract }) {
  const day = c.deadlineAt
    ? dayIn(c.deadlineZone ?? DEFAULT_TIMEZONE, c.deadlineAt)
    : dayIn(DEFAULT_TIMEZONE, c.createdAt);
  const [, m, d] = day.split('-').map(Number) as [number, number, number];
  const what = c.deadlineAt ? 'Prazo' : 'Criada';
  return (
    <div className={`deal-date${c.deadlineAt ? ' is-deadline' : ''}`}>
      <span className="deal-date-what">{what}</span>
      <span className="deal-date-month" aria-hidden="true">
        {MONTH_SHORT[m - 1]}
      </span>
      <span className="deal-date-day" aria-hidden="true">
        {String(d).padStart(2, '0')}
      </span>
      <span className="sr-only">
        {d} de {MONTH_LONG[m - 1]}
      </span>
    </div>
  );
}

/**
 * Contratações do Início em cartões (como uma agenda): o título com o status, o bloco de data
 * (prazo, ou a criação quando não há prazo), valor, modalidade e etapa em colunas, quanto falta do
 * prazo quando ele cobra, o botão largo para a Sala (linha do tempo + chat) e só as ações que
 * avançam o contrato (aceitar, entregar, aprovar, avaliar). Recusar, cancelar, pedir revisão e abrir
 * disputa ficam na Sala, onde há linha do tempo, chat e o pedido de justificativa. É uma lista de
 * artigos com nome (o título), que o leitor de tela percorre como itens.
 */
export function ContractsCard({ contracts }: { contracts: Contract[] }) {
  const navigate = useNavigate();
  const { user } = useAuth();

  return (
    <ul className="deals" aria-label="Contratações">
      {contracts.map((c) => {
        // Só enquanto o prazo cobra (ADR 57): correndo, vencido ou com pedido.
        const pill = deadlinePill(c);
        return (
          <li key={c.id}>
            <article className="deal" aria-labelledby={`deal-${c.id}`}>
              <div className="deal-head">
                <h3 id={`deal-${c.id}`} className="deal-title">
                  {c.title}
                </h3>
                <Pill status={c.status}>{statusLabel(c)}</Pill>
              </div>
              {/* RF-018: na proposta de uma empresa, quem entrega vê o nome fantasia e o selo. */}
              {c.clientCompany && c.clientId !== user?.id && (
                <p className="deal-company">
                  <CompanyTag company={c.clientCompany} label="Contratante:" />
                </p>
              )}
              <div className="deal-body">
                <DateBlock contract={c} />
                <dl className="deal-meta">
                  <div>
                    <dt>Valor</dt>
                    <dd className="deal-value">
                      {c.paymentMode === 'credits' ? `${Math.round(c.price)} cr` : brl(c.price)}
                    </dd>
                  </div>
                  <div>
                    <dt>Pagamento</dt>
                    <dd>{MODE_LABEL[c.paymentMode] ?? c.paymentMode}</dd>
                  </div>
                </dl>
              </div>
              <Stage status={c.status} />
              {pill && pill.tone !== 'met' && (
                <p className={`deal-deadline deadline-text-${pill.tone}`}>
                  <Clock size={14} aria-hidden="true" /> {pill.label}
                </p>
              )}
              <div className="deal-actions">
                <button
                  type="button"
                  className="deal-open"
                  onClick={() => navigate(`/contratos/${c.id}`)}
                >
                  Abrir sala <ArrowRight size={16} aria-hidden="true" />
                </button>
                <ContractActions
                  contract={c}
                  exclude={['reject', 'cancel', 'revision', 'grant_revision', 'dispute']}
                />
              </div>
            </article>
          </li>
        );
      })}
    </ul>
  );
}
