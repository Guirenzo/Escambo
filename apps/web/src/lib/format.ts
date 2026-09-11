export const brl = (v: number): string =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const dt = (iso: string): string => new Date(iso).toLocaleDateString('pt-BR');

/** Primeiro nome do perfil ("Bruno" de "Bruno Silva"); sem perfil, a parte local do e-mail. */
export const displayName = (
  fullName: string | null | undefined,
  email: string | undefined,
): string => fullName?.trim().split(/\s+/)[0] || email?.split('@')[0] || '';

export const dtm = (iso: string): string =>
  new Date(iso).toLocaleString('pt-BR', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });

const DAY_MS = 86_400_000;
const startOfDay = (d: Date): number =>
  new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();

export const addDays = (d: Date, days: number): Date => new Date(d.getTime() + days * DAY_MS);

/** Valor de um <input type="date"> (AAAA-MM-DD, no fuso local). */
export const dateInputValue = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Fim do dia (23:59:59 local) de um valor de <input type="date">, em ISO — o prazo vale o dia inteiro. */
export const endOfDayIso = (value: string): string => {
  const [y, m, d] = value.split('-').map(Number);
  return new Date(y!, (m ?? 1) - 1, d ?? 1, 23, 59, 59).toISOString();
};

export interface DeadlineInfo {
  /** Dias de calendário até o prazo (negativo = dias de atraso). */
  daysLeft: number;
  tone: 'ok' | 'soon' | 'late';
  label: string;
}

/** Estado do prazo em relação a agora, em dias de calendário ("faltam 3 dias", "atrasada há 2 dias"). */
export function deadlineInfo(
  deadlineAt: string | null | undefined,
  now: Date = new Date(),
): DeadlineInfo | null {
  if (!deadlineAt) return null;
  const deadline = new Date(deadlineAt);
  const daysLeft = Math.round((startOfDay(deadline) - startOfDay(now)) / DAY_MS);
  if (deadline.getTime() < now.getTime()) {
    const late = -daysLeft;
    return {
      daysLeft,
      tone: 'late',
      label:
        late <= 0 ? 'venceu hoje' : late === 1 ? 'atrasada há 1 dia' : `atrasada há ${late} dias`,
    };
  }
  if (daysLeft <= 0) return { daysLeft: 0, tone: 'soon', label: 'vence hoje' };
  if (daysLeft === 1) return { daysLeft: 1, tone: 'soon', label: 'vence amanhã' };
  return { daysLeft, tone: daysLeft <= 3 ? 'soon' : 'ok', label: `faltam ${daysLeft} dias` };
}

export const hm = (iso: string): string =>
  new Date(iso).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export const BARTER_STATUS_LABEL: Record<string, string> = {
  proposed: 'Proposta',
  accepted: 'Aceita',
  rejected: 'Recusada',
  active: 'Em andamento',
  completed: 'Concluída',
  cancelled: 'Cancelada',
  disputed: 'Em disputa',
};

export const STATUS_LABEL: Record<string, string> = {
  pending: 'Pendente',
  accepted: 'Aceito',
  rejected: 'Recusado',
  in_progress: 'Em andamento',
  delivered: 'Entregue',
  revision_requested: 'Revisão',
  completed: 'Concluído',
  cancelled: 'Cancelado',
  disputed: 'Disputa',
};

export const MILESTONE_STATUS_LABEL: Record<string, string> = {
  pending: 'Aguardando aceite',
  funded: 'Em escrow',
  delivered: 'Entregue',
  approved: 'Aprovado',
  released: 'Liberado',
  cancelled: 'Cancelado',
};

export const DISPUTE_REASON_LABEL: Record<string, string> = {
  not_delivered: 'Não foi entregue',
  quality: 'Qualidade abaixo do combinado',
  deadline: 'Prazo não cumprido',
  scope: 'Escopo diferente do combinado',
  payment: 'Problema com pagamento',
  other: 'Outro motivo',
};

export const DISPUTE_STATUS_LABEL: Record<string, string> = {
  open: 'Aberta',
  under_review: 'Em análise',
  awaiting_parties: 'Aguardando as partes',
  resolved: 'Resolvida',
  closed: 'Encerrada',
};

export const RESOLUTION_LABEL: Record<string, string> = {
  release_freelancer: 'Valor liberado ao freelancer',
  refund_client: 'Valor devolvido ao cliente',
  partial_split: 'Divisão do valor',
  none: 'Sem movimentação',
};

/** Linhas do extrato de R$ (wallet_transactions.reason). */
export const WALLET_REASON_LABEL: Record<string, string> = {
  deposit: 'Depósito via PIX',
  hold: 'Reservado para a proposta',
  payment: 'Pagamento da contratação',
  escrow_in: 'Recebido em escrow',
  escrow_release: 'Liberado do escrow',
  escrow_refund: 'Escrow devolvido ao cliente',
  refund: 'Reembolso',
  withdrawal: 'Saque solicitado',
  withdrawal_refund: 'Saque estornado',
  barter_hold: 'Torna reservada para a troca',
  barter_payment: 'Torna paga na troca',
  barter_in: 'Torna recebida na troca',
};

export const TORNA_STATUS_LABEL: Record<string, string> = {
  none: '',
  pending: 'torna reservada no aceite',
  held: 'torna reservada',
  paid: 'torna paga',
  refunded: 'torna devolvida',
};

export const WITHDRAWAL_STATUS_LABEL: Record<string, string> = {
  requested: 'Aguardando',
  processing: 'Em processamento',
  completed: 'Concluído',
  failed: 'Falhou',
  cancelled: 'Cancelado',
};

/** Classe visual (pill) de cada status de saque. */
export const WITHDRAWAL_STATUS_TONE: Record<string, string> = {
  requested: 'pending',
  processing: 'in_progress',
  completed: 'completed',
  failed: 'cancelled',
  cancelled: 'cancelled',
};

export const DEPOSIT_STATUS_LABEL: Record<string, string> = {
  pending: 'Aguardando pagamento',
  processing: 'Processando',
  paid: 'Confirmado',
  failed: 'Falhou',
  refunded: 'Estornado',
  cancelled: 'Vencido',
};

export const EXPORT_STATUS_LABEL: Record<string, string> = {
  pending: 'gerando',
  processing: 'gerando',
  ready: 'pronta',
  downloaded: 'baixada',
  expired: 'expirada',
  failed: 'falhou',
};

export const DELETION_STATUS_LABEL: Record<string, string> = {
  pending: 'em análise',
  processing: 'em processamento',
  completed: 'concluída',
  rejected: 'recusada',
};

export const REPORT_REASON_LABEL: Record<string, string> = {
  spam: 'Spam',
  fraud: 'Fraude ou golpe',
  offensive: 'Conteúdo ofensivo',
  off_platform: 'Tenta negociar fora da plataforma',
  illegal: 'Atividade ilegal',
  other: 'Outro',
};
