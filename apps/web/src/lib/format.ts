export const brl = (v: number): string =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const dt = (iso: string): string => new Date(iso).toLocaleDateString('pt-BR');

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

export const REPORT_REASON_LABEL: Record<string, string> = {
  spam: 'Spam',
  fraud: 'Fraude ou golpe',
  offensive: 'Conteúdo ofensivo',
  off_platform: 'Tenta negociar fora da plataforma',
  illegal: 'Atividade ilegal',
  other: 'Outro',
};
