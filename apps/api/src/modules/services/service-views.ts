import { clock } from '../../utils/clock';

/**
 * Visualizações do serviço (RF-029): o detalhe aberto por quem não é o dono soma uma. O mesmo
 * visitante no mesmo serviço conta uma vez a cada 30 min, para recarregar a página não inflar o
 * número. Visitante é a conta (com login) ou o IP (sem login).
 *
 * A janela fica em memória, sem tabela: a API roda com uma instância (docker-compose.prod.yml). Se
 * reiniciar, ou se um dia houver réplicas (cada uma com a sua janela), o desvio é contar de novo
 * quem voltou dentro dos 30 min, nunca deixar de contar. O IP não vai para o banco nem para o log;
 * sai da memória quando a janela passa.
 */
export const VIEW_WINDOW_MS = 30 * 60_000;
/** Teto de visitantes lembrados: acima dele sai o mais antigo (protege a memória num pico). */
export const MAX_TRACKED_VIEWS = 50_000;

export interface Viewer {
  /** Conta de quem abriu (token válido); ausente = anônimo. */
  userId?: number;
  /** IP de quem abriu (req.ip, respeitando o trust proxy). */
  ip?: string;
}

/** A chave do visitante no serviço: a conta, se tem login; senão o IP. */
export function viewKey(serviceId: number, viewer: Viewer): string {
  return viewer.userId !== undefined
    ? `${serviceId}:u${viewer.userId}`
    : `${serviceId}:ip${viewer.ip ?? '?'}`;
}

export function createViewWindow(
  opts: { windowMs?: number; maxEntries?: number; now?: () => number } = {},
) {
  const windowMs = opts.windowMs ?? VIEW_WINDOW_MS;
  const maxEntries = opts.maxEntries ?? MAX_TRACKED_VIEWS;
  const now = opts.now ?? (() => clock.now().getTime());
  // Chave -> instante em que contou. A Map guarda na ordem de inserção, e cada chave é
  // reinserida quando conta de novo: a mais antiga está sempre na frente.
  const counted = new Map<string, number>();

  return {
    /** Conta esta visita? true registra a visita e abre a janela dela; false = já contou há pouco. */
    shouldCount(key: string): boolean {
      const at = now();
      for (const [k, t] of counted) {
        if (at - t < windowMs) break;
        counted.delete(k);
      }
      const last = counted.get(key);
      if (last !== undefined && at - last < windowMs) return false;
      counted.delete(key);
      counted.set(key, at);
      if (counted.size > maxEntries) counted.delete(counted.keys().next().value!);
      return true;
    },
    /** Quantos visitantes estão dentro da janela agora. */
    size: (): number => counted.size,
    /** Esquece tudo (testes). */
    clear: (): void => counted.clear(),
  };
}

/** A janela da API (uma por processo). */
export const serviceViews = createViewWindow();
