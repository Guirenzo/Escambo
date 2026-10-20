import { AlertTriangle, ArrowLeftRight, Inbox, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
  SelectHTMLAttributes,
} from 'react';
import { errorMessage } from '../../lib/errors';

/* Kit de componentes base — consistência visual em cima do sistema de design (styles.css). */

type Variant = 'primary' | 'secondary' | 'ghost' | 'mini' | 'danger';

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant }) {
  const cls = [variant === 'primary' ? '' : variant, className].filter(Boolean).join(' ');
  return <button className={cls || undefined} {...props} />;
}

export function Card({
  title,
  wide = false,
  className = '',
  children,
}: {
  title?: ReactNode;
  wide?: boolean;
  className?: string;
  children: ReactNode;
}) {
  return (
    <section className={['card', wide ? 'wide' : '', className].filter(Boolean).join(' ')}>
      {title != null && <h3>{title}</h3>}
      {children}
    </section>
  );
}

export function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label>
      {label}
      {children}
    </label>
  );
}

export const Input = (props: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />;
export const Select = (props: SelectHTMLAttributes<HTMLSelectElement>) => <select {...props} />;

export function Pill({ status, children }: { status?: string; children: ReactNode }) {
  return <span className={status ? `pill status-${status}` : 'pill'}>{children}</span>;
}

export function Chip({
  kind = 'rank',
  children,
}: {
  kind?: 'rank' | 'level';
  children: ReactNode;
}) {
  return <span className={`chip ${kind}`}>{children}</span>;
}

/**
 * Contêiner de tabela larga: em tela estreita a tabela rola na horizontal dentro dele. Para quem usa
 * teclado conseguir rolar (WCAG 2.1.1; regra `scrollable-region-focusable` do axe), ele entra no
 * Tab como uma região com nome, e as setas rolam.
 */
export function TableWrap({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="table-wrap" role="region" aria-label={label} tabIndex={0}>
      {children}
    </div>
  );
}

/** Cabeçalho de página: título, subtítulo de contexto e ações à direita. */
export function PageHeader({
  title,
  subtitle,
  action,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
      </div>
      {action && <div className="page-actions">{action}</div>}
    </div>
  );
}

/* Estados padronizados: toda tela usa os mesmos. */

/** Pulso da marca — para telas inteiras (splash/guarda de rota). */
export function Spinner({ label = 'Carregando…' }: { label?: string }) {
  return (
    <div className="pulse" role="status" aria-label={label}>
      <span className="pulse-mark">
        <ArrowLeftRight size={22} strokeWidth={2.5} />
      </span>
      <span className="muted">{label}</span>
    </div>
  );
}

/** Esqueleto com shimmer — para conteúdo que está chegando (listas, cards). */
export function Skeleton({ lines = 3 }: { lines?: number }) {
  return (
    <div className="skeleton-stack" role="status" aria-label="Carregando">
      {Array.from({ length: lines }, (_, i) => (
        <div key={i} className="skeleton" style={{ width: `${100 - i * 12}%` }} />
      ))}
    </div>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <div className="empty">
      <span className="empty-ico">
        <Inbox size={22} />
      </span>
      <p className="muted">{children}</p>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = errorMessage(error, 'Não foi possível carregar.');
  return (
    <div className="state error-state" role="alert">
      <p className="error">
        <AlertTriangle size={16} /> {message}
      </p>
      {onRetry && (
        <Button variant="mini" onClick={onRetry}>
          Tentar de novo
        </Button>
      )}
    </div>
  );
}

/** Renderiza loading/erro/vazio/dados com um único helper — elimina boilerplate nas telas. */
export function QueryState<T>({
  isLoading,
  error,
  data,
  isEmpty,
  empty,
  onRetry,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  data: T | undefined;
  isEmpty?: (d: T) => boolean;
  empty?: ReactNode;
  onRetry?: () => void;
  children: (d: T) => ReactNode;
}) {
  if (isLoading) return <Skeleton lines={3} />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (data === undefined) return null;
  if (isEmpty?.(data)) return <EmptyState>{empty ?? 'Nada por aqui ainda.'}</EmptyState>;
  return <>{children(data)}</>;
}

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * "Pular para o conteúdo" (WCAG 2.4.1): o primeiro Tab da tela. Leva o foco ao alvo (que precisa
 * de tabIndex={-1}) sem mexer na URL: um "#conteudo" no endereço trocaria a âncora que algumas
 * telas usam (ADR 55) e criaria uma entrada no histórico.
 */
export function SkipLink({
  target,
  label = 'Pular para o conteúdo',
}: {
  target: string;
  label?: string;
}) {
  return (
    <a
      className="skip-link"
      href={`#${target}`}
      onClick={(e) => {
        const el = document.getElementById(target);
        if (!el) return;
        e.preventDefault();
        el.focus();
      }}
    >
      {label}
    </a>
  );
}

/**
 * Setas, Home e End entre as abas de um `role="tablist"` (padrão de abas do ARIA, com ativação
 * automática): a aba de destino recebe o foco e é acionada. Tab e Shift+Tab seguem normais.
 */
export function onTablistKeyDown(e: ReactKeyboardEvent<HTMLElement>): void {
  if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(e.key)) return;
  const tabs = Array.from(
    e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]:not([disabled])'),
  );
  const at = tabs.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  e.preventDefault();
  const last = tabs.length - 1;
  const to =
    e.key === 'Home'
      ? 0
      : e.key === 'End'
        ? last
        : (at + (e.key === 'ArrowRight' ? 1 : -1) + tabs.length) % tabs.length;
  const tab = tabs[to]!;
  tab.focus();
  if (to !== at) tab.click();
}

/**
 * Foco de um diálogo modal (WCAG 2.1.2, 2.4.3): ao abrir, o foco vai para o diálogo (o leitor de
 * tela anuncia o título), a menos que algo dentro dele já tenha pedido o foco; o Tab fica dentro
 * dele; Esc fecha; ao fechar, o foco volta para quem abriu, se ele ainda estiver na tela. Quem
 * abriu é lido no primeiro render, antes de um `autoFocus` de dentro do diálogo roubar o foco.
 */
export function useDialogFocus(dialogRef: RefObject<HTMLElement>, onClose: () => void): void {
  const [opener] = useState(() =>
    document.activeElement instanceof HTMLElement && document.activeElement !== document.body
      ? document.activeElement
      : null,
  );
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return undefined;
    if (!dialog.contains(document.activeElement)) dialog.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const list = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (list.length === 0) {
        e.preventDefault();
        return;
      }
      const first = list[0]!;
      const last = list[list.length - 1]!;
      const active = document.activeElement;
      if (!dialog.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (active === first || active === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      if (opener && document.contains(opener)) opener.focus();
    };
  }, [dialogRef, opener]);
}

/** Diálogo modal (fecha no backdrop, no ✕ ou com Esc), com o foco de `useDialogFocus`. */
export function Modal({
  title,
  onClose,
  children,
}: {
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) {
  // O título dá nome ao diálogo para leitores de tela (e para getByRole('dialog', { name })).
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  useDialogFocus(dialogRef, onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={onClose}>
      <div
        ref={dialogRef}
        className="modal card"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="icon-btn" onClick={onClose} aria-label="Fechar">
            <X size={18} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}
