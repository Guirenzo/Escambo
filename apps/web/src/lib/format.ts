export const brl = (v: number): string =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const dt = (iso: string): string => new Date(iso).toLocaleDateString('pt-BR');

export const dtm = (iso: string): string =>
  new Date(iso).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

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
