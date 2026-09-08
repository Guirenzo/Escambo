import { io, type Socket } from 'socket.io-client';
import { getToken, SESSION_TOKEN_EVENT } from './api';

/**
 * Socket.IO singleton. Conecta na mesma origem (o Vite/nginx faz proxy de /socket.io
 * para a API) autenticando com o mesmo JWT do REST. Quando o access token é renovado,
 * a credencial do socket é atualizada para as próximas (re)conexões.
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

// Token renovado pelo client HTTP → reconexões do socket usam o token novo.
try {
  window.addEventListener(SESSION_TOKEN_EVENT, (e) => {
    const token = (e as CustomEvent<string | null>).detail;
    if (socket) socket.auth = { token };
  });
} catch {
  /* sem window (testes) */
}
