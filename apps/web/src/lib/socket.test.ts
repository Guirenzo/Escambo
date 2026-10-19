import { io } from 'socket.io-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setToken } from './api';
import { disconnectSocket, getSocket } from './socket';

/**
 * Um socket só para o app inteiro, autenticado com o mesmo JWT do REST. Quando o cliente HTTP
 * renova o access token, as próximas reconexões precisam sair com o token novo.
 */

interface FakeSocket {
  auth: unknown;
  connected: boolean;
  connect: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}
vi.mock('socket.io-client', () => ({
  io: vi.fn((options: { auth: unknown }): FakeSocket => ({
    auth: options.auth,
    connected: true,
    connect: vi.fn(),
    disconnect: vi.fn(),
  })),
}));

const ioMock = vi.mocked(io);

beforeEach(() => {
  ioMock.mockClear();
  setToken(null);
});
afterEach(() => {
  disconnectSocket();
  setToken(null);
});

describe('socket do app', () => {
  it('conecta na mesma origem, em /socket.io, com o token da sessão', () => {
    setToken('tok-1');

    const socket = getSocket();

    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(ioMock).toHaveBeenCalledWith({
      path: '/socket.io',
      auth: { token: 'tok-1' },
      autoConnect: true,
    });
    expect(socket.auth).toEqual({ token: 'tok-1' });
  });

  it('é um só: pedir de novo devolve a mesma conexão', () => {
    const first = getSocket();
    const second = getSocket();
    expect(second).toBe(first);
    expect(ioMock).toHaveBeenCalledTimes(1);
  });

  it('token renovado refaz o handshake mesmo se o socket ainda estiver conectado', () => {
    setToken('velho');
    const socket = getSocket();

    setToken('novo');

    expect(socket.auth).toEqual({ token: 'novo' });
    // A mesma instância refaz o handshake para o servidor deixar de validar o JWT anterior.
    expect(ioMock).toHaveBeenCalledTimes(1);
    expect(socket.disconnect).toHaveBeenCalledTimes(1);
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('token igual não interrompe uma conexão aberta', () => {
    setToken('vigente');
    const socket = getSocket();
    setToken('vigente');
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.connect).not.toHaveBeenCalled();
    expect(ioMock).toHaveBeenCalledTimes(1);
  });

  it('token igual recupera uma conexão já encerrada, sem desconectar de novo', () => {
    setToken('vigente');
    const socket = getSocket();
    socket.connected = false;
    setToken('vigente');
    expect(socket.disconnect).not.toHaveBeenCalled();
    expect(socket.connect).toHaveBeenCalledTimes(1);
  });

  it('refresh reconecta o socket existente se o JWT anterior encerrou a conexão', () => {
    setToken('vencido');
    const socket = getSocket();
    socket.connected = false;
    setToken('renovado');
    expect(socket.auth).toEqual({ token: 'renovado' });
    expect(socket.connect).toHaveBeenCalledTimes(1);
    expect(ioMock).toHaveBeenCalledTimes(1);
  });

  it('limpar token não tenta recuperar uma conexão encerrada', () => {
    setToken('antigo');
    const socket = getSocket();
    socket.connected = false;
    setToken(null);
    expect(socket.auth).toEqual({ token: null });
    expect(socket.connect).not.toHaveBeenCalled();
  });

  it('sair desconecta e a próxima conexão é nova, com o token de quem entrar', () => {
    setToken('conta-a');
    const first = getSocket();

    disconnectSocket();
    expect(first.disconnect).toHaveBeenCalledTimes(1);

    setToken('conta-b');
    const second = getSocket();
    expect(second).not.toBe(first);
    expect(ioMock).toHaveBeenLastCalledWith({
      path: '/socket.io',
      auth: { token: 'conta-b' },
      autoConnect: true,
    });
    // A conexão antiga, já encerrada, não recebe a credencial da conta nova.
    expect(first.auth).toEqual({ token: 'conta-a' });
  });

  it('sem conexão aberta, desconectar e renovar o token não abrem conexão nenhuma', () => {
    expect(() => disconnectSocket()).not.toThrow();
    setToken('tok-2');
    expect(ioMock).not.toHaveBeenCalled();
  });

  it('ambiente sem window: o módulo carrega mesmo sem conseguir escutar o token', async () => {
    vi.resetModules();
    const spy = vi.spyOn(window, 'addEventListener').mockImplementation(() => {
      throw new Error('sem window');
    });

    const fresh = await import('./socket');
    spy.mockRestore();

    expect(fresh.getSocket().auth).toEqual({ token: null });
    fresh.disconnectSocket();
  });
});
