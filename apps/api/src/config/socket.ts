import type { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import {
  assertBusinessWrite,
  currentAccount,
  validateAccessIdentity,
} from '../modules/auth/account-access';
import { sendMessageSchema } from '../modules/messaging/messaging.schema';
import { messagingService } from '../modules/messaging/messaging.service';
import { HttpError } from '../utils/http-error';
import { env } from './env';
import { logger } from './logger';
import { realtime } from './realtime';

interface SocketData {
  uid: number;
}

type Ack = (r: unknown) => void;

/**
 * O ack que o cliente mandou, ou um que não faz nada. O 2º argumento vem do cliente e pode ser
 * qualquer coisa (`socket.emit('message:send', {}, 1)`): `ack?.()` só protege null e undefined, e
 * chamar um número lança.
 */
const replyTo = (ack: unknown): Ack => (typeof ack === 'function' ? (ack as Ack) : () => undefined);

/**
 * Listener async que nunca rejeita: o que escapar vai para o log. O socket.io não trata a Promise
 * do listener, e uma rejeição solta cai no unhandledRejection do server.ts, que derruba a API.
 */
function guarded<A extends unknown[]>(
  event: string,
  listener: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A): Promise<void> => {
    try {
      await listener(...args);
    } catch (err) {
      logger.warn({ err, event }, 'listener do socket falhou');
    }
  };
}

/**
 * Sobe o servidor Socket.IO acoplado ao HTTP server do Express. Autentica o
 * handshake por JWT (mesmo token do REST) e isola cada contrato numa "sala"
 * `contract:<id>`, só acessível às partes daquela contratação.
 */
export function createSocketServer(httpServer: HttpServer): Server {
  const allowed = env.CORS_ORIGINS.trim();
  const io = new Server(httpServer, {
    cors: {
      origin: allowed === '*' ? true : allowed.split(',').map((o) => o.trim()),
      credentials: true,
    },
    path: '/socket.io',
  });

  // Middleware de autenticação do handshake.
  io.use(async (socket, next) => {
    const token = (socket.handshake.auth?.token ?? '') as string;
    if (!token) return next(new Error('unauthorized'));
    try {
      const account = await currentAccount(
        validateAccessIdentity(jwt.verify(token, env.JWT_SECRET)),
      );
      (socket.data as SocketData).uid = account.uid;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const uid = (socket.data as SocketData).uid;
    // Sala pessoal: notificações e eventos do usuário chegam em qualquer tela.
    void socket.join(`user:${uid}`);

    // Entra na sala do contrato após checar que o usuário é parte dele.
    socket.on(
      'contract:join',
      guarded('contract:join', async (contractId: unknown, ack?: unknown) => {
        const reply = replyTo(ack);
        const id = Number(contractId);
        let account: Awaited<ReturnType<typeof currentAccount>>;
        try {
          account = await currentAccount(
            validateAccessIdentity(
              jwt.verify(String(socket.handshake.auth?.token ?? ''), env.JWT_SECRET),
            ),
          );
        } catch (err) {
          reply({ ok: false, error: err instanceof HttpError ? err.code : 'unauthorized' });
          socket.disconnect(true);
          return;
        }
        try {
          if (account.status === 'suspended') {
            await messagingService.history(id, uid, { readOnly: true });
          } else {
            await messagingService.history(id, uid);
          }
          await socket.join(`contract:${id}`);
        } catch {
          reply({ ok: false, error: 'forbidden' });
          return;
        }
        reply({ ok: true });
      }),
    );

    // Envia mensagem via socket (mesmo caminho do REST: valida, persiste + broadcast).
    socket.on(
      'message:send',
      guarded(
        'message:send',
        async (payload: { contractId?: unknown; content?: unknown } | undefined, ack?: unknown) => {
          const reply = replyTo(ack);
          try {
            const account = await currentAccount(
              validateAccessIdentity(
                jwt.verify(String(socket.handshake.auth?.token ?? ''), env.JWT_SECRET),
              ),
            );
            assertBusinessWrite(account);
          } catch (err) {
            const code = err instanceof HttpError ? err.code : 'unauthorized';
            reply({ ok: false, error: code });
            if (code !== 'account_suspended') socket.disconnect(true);
            return;
          }
          // A mesma regra da rota REST: vazia, só de espaços ou acima do limite não entra.
          const input = sendMessageSchema.safeParse({ content: payload?.content });
          if (!input.success) {
            reply({
              ok: false,
              error: 'validation_error',
              details: input.error.flatten().fieldErrors,
            });
            return;
          }
          let message: Awaited<ReturnType<typeof messagingService.send>>;
          try {
            message = await messagingService.send(
              Number(payload?.contractId),
              uid,
              input.data.content,
            );
          } catch (err) {
            // Conversa encerrada (RF-062): quem recusa já conferiu que é parte da contratação, então
            // o motivo volta como na rota REST, para a tela trocar o compositor pela faixa. O resto
            // (não é parte, contratação que não existe) continua sem o motivo.
            if (err instanceof HttpError && err.code === 'conversation_closed') {
              reply({ ok: false, error: err.code, message: err.message });
              return;
            }
            logger.warn({ err }, 'message:send falhou');
            reply({ ok: false, error: 'send_failed' });
            return;
          }
          reply({ ok: true, message });
        },
      ),
    );
  });

  realtime.attach(io);
  logger.info('Socket.IO pronto em /socket.io');
  return io;
}
