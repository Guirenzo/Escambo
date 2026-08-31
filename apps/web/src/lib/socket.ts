import { io, type Socket } from 'socket.io-client';
import { getToken } from './api';

/**
 * Socket.IO singleton. Conecta na mesma origem (o Vite faz proxy de /socket.io
 * para a API) autenticando com o mesmo JWT do REST. Reconecta com o token atual.
 */
let socket: Socket | null = null;

export function getSocket(): Socket {
  if (!socket) {
    socket = io({
      path: '/socket.io',
      auth: { token: getToken() },
      autoConnect: true,
    });
  }
  return socket;
}

export function disconnectSocket(): void {
  socket?.disconnect();
  socket = null;
}
