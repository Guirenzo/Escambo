export const brl = (v: number): string =>
  v.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });

export const dt = (iso: string): string => new Date(iso).toLocaleDateString('pt-BR');

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
