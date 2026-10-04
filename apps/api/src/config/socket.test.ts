import type { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tokenFor } from '../test-support/http';
import { blocklist } from './blocklist';
import { env } from './env';
import { logger } from './logger';
import { realtime } from './realtime';
import { createSocketServer } from './socket';

type Next = (err?: Error) => void;
type Middleware = (socket: FakeSocket, next: Next) => void;
type Listener = (...args: unknown[]) => Promise<void> | void;

interface FakeSocket {
  handshake: { auth?: { token?: unknown } };
  data: { uid?: number };
  join: ReturnType<typeof vi.fn>;
  on: (event: string, listener: Listener) => void;
  listeners: Map<string, Listener>;
}

const { FakeServer, created, service, emit } = vi.hoisted(() => {
  const emit = vi.fn();
  const created: Array<{
    httpServer: unknown;
    options: Record<string, unknown>;
    middlewares: unknown[];
    handlers: Map<string, unknown>;
    to: (room: string) => { emit: (...args: unknown[]) => void };
  }> = [];
  /** O Server do socket.io, só com o que o código usa: guarda o middleware e os handlers. */
  class FakeServer {
    middlewares: unknown[] = [];
    handlers = new Map<string, unknown>();
    constructor(
      public httpServer: unknown,
      public options: Record<string, unknown>,
    ) {
      created.push(this);
    }
    use(fn: unknown): this {
      this.middlewares.push(fn);
      return this;
    }
    on(event: string, fn: unknown): this {
      this.handlers.set(event, fn);
      return this;
    }
    to(room: string): { emit: (...args: unknown[]) => void } {
      return { emit: (...args: unknown[]) => emit(room, ...args) };
    }
  }
  return {
    FakeServer,
    created,
    emit,
    service: { history: vi.fn(), send: vi.fn() },
  };
});
vi.mock('socket.io', () => ({ Server: FakeServer }));
vi.mock('../modules/messaging/messaging.service', () => ({ messagingService: service }));
vi.mock('./db', async () => (await import('../test-support/fake-db')).dbModule);

const httpServer = { fake: 'http-server' } as unknown as HttpServer;

/** Sobe o servidor de sockets e devolve o que ele registrou. */
function boot(): {
  io: unknown;
  server: (typeof created)[number];
  handshake: Middleware;
  connect: (socket: FakeSocket) => void;
} {
  const io = createSocketServer(httpServer);
  const server = created.at(-1)!;
  return {
    io,
    server,
    handshake: server.middlewares[0] as Middleware,
    connect: server.handlers.get('connection') as (socket: FakeSocket) => void,
  };
}

function fakeSocket(over: Partial<FakeSocket> = {}): FakeSocket {
  const listeners = new Map<string, Listener>();
  return {
    handshake: { auth: {} },
    data: {},
    join: vi.fn(async () => undefined),
    on: (event, listener) => {
      listeners.set(event, listener);
    },
    listeners,
    ...over,
  };
}

/** O handshake com esse token: o que `next` recebeu e o que ficou no socket. */
function tryHandshake(auth: FakeSocket['handshake']['auth']): {
  next: ReturnType<typeof vi.fn>;
  socket: FakeSocket;
} {
  const { handshake } = boot();
  const socket = fakeSocket({ handshake: { auth } });
  const next = vi.fn();
  handshake(socket, next);
  return { next, socket };
}

const expectUnauthorized = (next: ReturnType<typeof vi.fn>, socket: FakeSocket): void => {
  expect(next).toHaveBeenCalledTimes(1);
  const err = next.mock.calls[0]![0] as Error;
  expect(err).toBeInstanceOf(Error);
  expect(err.message).toBe('unauthorized');
  expect(socket.data.uid).toBeUndefined();
};

/**
 * Socket.IO do chat (socket.io mockado): quem passa no handshake, em que salas cada conexão entra
 * e o que os eventos `contract:join` e `message:send` repassam ao service e devolvem no ack.
 */
