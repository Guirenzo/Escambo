import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { bearer, routerApp } from '../../test-support/http';
import { accountAccessRepository } from '../auth/account-access.repository';
import { supportRoutes, adminSupportRoutes } from './support.routes';
const { svc } = vi.hoisted(() => ({
  svc: {
    list: vi.fn(),
    detail: vi.fn(),
    create: vi.fn(),
    reply: vi.fn(),
    close: vi.fn(),
    update: vi.fn(),
  },
}));
vi.mock('./support.service', () => ({ supportService: svc }));
const app = routerApp('/api/support/tickets', supportRoutes);
const admin = routerApp('/api/admin/support/tickets', adminSupportRoutes);
const OWNER = bearer(7),
  ADMIN = bearer(90, 'admin');
beforeEach(() => {
  vi.clearAllMocks();
  for (const fn of Object.values(svc)) fn.mockReset().mockResolvedValue({ id: 12 });
});
describe('HTTP de suporte privado', () => {
  it('admin ainda não verificado não lê conteúdo privado da fila', async () => {
    vi.mocked(accountAccessRepository.findCurrent).mockResolvedValueOnce({
      id: 90,
      ulid: 'ulid-90',
      role: 'admin',
      status: 'pending_verification',
      deleted_at: null,
    } as Awaited<ReturnType<typeof accountAccessRepository.findCurrent>>);
    await request(admin).get('/api/admin/support/tickets/12').set(ADMIN).expect(403);
    expect(svc.detail).not.toHaveBeenCalled();
  });
  it.each([
    [app, 'get', '/api/support/tickets'],
    [app, 'post', '/api/support/tickets'],
    [app, 'get', '/api/support/tickets/12'],
    [app, 'post', '/api/support/tickets/12/messages'],
    [app, 'post', '/api/support/tickets/12/close'],
    [admin, 'get', '/api/admin/support/tickets'],
    [admin, 'get', '/api/admin/support/tickets/12'],
    [admin, 'post', '/api/admin/support/tickets/12/messages'],
    [admin, 'patch', '/api/admin/support/tickets/12'],
  ] as const)('%s %s %s exige autenticação', async (target, method, url) => {
    await request(target)[method](url).send({}).expect(401);
    for (const fn of Object.values(svc)) expect(fn).not.toHaveBeenCalled();
  });
  it('usuário comum não consulta nem atende fila administrativa', async () => {
    await request(admin).get('/api/admin/support/tickets').set(OWNER).expect(403);
    await request(admin)
      .post('/api/admin/support/tickets/12/messages')
      .set(OWNER)
      .send({ message: 'Oi' })
      .expect(403);
    expect(svc.list).not.toHaveBeenCalled();
    expect(svc.reply).not.toHaveBeenCalled();
  });
  it('lista/detalhe usam titular atual e query validada', async () => {
    await request(app)
      .get('/api/support/tickets?page=2&limit=10&status=resolved')
      .set(OWNER)
      .expect(200);
    expect(svc.list).toHaveBeenCalledWith(7, { page: 2, limit: 10, status: 'resolved' });
    await request(app).get('/api/support/tickets/12?beforeId=30').set(OWNER).expect(200);
    expect(svc.detail).toHaveBeenCalledWith(12, 7, 30);
    await request(app).get('/api/support/tickets?userId=8').set(OWNER).expect(422);
    await request(app).get('/api/support/tickets/0').set(OWNER).expect(422);
  });
  it('abertura, mensagem e fechamento têm códigos e corpos estritos', async () => {
    const body = {
      category: 'account',
      subject: 'Minha conta',
      description: 'Descrição do atendimento',
    };
    await request(app).post('/api/support/tickets').set(OWNER).send(body).expect(201);
    expect(svc.create).toHaveBeenCalledWith(7, body);
    await request(app)
      .post('/api/support/tickets/12/messages')
      .set(OWNER)
      .send({ message: '  Minha resposta  ' })
      .expect(201);
    expect(svc.reply).toHaveBeenCalledWith(12, 7, false, { message: 'Minha resposta' });
    await request(app).post('/api/support/tickets/12/close').set(OWNER).send({}).expect(200);
    expect(svc.close).toHaveBeenCalledWith(12, 7);
    await request(app)
      .post('/api/support/tickets/12/messages')
      .set(OWNER)
      .send({ message: 'Olá', internal: true })
      .expect(422);
  });
  it('admin lê notas, responde, resolve e muda prioridade por borda própria', async () => {
    await request(admin).get('/api/admin/support/tickets').set(ADMIN).expect(200);
    expect(svc.list).toHaveBeenCalledWith(null, { page: 1, limit: 20 });
    await request(admin).get('/api/admin/support/tickets/12').set(ADMIN).expect(200);
    expect(svc.detail).toHaveBeenCalledWith(12, null, undefined);
    await request(admin)
      .post('/api/admin/support/tickets/12/messages')
      .set(ADMIN)
      .send({ message: 'Resposta', resolve: true })
      .expect(201);
    expect(svc.reply).toHaveBeenCalledWith(12, 90, true, {
      message: 'Resposta',
      internal: false,
      resolve: true,
    });
    await request(admin)
      .patch('/api/admin/support/tickets/12')
      .set(ADMIN)
      .send({ priority: 'critical', status: 'in_progress' })
      .expect(200);
    expect(svc.update).toHaveBeenCalledWith(12, 90, {
      priority: 'critical',
      status: 'in_progress',
    });
    await request(admin)
      .post('/api/admin/support/tickets/12/messages')
      .set(ADMIN)
      .send({ message: 'Nota', internal: true, resolve: true })
      .expect(422);
    await request(admin)
      .patch('/api/admin/support/tickets/12')
      .set(ADMIN)
      .send({ status: 'resolved' })
      .expect(422);
  });
});
