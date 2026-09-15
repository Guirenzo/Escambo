import { z } from 'zod';

/**
 * Parâmetros da plataforma que o admin edita pelo painel (ADR 32). Só entram aqui chaves que a
 * API lê em tempo de execução — mudar o valor tem efeito imediato, e a descrição diz qual.
 */
export const SETTING_KEYS = [
  'platform_fee_percentage',
  'tacit_approval_days',
  'proposal_expiry_hours',
  'deadline_grace_hours',
  'attachment_retention_days',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];

export interface SettingDef {
  label: string;
  description: string;
  unit: string;
  min: number;
  max: number;
  defaultValue: number;
}

export const SETTING_DEFS: Record<SettingKey, SettingDef> = {
  platform_fee_percentage: {
    label: 'Comissão da plataforma',
    description:
      'Sobre o valor bruto das contratações em dinheiro e sobre a torna das trocas (RN-031, RN-066). Vale para o que for criado a partir da mudança; contratações existentes mantêm a taxa registrada.',
    unit: '%',
    min: 0,
    max: 50,
    defaultValue: 15,
  },
  tacit_approval_days: {
    label: 'Aprovação tácita',
    description:
      'Entrega sem resposta do cliente por esse tempo é aprovada em nome dele, liberando o escrow (job tacit-approval).',
    unit: 'dias',
    min: 1,
    max: 30,
    defaultValue: 5,
  },
  proposal_expiry_hours: {
    label: 'Validade da proposta',
    description:
      'Proposta sem resposta do freelancer por esse tempo expira e a reserva volta ao cliente (RN-021, job expire-proposals).',
    unit: 'horas',
    min: 1,
    max: 720,
    defaultValue: 72,
  },
  deadline_grace_hours: {
    label: 'Carência do prazo',
    description:
      'Depois do aviso de prazo estourado, sem entrega nem extensão aprovada, a plataforma abre a disputa em nome do cliente (RN-029, job overdue-contracts).',
    unit: 'horas',
    min: 1,
    max: 168,
    defaultValue: 24,
  },
  attachment_retention_days: {
    label: 'Retenção dos anexos',
    description:
      'Anexo do chat com mais que isso, numa conversa sem contratação aberta, sai do disco; a mensagem fica e diz por quê (ADR 31, job purge-attachments).',
    unit: 'dias',
    min: 7,
    max: 3650,
    defaultValue: 180,
  },
};

export const settingKeyParamSchema = z.object({ key: z.enum(SETTING_KEYS) });
export const updateSettingSchema = z.object({ value: z.number().int() });
