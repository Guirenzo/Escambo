import type { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  accountAccessRepository,
  type AccountAccessRow,
} from '../modules/auth/account-access.repository';
import { tokenFor } from '../test-support/http';
import { env } from './env';
import { realtime } from './realtime';

const lookup = vi.mocked(accountAccessRepository.findCurrent);
const row = (id: number, extra: Partial<Omit<AccountAccessRow, 'constructor'>> = {}) =>
  ({
    id,
    ulid: `ulid-${id}`,
    role: 'client',
    status: 'active',
    deleted_at: null,
    ...extra,
  }) as AccountAccessRow;
const receiver = (uid: number, token = tokenFor(uid)) => ({
  handshake: { auth: { token } },
  data: { uid },
  emit: vi.fn(),
  disconnect: vi.fn(),
});
let sockets: ReturnType<typeof receiver>[];
let fetchSockets: ReturnType<typeof vi.fn>;
let disconnectSockets: ReturnType<typeof vi.fn>;
let to: ReturnType<typeof vi.fn>;
let inRoom: ReturnType<typeof vi.fn>;
let emit: ReturnType<typeof vi.fn>;
beforeEach(() => {
  sockets = [];
  lookup.mockReset().mockImplementation(async (identity) => row(identity.uid));
  fetchSockets = vi.fn(async () => sockets);
  disconnectSockets = vi.fn();
  emit = vi.fn();
  to = vi.fn(() => ({ emit }));
  inRoom = vi.fn(() => ({ fetchSockets, disconnectSockets }));
  realtime.attach({ to, in: inRoom } as unknown as Server);
});
afterEach(() => realtime.attach(null));

describe('realtime com estado atual por destinatário', () => {
  it('emite para sala pessoal e contrato apenas depois da consulta atual', async () => {
    const socket = receiver(7);
    sockets.push(socket);
    await realtime.emitToUser(7, 'notification:new', { id: 1 });
    await realtime.emitToContract(5, 'message:new', { id: 2 });
    expect(inRoom.mock.calls).toEqual([['user:7'], ['contract:5']]);
    expect(socket.emit.mock.calls).toEqual([
      ['notification:new', { id: 1 }],
      ['message:new', { id: 2 }],
    ]);
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it('preserva leitores suspensos e exclui banido sem prejudicar outro participante', async () => {
    const active = receiver(7),
      suspended = receiver(8),
      banned = receiver(9);
    sockets.push(active, suspended, banned);
    lookup.mockImplementation(async (identity) =>
      row(identity.uid, {
        status: identity.uid === 8 ? 'suspended' : identity.uid === 9 ? 'banned' : 'active',
      }),
    );
    await realtime.emitToContract(5, 'message:new', { id: 2 });
    expect(active.emit).toHaveBeenCalledOnce();
    expect(suspended.emit).toHaveBeenCalledOnce();
    expect(banned.emit).not.toHaveBeenCalled();
    expect(banned.disconnect).toHaveBeenCalledWith(true);
    expect(active.disconnect).not.toHaveBeenCalled();
  });
  it('corta excluído e consulta novamente depois de moderação externa', async () => {
    const socket = receiver(7);
    sockets.push(socket);
    lookup.mockResolvedValueOnce(row(7)).mockResolvedValueOnce(row(7, { deleted_at: new Date() }));
    await realtime.emitToUser(7, 'notification:new', {});
    await realtime.emitToUser(7, 'notification:new', {});
    expect(socket.emit).toHaveBeenCalledOnce();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
  });
  it('duas abas compartilham somente a consulta da mesma emissão, sem cache persistente', async () => {
    sockets.push(receiver(7), receiver(7));
    await realtime.emitToUser(7, 'notification:new', {});
    expect(lookup).toHaveBeenCalledTimes(1);
    await realtime.emitToUser(7, 'notification:new', {});
    expect(lookup).toHaveBeenCalledTimes(2);
  });
  it.each(['expired', 'other-id', 'missing'] as const)(
    'nega destinatário com credencial %s',
    async (kind) => {
      const token =
        kind === 'expired'
          ? jwt.sign({ sub: 'ulid-7', uid: 7, role: 'client' }, env.JWT_SECRET, { expiresIn: -1 })
          : kind === 'other-id'
            ? tokenFor(8)
            : '';
      const socket = receiver(7, token);
      sockets.push(socket);
      await realtime.emitToContract(5, 'message:new', {});
      expect(socket.emit).not.toHaveBeenCalled();
      expect(socket.disconnect).toHaveBeenCalledWith(true);
      expect(lookup).not.toHaveBeenCalled();
    },
  );
  it('fecha entrega se o banco ou busca de sockets falhar, sem rejeição solta', async () => {
    const socket = receiver(7);
    sockets.push(socket);
    lookup.mockRejectedValue(new Error('db down'));
    await expect(realtime.emitToUser(7, 'notification:new', {})).resolves.toBeUndefined();
    expect(socket.emit).not.toHaveBeenCalled();
    expect(socket.disconnect).toHaveBeenCalledWith(true);
    fetchSockets.mockRejectedValue(new Error('io down'));
    await expect(realtime.emitToContract(5, 'message:new', {})).resolves.toBeUndefined();
  });
  it('aviso da própria moderação precede desconexão e não carrega conteúdo protegido', async () => {
    await realtime.emitToUser(7, 'account:status', { status: 'banned' });
    realtime.disconnectUser(7);
    expect(to).toHaveBeenCalledWith('user:7');
    expect(emit).toHaveBeenCalledWith('account:status', { status: 'banned' });
    expect(disconnectSockets).toHaveBeenCalledWith(true);
    expect(lookup).not.toHaveBeenCalled();
    expect(emit.mock.invocationCallOrder[0]).toBeLessThan(
      disconnectSockets.mock.invocationCallOrder[0]!,
    );
  });
  it('sem servidor anexado continua no-op', async () => {
    realtime.attach(null);
    await realtime.emitToUser(7, 'notification:new', {});
    await realtime.emitToContract(5, 'message:new', {});
    realtime.disconnectUser(7);
    expect(lookup).not.toHaveBeenCalled();
    expect(inRoom).not.toHaveBeenCalled();
  });
});
