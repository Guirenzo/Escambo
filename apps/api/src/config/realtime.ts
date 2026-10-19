import type { Server } from 'socket.io';
import jwt from 'jsonwebtoken';
import { currentAccount, validateAccessIdentity } from '../modules/auth/account-access';
import { env } from './env';
import { logger } from './logger';

/**
 * Ponte entre a camada de serviço e o Socket.IO. Mantém o service desacoplado
 * do transporte: se nenhum io foi anexado (ex.: testes de integração via REST),
 * as emissões viram no-op silencioso.
 */
let io: Server | null = null;

/** Revalida cada destinatário, inclusive se a moderação veio de outro processo. */
async function deliver(room: string, event: string, payload: unknown): Promise<void> {
  const server = io;
  if (!server) return;
  try {
    const sockets = await server.in(room).fetchSockets();
    const accounts = new Map<string, ReturnType<typeof currentAccount>>();
    await Promise.all(
      sockets.map(async (socket) => {
        try {
          const identity = validateAccessIdentity(
            jwt.verify(String(socket.handshake.auth?.token ?? ''), env.JWT_SECRET),
          );
          if (identity.uid !== socket.data.uid) throw new Error('socket identity changed');
          const key = `${identity.uid}:${identity.sub}`;
          let account = accounts.get(key);
          if (!account) {
            account = currentAccount(identity);
            accounts.set(key, account);
          }
          await account;
          socket.emit(event, payload);
        } catch {
          socket.disconnect(true);
        }
      }),
    );
  } catch (err) {
    logger.warn({ err, room, event }, 'emissão realtime não concluída');
  }
}

export const realtime = {
  attach(server: Server | null): void {
    io = server;
  },
  /** Emite um evento para todas as conexões de um usuário (sala `user:<id>`). */
  async emitToUser(userId: number, event: string, payload: unknown): Promise<void> {
    // Aviso da própria moderação precede desconexão, inclusive no banimento.
    if (event === 'account:status') {
      io?.to(`user:${userId}`).emit(event, payload);
      return;
    }
    await deliver(`user:${userId}`, event, payload);
  },
  /** Emite um evento para todos na "sala" de um contrato. */
  async emitToContract(contractId: number, event: string, payload: unknown): Promise<void> {
    await deliver(`contract:${contractId}`, event, payload);
  },
  /** Banimento/exclusão encerram conexões existentes, inclusive leitura de salas. */
  disconnectUser(userId: number): void {
    io?.in(`user:${userId}`).disconnectSockets(true);
  },
};
