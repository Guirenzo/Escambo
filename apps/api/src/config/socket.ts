import type { Server as HttpServer } from 'node:http';
import jwt from 'jsonwebtoken';
import { Server } from 'socket.io';
import type { AuthPayload } from '../middlewares/authenticate';
import { messagingService } from '../modules/messaging/messaging.service';
import { env } from './env';
import { logger } from './logger';
import { realtime } from './realtime';

interface SocketData {
  uid: number;
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
  io.use((socket, next) => {
    const token = (socket.handshake.auth?.token ?? '') as string;
    if (!token) return next(new Error('unauthorized'));
    try {
      const payload = jwt.verify(token, env.JWT_SECRET) as AuthPayload;
      (socket.data as SocketData).uid = payload.uid;
      next();
    } catch {
      next(new Error('unauthorized'));
    }
  });

  io.on('connection', (socket) => {
    const uid = (socket.data as SocketData).uid;

    // Entra na sala do contrato após checar que o usuário é parte dele.
    socket.on('contract:join', async (contractId: number, ack?: (r: unknown) => void) => {
      try {
        await messagingService.history(Number(contractId), uid); // valida participação (403 se não)
        await socket.join(`contract:${contractId}`);
        ack?.({ ok: true });
      } catch {
        ack?.({ ok: false, error: 'forbidden' });
      }
    });

    // Envia mensagem via socket (mesmo caminho do REST: persiste + broadcast).
    socket.on(
      'message:send',
      async (payload: { contractId: number; content: string }, ack?: (r: unknown) => void) => {
        try {
          const message = await messagingService.send(
            Number(payload.contractId),
            uid,
            String(payload.content ?? ''),
          );
          ack?.({ ok: true, message });
        } catch (err) {
          logger.warn({ err }, 'message:send falhou');
          ack?.({ ok: false, error: 'send_failed' });
        }
      },
    );
  });

  realtime.attach(io);
  logger.info('Socket.IO pronto em /socket.io');
  return io;
}
