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
