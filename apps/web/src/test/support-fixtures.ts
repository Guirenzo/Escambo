import type { SupportMessage, SupportTicketDetail } from '@escambo/types';

export const supportMessage = (
  id: number,
  patch: Partial<SupportMessage> = {},
): SupportMessage => ({
  id,
  ticketId: 7,
  senderId: 1,
  from: 'user',
  message: `Mensagem ${id}`,
  internal: false,
  createdAt: '2026-10-15T12:00:00.000Z',
  ...patch,
});
export const supportTicket = (patch: Partial<SupportTicketDetail> = {}): SupportTicketDetail => ({
  id: 7,
  ulid: '01SUPORTEPROTOCOLO',
  userId: 1,
  ownerDeleted: false,
  contractId: null,
  category: 'account',
  subject: 'Ajuda com minha conta',
  status: 'open',
  priority: 'medium',
  assignedTo: null,
  firstResponseAt: null,
  slaDueAt: '2026-10-16T12:00:00.000Z',
  slaAlertedAt: null,
  resolvedAt: null,
  closedAt: null,
  createdAt: '2026-10-15T12:00:00.000Z',
  updatedAt: '2026-10-15T12:00:00.000Z',
  messages: [supportMessage(1)],
  nextBeforeId: null,
  ...patch,
});
