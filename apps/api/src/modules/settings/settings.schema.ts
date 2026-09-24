import { z } from 'zod';

/**
 * Parâmetros da plataforma que o admin edita pelo painel (ADR 32, ADR 33). Só entram aqui
 * chaves que a API lê em tempo de execução — mudar o valor tem efeito imediato, e a descrição
 * diz qual. Tipos: inteiro, decimal (dinheiro) e liga/desliga.
 */
export const SETTING_KEYS = [
  'platform_fee_percentage',
  'tacit_approval_days',
  'proposal_expiry_hours',
  'deadline_grace_hours',
  'attachment_retention_days',
  'appeal_window_days',
  'strike_window_days',
  'strike_upload_block_days',
  'strike_review_threshold',
  'moderation_sla_hours',
  'moderation_sla_report_enabled',
  'min_service_price',
  'min_withdrawal_amount',
  'barter_enabled',
  'maintenance_mode',
] as const;
export type SettingKey = (typeof SETTING_KEYS)[number];
export type SettingType = 'integer' | 'decimal' | 'boolean';

export interface SettingDef {
  type: SettingType;
  label: string;
  description: string;
  unit: string;
  min: number;
  max: number;
  defaultValue: number | boolean;
}

export const SETTING_DEFS: Record<SettingKey, SettingDef> = {
  platform_fee_percentage: {
    type: 'integer',
    label: 'Comissão da plataforma',
    description:
      'Sobre o valor bruto das contratações em dinheiro e sobre a torna das trocas (RN-031, RN-066). Vale para o que for criado a partir da mudança; contratações existentes mantêm a taxa registrada.',
    unit: '%',
    min: 0,
    max: 50,
    defaultValue: 15,
  },
  tacit_approval_days: {
    type: 'integer',
    label: 'Aprovação tácita',
    description:
      'Entrega sem resposta do cliente por esse tempo é aprovada em nome dele, liberando o escrow (job tacit-approval).',
    unit: 'dias',
    min: 1,
    max: 30,
    defaultValue: 5,
  },
  proposal_expiry_hours: {
    type: 'integer',
    label: 'Validade da proposta',
    description:
      'Proposta sem resposta do freelancer por esse tempo expira e a reserva volta ao cliente (RN-021, job expire-proposals).',
    unit: 'horas',
    min: 1,
    max: 720,
    defaultValue: 72,
  },
  deadline_grace_hours: {
    type: 'integer',
    label: 'Carência do prazo',
    description:
      'Depois do aviso de prazo estourado, sem entrega nem extensão aprovada, a plataforma abre a disputa em nome do cliente (RN-029, job overdue-contracts).',
    unit: 'horas',
    min: 1,
    max: 168,
    defaultValue: 24,
  },
  attachment_retention_days: {
    type: 'integer',
    label: 'Retenção dos anexos',
    description:
      'Anexo do chat com mais que isso, numa conversa sem contratação aberta, sai do disco; a mensagem fica e diz por quê (ADR 31, job purge-attachments).',
    unit: 'dias',
    min: 7,
    max: 3650,
    defaultValue: 180,
  },
  appeal_window_days: {
    type: 'integer',
    label: 'Prazo para contestar remoção',
    description:
      'Dono de imagem removida pela moderação pode contestar pelo perfil durante esse tempo; depois o arquivo guardado fora do ar é apagado (ADR 41). Vale também para remoções já feitas.',
    unit: 'dias',
    min: 1,
    max: 60,
    defaultValue: 14,
  },
  strike_window_days: {
    type: 'integer',
    label: 'Janela de reincidência',
    description:
      'Remoções não revertidas dentro desse tempo contam juntas: as de imagem para o bloqueio de envio, e todas (imagem, avaliação e mensagem) para a revisão da conta (ADR 41 e 44).',
    unit: 'dias',
    min: 30,
    max: 730,
    defaultValue: 180,
  },
  strike_upload_block_days: {
    type: 'integer',
    label: 'Bloqueio de envio por reincidência',
    description:
      'Da segunda imagem removida na janela em diante, a pessoa fica esse tempo sem enviar imagens, multiplicado pelas imagens removidas depois da primeira. Avaliação e mensagem removidas não bloqueiam. Zero desliga o bloqueio (ADR 41 e 44).',
    unit: 'dias',
    min: 0,
    max: 90,
    defaultValue: 7,
  },
  strike_review_threshold: {
    type: 'integer',
    label: 'Revisão da conta por reincidência',
    description:
      'Com essa quantidade de remoções na janela, de imagem, avaliação ou mensagem, a fila de denúncias recebe a conta para revisão, uma vez enquanto a revisão estiver aberta (ADR 41 e 44).',
    unit: 'remoções',
    min: 2,
    max: 20,
    defaultValue: 3,
  },
  moderation_sla_hours: {
    type: 'integer',
    label: 'Meta da moderação',
    description:
      'Alvo de tempo entre a denúncia e a decisão da fila. O painel de saúde da moderação desenha a meta na série por dia e destaca a mediana que estourar (ADR 50). O relatório diário avisa os admins por e-mail quando ela estoura (ADR 55).',
    unit: 'horas',
    min: 1,
    max: 720,
    defaultValue: 24,
  },
  moderation_sla_report_enabled: {
    type: 'boolean',
    label: 'Relatório da meta da moderação',
    description:
      'Ligado: uma vez por dia, a partir da hora do resumo diário (DIGEST_HOUR, padrão 8h de Brasília), a API confere o dia anterior e a fila; se a mediana de ontem passou da meta ou alguma denúncia espera há mais que a meta, cada admin recebe um e-mail com os números e o link do painel — no máximo um por dia, só quando estoura, com até duas novas tentativas no mesmo dia se o envio falhar (job moderation-sla-report). Contas em revisão por reincidência não contam. Desligado: o painel continua destacando o estouro.',
    unit: '',
    min: 0,
    max: 1,
    defaultValue: true,
  },
  min_service_price: {
    type: 'decimal',
    label: 'Preço mínimo de serviço',
    description:
      'Serviço com preço fixo abaixo disso é recusado ao criar ou editar (RN-016). O formulário mostra o mínimo vigente.',
    unit: 'R$',
    min: 1,
    max: 100000,
    defaultValue: 10,
  },
  min_withdrawal_amount: {
    type: 'decimal',
    label: 'Saque mínimo',
    description:
      'Pedido de saque abaixo disso é recusado (RN-034). A Carteira mostra o mínimo vigente.',
    unit: 'R$',
    min: 1,
    max: 10000,
    defaultValue: 20,
  },
  barter_enabled: {
    type: 'boolean',
    label: 'Trocas de serviço',
    description:
      'Desligado: ninguém propõe troca nova (403) e o app esconde "Propor troca"; trocas já propostas seguem o fluxo normal.',
    unit: '',
    min: 0,
    max: 1,
    defaultValue: true,
  },
  maintenance_mode: {
    type: 'boolean',
    label: 'Modo de manutenção',
    description:
      'Ligado: a API responde 503 para quem não é admin (health, login, parâmetros públicos e este painel continuam) e o app mostra a tela de manutenção. Desligue aqui mesmo.',
    unit: '',
    min: 0,
    max: 1,
    defaultValue: false,
  },
};

export const settingKeyParamSchema = z.object({ key: z.enum(SETTING_KEYS) });
export const updateSettingSchema = z.object({ value: z.union([z.number(), z.boolean()]) });
