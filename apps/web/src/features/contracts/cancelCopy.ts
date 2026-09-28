import type { CancelTerms } from '@escambo/types';
import { momentText } from '../../lib/deadline';
import { brl } from '../../lib/format';

/** R$ ou créditos, conforme a unidade do cancelamento. */
export const amount = (t: CancelTerms, v: number): string =>
  t.unit === 'credits' ? `${Math.round(v)} créditos` : brl(v);

export interface CancelCopy {
  title: string;
  body: string;
  confirm: string | null;
}

/** O texto de cada etapa (ADR 57): o que acontece com o dinheiro, dito antes de confirmar. */
export function cancelCopy(t: CancelTerms, zone: string | null | undefined): CancelCopy {
  const freelancer = t.by === 'freelancer';
  if (!t.allowed || !t.stage) {
    return {
      title: freelancer ? 'Desistir da contratação' : 'Cancelar contratação',
      body: t.message ?? 'Não é possível cancelar agora.',
      confirm: null,
    };
  }
  switch (t.stage) {
    case 'proposal':
      return {
        title: 'Cancelar proposta',
        body:
          t.unit === 'credits'
            ? 'Nenhum crédito foi retido ainda.'
            : `O valor reservado (${brl(t.refundClient)}) volta inteiro para a sua carteira.`,
        confirm: 'Cancelar proposta',
      };
    case 'overdue':
      return {
        title: 'Cancelar contratação',
        body: `O prazo venceu com trabalho nunca entregue: cancelando agora, ${amount(t, t.refundClient)} volta para a sua carteira (tudo o que ainda está em garantia).`,
        confirm: 'Cancelar e receber de volta',
      };
    case 'early':
    case 'no_deadline':
      return {
        title: 'Cancelar contratação',
        body: `${
          t.stage === 'early'
            ? 'Menos da metade do tempo entre o aceite e o prazo passou'
            : 'Esta contratação não tem prazo'
        }: você recebe de volta ${brl(t.refundClient)} (50%) e o freelancer fica com ${brl(t.releaseFreelancer)}.`,
        confirm: 'Cancelar contratação',
      };
    case 'late':
      return {
        title: 'Cancelar contratação',
        body: `Mais da metade do tempo entre o aceite e o prazo já passou: você não recebe nada de volta e o freelancer fica com ${brl(t.releaseFreelancer)}.${
          t.noticeAt
            ? ` Se a entrega não vier, espere o prazo: vencido sem entrega, a partir do aviso do Escambo (${momentText(t.noticeAt, zone)}), cancelar devolve tudo.`
            : ''
        }`,
        confirm: 'Cancelar mesmo assim',
      };
    case 'credits':
      return {
        title: 'Cancelar contratação',
        body: `Os ${Math.round(t.refundClient)} créditos em garantia voltam para você.`,
        confirm: 'Cancelar contratação',
      };
    case 'barter':
      return {
        title: freelancer ? 'Desistir da contratação' : 'Cancelar contratação',
        body: 'Esta contratação faz parte de uma troca: cancelar não move dinheiro aqui, e a troca segue o próprio fluxo.',
        confirm: freelancer ? 'Desistir' : 'Cancelar contratação',
      };
    case 'withdrawal':
      return {
        title: 'Desistir da contratação',
        body: `Tudo o que está em garantia (${amount(t, t.refundClient)}) volta para o cliente, e a desistência fica na linha do tempo.`,
        confirm: 'Desistir',
      };
  }
}
