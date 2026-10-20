import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';

export type ToastKind = 'success' | 'error' | 'info';

interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

interface ToastApi {
  push: (message: string, kind?: ToastKind) => void;
  success: (message: string) => void;
  error: (message: string) => void;
  info: (message: string) => void;
}

const ToastContext = createContext<ToastApi | null>(null);

/** Sucesso e informação saem sozinhos depois disto, contado só enquanto ninguém olha o aviso. */
export const TOAST_AUTO_DISMISS_MS = 6000;
/** Mais que isto na tela, o mais antigo sai: um laço de erros não cobre a página. */
const MAX_TOASTS = 5;

/**
 * Um aviso. Tempo ajustável (WCAG 2.2.1): o de erro fica até a pessoa fechar; os outros saem
 * sozinhos, mas o relógio para com o mouse em cima ou o foco dentro (para ler com calma ou com
 * leitor de tela) e continua de onde parou. Todos têm o botão de fechar.
 */
function ToastItem({ toast, onClose }: { toast: Toast; onClose: (id: number) => void }) {
  const persistent = toast.kind === 'error';
  const [paused, setPaused] = useState(false);
  const remaining = useRef(TOAST_AUTO_DISMISS_MS);
  useEffect(() => {
    if (persistent || paused) return;
    const started = Date.now();
    const timer = setTimeout(() => onClose(toast.id), remaining.current);
    return () => {
      clearTimeout(timer);
      remaining.current -= Date.now() - started;
    };
  }, [persistent, paused, toast.id, onClose]);
  return (
    <div
      className={`toast toast-${toast.kind}`}
      role={persistent ? 'alert' : undefined}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
      onFocus={() => setPaused(true)}
      onBlur={() => setPaused(false)}
    >
      <span className="toast-msg">{toast.message}</span>
      <button
        type="button"
        className="toast-close"
        aria-label="Fechar aviso"
        onClick={() => onClose(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

/** Feedback global não bloqueante (sucesso/erro) — substitui alerts e mensagens soltas. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Toast[]>([]);
  // Cada aviso cuida do próprio relógio (ToastItem): ele morre com o aviso, e um aviso pendente
  // não atualiza estado depois de a árvore sair (troca de tela na raiz, fim de um teste).
  const close = useCallback((id: number) => {
    setItems((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const push = useCallback((message: string, kind: ToastKind = 'info') => {
    const id = Date.now() + Math.random();
    setItems((prev) => [...prev, { id, kind, message }].slice(-MAX_TOASTS));
  }, []);

  const api = useMemo<ToastApi>(
    () => ({
      push,
      success: (m) => push(m, 'success'),
      error: (m) => push(m, 'error'),
      info: (m) => push(m, 'info'),
    }),
    [push],
  );

  return (
    <ToastContext.Provider value={api}>
      {children}
      {/* Avisos assíncronos (WCAG 4.1.3): sucesso e informação entram numa região viva educada,
          que fica sempre na página e é lida quando o leitor termina a frase; o erro entra como
          role="alert", lido na hora. Fora da região educada, para não ser lido duas vezes. */}
      <div className="toaster">
        <div className="toast-stack" role="status" aria-live="polite">
          {items
            .filter((t) => t.kind !== 'error')
            .map((t) => (
              <ToastItem key={t.id} toast={t} onClose={close} />
            ))}
        </div>
        {items
          .filter((t) => t.kind === 'error')
          .map((t) => (
            <ToastItem key={t.id} toast={t} onClose={close} />
          ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast(): ToastApi {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error('useToast deve ser usado dentro de <ToastProvider>');
  return ctx;
}
