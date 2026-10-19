import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api, setSession } from './api';

beforeEach(() => {
  setSession(null);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers(),
      json: async () => ({ id: 7 }),
    }),
  );
});
afterEach(() => {
  setSession(null);
  vi.unstubAllGlobals();
});

describe('contrato HTTP do atendimento', () => {
  const cases: [string, () => Promise<unknown>, string, string, unknown?][] = [
    ['lista própria sem filtro', () => api.supportTickets(), '/api/support/tickets', 'GET'],
    [
      'lista própria filtrada',
      () => api.supportTickets({ page: 2, limit: 20, status: 'waiting_user' }),
      '/api/support/tickets?page=2&limit=20&status=waiting_user',
      'GET',
    ],
    ['detalhe público', () => api.supportTicket(7), '/api/support/tickets/7', 'GET'],
    [
      'janela pública anterior',
      () => api.supportTicket(7, 52),
      '/api/support/tickets/7?beforeId=52',
      'GET',
    ],
    [
      'abertura',
      () =>
        api.createSupportTicket({
          category: 'account',
          subject: 'Minha conta',
          description: 'Preciso de atendimento',
          contractId: null,
        }),
      '/api/support/tickets',
      'POST',
      {
        category: 'account',
        subject: 'Minha conta',
        description: 'Preciso de atendimento',
        contractId: null,
      },
    ],
    [
      'resposta pública',
      () => api.replySupportTicket(7, { message: 'Mensagem' }),
      '/api/support/tickets/7/messages',
      'POST',
      { message: 'Mensagem' },
    ],
    [
      'encerramento do titular',
      () => api.closeSupportTicket(7),
      '/api/support/tickets/7/close',
      'POST',
    ],
    ['fila administrativa', () => api.adminSupportTickets(), '/api/admin/support/tickets', 'GET'],
    [
      'fila administrativa filtrada',
      () => api.adminSupportTickets({ page: 3, limit: 50, status: 'open' }),
      '/api/admin/support/tickets?page=3&limit=50&status=open',
      'GET',
    ],
    [
      'detalhe administrativo',
      () => api.adminSupportTicket(7),
      '/api/admin/support/tickets/7',
      'GET',
    ],
    [
      'janela administrativa anterior',
      () => api.adminSupportTicket(7, 52),
      '/api/admin/support/tickets/7?beforeId=52',
      'GET',
    ],
    [
      'resposta administrativa',
      () => api.adminReplySupportTicket(7, { message: 'Retorno', resolve: true, internal: false }),
      '/api/admin/support/tickets/7/messages',
      'POST',
      { message: 'Retorno', resolve: true, internal: false },
    ],
    [
      'nota administrativa',
      () => api.adminReplySupportTicket(7, { message: 'Contexto', internal: true }),
      '/api/admin/support/tickets/7/messages',
      'POST',
      { message: 'Contexto', internal: true },
    ],
    [
      'prioridade e situação',
      () => api.adminUpdateSupportTicket(7, { priority: 'high', status: 'in_progress' }),
      '/api/admin/support/tickets/7',
      'PATCH',
      { priority: 'high', status: 'in_progress' },
    ],
  ];
  it.each(cases)(
    '%s usa verbo, caminho e corpo definidos no contrato',
    async (_name, call, url, method, body) => {
      await expect(call()).resolves.toEqual({ id: 7 });
      const [actualUrl, init] = vi.mocked(fetch).mock.calls[0]!;
      expect(actualUrl).toBe(url);
      expect(init?.method ?? 'GET').toBe(method);
      expect(init?.body ? JSON.parse(init.body as string) : undefined).toEqual(body);
    },
  );
});
