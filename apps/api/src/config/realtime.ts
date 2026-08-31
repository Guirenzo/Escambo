import type { Server } from 'socket.io';

/**
 * Ponte entre a camada de serviço e o Socket.IO. Mantém o service desacoplado
 * do transporte: se nenhum io foi anexado (ex.: testes de integração via REST),
 * as emissões viram no-op silencioso.
 */
let io: Server | null = null;

export const realtime = {
  attach(server: Server): void {
    io = server;
  },
  /** Emite um evento para todos na "sala" de um contrato. */
  emitToContract(contractId: number, event: string, payload: unknown): void {
    io?.to(`contract:${contractId}`).emit(event, payload);
  },
};