describe('servidor de sockets', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    created.length = 0;
  });
  afterEach(() => {
    blocklist.delete(7);
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  describe('criação', () => {
    it('fica preso ao servidor HTTP da API, em /socket.io, com credenciais, e é o io devolvido', () => {
      const { io, server } = boot();

      expect(created).toHaveLength(1);
      expect(io).toBe(server);
      expect(server.httpServer).toBe(httpServer);
      expect(server.options.path).toBe('/socket.io');
      expect((server.options.cors as { credentials: boolean }).credentials).toBe(true);
      // Um middleware (o do handshake) e o handler de conexão.
      expect(server.middlewares).toHaveLength(1);
      expect([...server.handlers.keys()]).toEqual(['connection']);
    });

    it('passa a ser o canal do realtime: avisos ao usuário e ao contrato saem pelas salas certas', () => {
      boot();

      realtime.emitToUser(7, 'notification:new', { id: 1 });
      realtime.emitToContract(5, 'message:new', { id: 2 });

      expect(emit.mock.calls).toEqual([
        ['user:7', 'notification:new', { id: 1 }],
        ['contract:5', 'message:new', { id: 2 }],
      ]);
    });

    it("CORS_ORIGINS '*' reflete a origem; lista vira as origens exatas, sem os espaços", async () => {
      vi.stubEnv('CORS_ORIGINS', ' * ');
      vi.resetModules();
      (await import('./socket')).createSocketServer(httpServer);
      expect((created.at(-1)!.options.cors as { origin: unknown }).origin).toBe(true);

      vi.stubEnv('CORS_ORIGINS', 'https://app.escambo.test , https://admin.escambo.test');
      vi.resetModules();
      (await import('./socket')).createSocketServer(httpServer);
      expect((created.at(-1)!.options.cors as { origin: unknown }).origin).toEqual([
        'https://app.escambo.test',
        'https://admin.escambo.test',
      ]);
    });
  });

  describe('handshake', () => {
    it('token de acesso válido entra, e a conexão fica marcada com o id de quem logou', () => {
      const { next, socket } = tryHandshake({ token: tokenFor(7, 'freelancer') });

      expect(next).toHaveBeenCalledTimes(1);
      expect(next).toHaveBeenCalledWith();
      expect(socket.data.uid).toBe(7);
    });

    it('sem token (ou sem o campo auth) é recusado', () => {
      const semToken = tryHandshake({});
      expectUnauthorized(semToken.next, semToken.socket);

      const vazio = tryHandshake({ token: '' });
      expectUnauthorized(vazio.next, vazio.socket);

      const semAuth = tryHandshake(undefined);
      expectUnauthorized(semAuth.next, semAuth.socket);
    });

    it('token assinado com outro segredo é recusado', () => {
      const forged = jwt.sign({ sub: 'ulid-7', uid: 7, role: 'admin' }, 'outro-segredo-qualquer');
      const { next, socket } = tryHandshake({ token: forged });
      expectUnauthorized(next, socket);
    });

    it('token expirado é recusado', () => {
      const expired = jwt.sign({ sub: 'ulid-7', uid: 7, role: 'client' }, env.JWT_SECRET, {
        expiresIn: -10,
      });
      const { next, socket } = tryHandshake({ token: expired });
      expectUnauthorized(next, socket);
    });

    it('conta suspensa ou banida é recusada mesmo com token válido (RN-007)', () => {
      blocklist.add(7);
      const { next, socket } = tryHandshake({ token: tokenFor(7) });
      expectUnauthorized(next, socket);

      // Outra conta, não bloqueada, continua entrando.
      const other = tryHandshake({ token: tokenFor(8) });
      expect(other.next).toHaveBeenCalledWith();
      expect(other.socket.data.uid).toBe(8);
    });
  });

  describe('conexão', () => {
    /** Conecta o usuário 7 e devolve o socket com os eventos registrados. */
    function connected(): FakeSocket {
      const socket = fakeSocket({ data: { uid: 7 } });
      boot().connect(socket);
      return socket;
    }

    it('entra só na sala pessoal de quem conectou e passa a ouvir os dois eventos do chat', () => {
      const socket = connected();

      expect(socket.join.mock.calls).toEqual([['user:7']]);
      expect([...socket.listeners.keys()]).toEqual(['contract:join', 'message:send']);
    });

    describe('contract:join', () => {
      it('quem é parte do contrato entra na sala dele e recebe ok', async () => {
        service.history.mockResolvedValue([]);
        const socket = connected();
        const ack = vi.fn();

        await socket.listeners.get('contract:join')!(5, ack);

        // A checagem de participação é a do histórico, com o id de quem está conectado.
        expect(service.history).toHaveBeenCalledTimes(1);
        expect(service.history).toHaveBeenCalledWith(5, 7);
        expect(socket.join.mock.calls).toEqual([['user:7'], ['contract:5']]);
        expect(ack.mock.calls).toEqual([[{ ok: true }]]);
      });

      it('o id que chega como texto é convertido antes de checar a participação', async () => {
        service.history.mockResolvedValue([]);
        const socket = connected();

        await socket.listeners.get('contract:join')!('12', vi.fn());

        expect(service.history).toHaveBeenCalledWith(12, 7);
        expect(socket.join).toHaveBeenLastCalledWith('contract:12');
      });

      it('quem não é parte não entra na sala e recebe forbidden, sem o motivo', async () => {
        service.history.mockRejectedValue(new Error('Você não participa deste contrato'));
        const socket = connected();
        const ack = vi.fn();

        await socket.listeners.get('contract:join')!(5, ack);

        expect(service.history.mock.calls).toEqual([[5, 7]]);
        expect(socket.join.mock.calls).toEqual([['user:7']]);
        expect(ack.mock.calls).toEqual([[{ ok: false, error: 'forbidden' }]]);
      });

      it('sem ack, entra (ou é recusado) sem quebrar', async () => {
        const socket = connected();
        service.history.mockResolvedValueOnce([]);
        await expect(socket.listeners.get('contract:join')!(5)).resolves.toBeUndefined();
        expect(socket.join).toHaveBeenLastCalledWith('contract:5');

        service.history.mockRejectedValueOnce(new Error('403'));
        await expect(socket.listeners.get('contract:join')!(6)).resolves.toBeUndefined();
        expect(socket.join).not.toHaveBeenCalledWith('contract:6');
      });
    });

    describe('message:send', () => {
      it('envia em nome de quem está conectado, pelo mesmo service do REST, e devolve a mensagem', async () => {
        const message = { id: 90, contractId: 5, content: 'oi' };
        service.send.mockResolvedValue(message);
        const socket = connected();
        const ack = vi.fn();

        await socket.listeners.get('message:send')!({ contractId: '5', content: 'oi' }, ack);

        expect(service.send).toHaveBeenCalledTimes(1);
        expect(service.send).toHaveBeenCalledWith(5, 7, 'oi');
        expect(ack.mock.calls).toEqual([[{ ok: true, message }]]);
      });

      it('o texto passa pela mesma regra da rota REST: chega ao service sem os espaços das pontas', async () => {
        service.send.mockResolvedValue({ id: 91 });
        const socket = connected();
        const ack = vi.fn();

        await socket.listeners.get('message:send')!({ contractId: 5, content: '  oi  ' }, ack);

        expect(service.send).toHaveBeenCalledWith(5, 7, 'oi');
        expect(ack.mock.calls).toEqual([[{ ok: true, message: { id: 91 } }]]);
      });

      it('mensagem ausente, vazia, só de espaços, que não é texto ou acima de 2000 caracteres é recusada no ack, sem chegar ao service', async () => {
        const socket = connected();
        const warn = vi.spyOn(logger, 'warn');

        for (const content of [undefined, '', '   \n\t ', 42, 'x'.repeat(2001)]) {
          const ack = vi.fn();
          await socket.listeners.get('message:send')!({ contractId: 5, content }, ack);
          expect(ack.mock.calls, String(content).slice(0, 10)).toEqual([
            [
              {
                ok: false,
                error: 'validation_error',
                details: { content: [expect.any(String)] },
              },
            ],
          ]);
        }
        // Sem payload nenhum também é recusado (e não quebra).
        const ack = vi.fn();
        await socket.listeners.get('message:send')!(undefined, ack);
        expect(ack.mock.calls[0]![0]).toMatchObject({ ok: false, error: 'validation_error' });

        expect(service.send).not.toHaveBeenCalled();
        // Erro de quem enviou, não do servidor: nada no log.
        expect(warn).not.toHaveBeenCalled();
      });

      it('o vazio diz o motivo, como na rota REST; com exatamente 2000 caracteres passa', async () => {
        service.send.mockResolvedValue({ id: 93 });
        const socket = connected();
        const empty = vi.fn();

        await socket.listeners.get('message:send')!({ contractId: 5, content: '  ' }, empty);
        await socket.listeners.get('message:send')!(
          { contractId: 5, content: 'x'.repeat(2000) },
          vi.fn(),
        );

        expect(empty.mock.calls).toEqual([
          [{ ok: false, error: 'validation_error', details: { content: ['Mensagem vazia'] } }],
        ]);
        expect(service.send.mock.calls).toEqual([[5, 7, 'x'.repeat(2000)]]);
      });

      it('sem ack, mensagem inválida é recusada sem quebrar', async () => {
        const socket = connected();
        await expect(
          socket.listeners.get('message:send')!({ contractId: 5, content: ' ' }),
        ).resolves.toBeUndefined();
        expect(service.send).not.toHaveBeenCalled();
      });

      it('falha do service (não é parte, contrato que não existe…) vira send_failed, sem o motivo', async () => {
        const boom = new Error('Você não participa deste contrato');
        service.send.mockRejectedValue(boom);
        const warn = vi.spyOn(logger, 'warn');
        const socket = connected();
        const ack = vi.fn();

        await socket.listeners.get('message:send')!({ contractId: 5, content: 'oi' }, ack);

        expect(ack.mock.calls).toEqual([[{ ok: false, error: 'send_failed' }]]);
        // O motivo não vai a quem enviou, mas fica no log do servidor.
        expect(warn.mock.calls).toEqual([[{ err: boom }, 'message:send falhou']]);
      });

      it('sem ack, envia (ou falha) sem quebrar', async () => {
        const socket = connected();
        service.send.mockResolvedValueOnce({ id: 92 });
        await expect(
          socket.listeners.get('message:send')!({ contractId: 5, content: 'a' }),
        ).resolves.toBeUndefined();
        expect(service.send).toHaveBeenCalledWith(5, 7, 'a');

        service.send.mockRejectedValueOnce(new Error('falhou'));
        await expect(
          socket.listeners.get('message:send')!({ contractId: 5, content: 'b' }),
        ).resolves.toBeUndefined();
      });
    });

    /**
     * O 2º argumento vem do cliente: sem id no pacote, o socket.io não troca por um ack, e chega o que
     * ele mandou (`42["message:send","x",1]`). Um listener que rejeita cai no unhandledRejection do
     * server.ts, que encerra a API: qualquer usuário logado a derrubaria em loop.
     */
    describe('ack que não é função', () => {
      const notFunctions: unknown[] = [1, 'ok', { ok: true }, null, true];

      it('message:send: mensagem inválida, enviada ou que falha no service resolve sem lançar', async () => {
        const socket = connected();
        const send = socket.listeners.get('message:send')!;
        const warn = vi.spyOn(logger, 'warn');

        for (const ack of notFunctions) {
          await expect(send('x', ack), String(ack)).resolves.toBeUndefined();
          await expect(send({ contractId: 5, content: ' ' }, ack)).resolves.toBeUndefined();
          service.send.mockResolvedValueOnce({ id: 94 });
          await expect(send({ contractId: 5, content: 'oi' }, ack)).resolves.toBeUndefined();
          service.send.mockRejectedValueOnce(new Error('Você não participa deste contrato'));
          await expect(send({ contractId: 5, content: 'oi' }, ack)).resolves.toBeUndefined();
        }

        // A mensagem válida chegou ao service mesmo sem ack de verdade.
        expect(service.send).toHaveBeenCalledTimes(notFunctions.length * 2);
        expect(service.send).toHaveBeenCalledWith(5, 7, 'oi');
        // No log só a falha do service, nunca "listener do socket falhou".
        expect(warn.mock.calls.map((c) => c[1])).toEqual(
          notFunctions.map(() => 'message:send falhou'),
        );
      });

      it('contract:join: quem é parte entra na sala e quem não é fica de fora, sem lançar', async () => {
        const socket = connected();
        const join = socket.listeners.get('contract:join')!;
        const warn = vi.spyOn(logger, 'warn');

        for (const ack of notFunctions) {
          service.history.mockResolvedValueOnce([]);
          await expect(join(5, ack), String(ack)).resolves.toBeUndefined();
          service.history.mockRejectedValueOnce(new Error('403'));
          await expect(join(6, ack)).resolves.toBeUndefined();
        }

        expect(socket.join).toHaveBeenCalledWith('contract:5');
        expect(socket.join).not.toHaveBeenCalledWith('contract:6');
        expect(warn).not.toHaveBeenCalled();
      });

      it('o que escapar do listener (aqui, um ack que lança) vai para o log e não rejeita', async () => {
        const socket = connected();
        const warn = vi.spyOn(logger, 'warn');
        const boom = new Error('ack quebrado');
        const throwing = vi.fn(() => {
          throw boom;
        });

        service.history.mockResolvedValueOnce([]);
        await expect(socket.listeners.get('contract:join')!(5, throwing)).resolves.toBeUndefined();
        service.send.mockResolvedValueOnce({ id: 95 });
        await expect(
          socket.listeners.get('message:send')!({ contractId: 5, content: 'oi' }, throwing),
        ).resolves.toBeUndefined();

        // Uma chamada por evento: o ack que lançou não é chamado de novo com outro resultado.
        expect(throwing.mock.calls).toEqual([[{ ok: true }], [{ ok: true, message: { id: 95 } }]]);
        expect(warn.mock.calls).toEqual([
          [{ err: boom, event: 'contract:join' }, 'listener do socket falhou'],
          [{ err: boom, event: 'message:send' }, 'listener do socket falhou'],
        ]);
      });
    });
  });
});
