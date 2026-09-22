/**
 * Avisos push no navegador (ADR 52): assinatura por aparelho. O service worker (/sw.js) mostra o
 * aviso; aqui ficam o registro, a assinatura e as contas puras que os testes cobrem.
 */

/** O que a tela mostra: cada estado tem uma frase e um botão diferentes. */
export type PushState = 'unsupported' | 'denied' | 'on' | 'off';

/** Chave VAPID em base64url (como a API devolve) no formato que o PushManager aceita. */
export function urlBase64ToUint8Array(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url.padEnd(base64url.length + ((4 - (base64url.length % 4)) % 4), '=');
  const binary = atob(padded.replace(/-/g, '+').replace(/_/g, '/'));
  const bytes = new Uint8Array(new ArrayBuffer(binary.length));
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * O endpoint da última assinatura feita nesta máquina. Guardado porque sair da conta precisa
 * avisar a API antes de a sessão ser apagada, e ler a assinatura do navegador é assíncrono.
 */
const ENDPOINT_KEY = 'escambo.push.endpoint';

export function rememberDeviceEndpoint(endpoint: string | null): void {
  try {
    if (endpoint) localStorage.setItem(ENDPOINT_KEY, endpoint);
    else localStorage.removeItem(ENDPOINT_KEY);
  } catch {
    /* navegador sem armazenamento: o aparelho ainda desassina localmente */
  }
}

export function lastDeviceEndpoint(): string | null {
  try {
    return localStorage.getItem(ENDPOINT_KEY);
  } catch {
    return null;
  }
}

/**
 * A assinatura guardada foi feita com esta chave VAPID? Se o servidor trocou de chave, o
 * navegador recusa assinar de novo por cima da antiga (InvalidStateError): é preciso desfazer
 * a assinatura velha antes.
 */
export function sameServerKey(current: ArrayBuffer | null | undefined, publicKey: string): boolean {
  if (!current) return false;
  const expected = urlBase64ToUint8Array(publicKey);
  const actual = new Uint8Array(current);
  if (actual.length !== expected.length) return false;
  return actual.every((byte, i) => byte === expected[i]);
}

/** Estado a partir do que o navegador oferece e do que já está assinado neste aparelho. */
export function pushStateOf(
  supported: boolean,
  permission: NotificationPermission,
  subscribed: boolean,
): PushState {
  if (!supported) return 'unsupported';
  if (permission === 'denied') return 'denied';
  return subscribed ? 'on' : 'off';
}

export const pushSupported = (): boolean =>
  typeof window !== 'undefined' &&
  'serviceWorker' in navigator &&
  'PushManager' in window &&
  'Notification' in window;

/** Registra o service worker uma vez por aba e devolve o registro pronto. */
export async function ensureServiceWorker(): Promise<ServiceWorkerRegistration> {
  await navigator.serviceWorker.register('/sw.js');
  return navigator.serviceWorker.ready;
}

/** A assinatura deste aparelho, se já existir. */
export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const registration = await navigator.serviceWorker.getRegistration();
  return (await registration?.pushManager.getSubscription()) ?? null;
}

/** A assinatura como a API a recebe. */
export interface DeviceSubscription {
  endpoint: string;
  p256dh: string;
  auth: string;
}

/** Pede permissão (se ainda não respondida) e assina este aparelho com a chave da API. */
export async function subscribeDevice(publicKey: string): Promise<DeviceSubscription> {
  const permission =
    Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
  if (permission !== 'granted') throw new Error('Permissão de avisos negada no navegador');
  const registration = await ensureServiceWorker();
  const existing = await registration.pushManager.getSubscription();
  // Assinatura de uma chave antiga não serve e ainda atrapalha a nova: desfaz e assina de novo.
  if (existing && !sameServerKey(existing.options?.applicationServerKey, publicKey)) {
    await existing.unsubscribe().catch(() => undefined);
  }
  const subscription =
    existing && sameServerKey(existing.options?.applicationServerKey, publicKey)
      ? existing
      : await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(publicKey),
        });
  const json = subscription.toJSON();
  const keys = json.keys ?? {};
  if (!json.endpoint || !keys.p256dh || !keys.auth) {
    throw new Error('O navegador não devolveu a assinatura completa');
  }
  rememberDeviceEndpoint(json.endpoint);
  return { endpoint: json.endpoint, p256dh: keys.p256dh, auth: keys.auth };
}
