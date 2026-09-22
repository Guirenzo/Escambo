/**
 * Onde o push pode ser entregue (ADR 52). O endpoint vem do navegador de quem assina, e é a API
 * que faz a requisição: sem filtro, uma conta poderia apontar para um host interno e usar a rota
 * de teste como sonda de rede. Por isso, quando o envio é de verdade, só valem os serviços de
 * push dos navegadores.
 */

/** Serviços de push dos navegadores: Chrome, Firefox, Edge e Safari. */
export const PUSH_HOSTS = [
  'fcm.googleapis.com',
  'updates.push.services.mozilla.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'web.push.apple.com',
] as const;

const isIpLiteral = (host: string): boolean =>
  /^\d{1,3}(\.\d{1,3}){3}$/.test(host) || host.startsWith('[');

/**
 * `enforceHosts` liga a lista fechada: use quando o envio é real (provedor webpush). Com o
 * provedor simulado nada sai da máquina, então basta ser https e não apontar para um IP.
 */
export function isPushEndpointAllowed(endpoint: string, enforceHosts: boolean): boolean {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  if (isIpLiteral(host)) return false;
  if (!enforceHosts) return true;
  return PUSH_HOSTS.some((allowed) => host === allowed || host.endsWith(`.${allowed}`));
}
