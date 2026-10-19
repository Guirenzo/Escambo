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
    if (socket) {
      const previousToken = (socket.auth as { token?: string | null }).token;
      socket.auth = { token };
      // auth só afeta o próximo handshake. Renova também a conexão ainda aberta para o
      // servidor não continuar validando o JWT anterior depois de um refresh HTTP.
      if (token && token !== previousToken) {
        socket.disconnect();
        socket.connect();
      } else if (token && !socket.connected) socket.connect();
    }
  });
} catch {
  /* sem window (testes) */
}
