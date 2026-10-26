import { AlertTriangle, ChevronRight, Inbox, LoaderCircle, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  KeyboardEvent as ReactKeyboardEvent,
  ReactNode,
  RefObject,
  SelectHTMLAttributes,
} from 'react';
import { errorMessage } from '../../lib/errors';
import { BrandMark } from '../BrandMark';

/* Kit de componentes base — consistência visual em cima do sistema de design (styles.css). */

type Variant = 'primary' | 'secondary' | 'ghost' | 'mini' | 'danger';

/**
 * Botão do sistema: primário (sem classe), secundário, fantasma, mini e perigo; tamanho sm (36 px)
 * ou lg (48 px). Carregando, fica desabilitado, avisa o leitor de tela (aria-busy) e mostra o giro.
 */
export function Button({
  variant = 'primary',
  size,
  loading = false,
  className = '',
  disabled,
  children,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: Variant;
  size?: 'sm' | 'lg';
  loading?: boolean;
}) {
  const cls = [variant === 'primary' ? '' : variant, size ?? '', className]
    .filter(Boolean)
    .join(' ');
  return (
    <button
      className={cls || undefined}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...props}
    >
      {loading && <LoaderCircle size={16} className="btn-spin" aria-hidden="true" />}
      {children}
    </button>
  );
}

/**
 * Cartão: branco, raio 16, borda decorativa. Com título vira uma seção com cabeçalho (título,
 * linha de apoio e ação à direita); `interactive` sobe no hover (parado com movimento reduzido).
 */
export function Card({
  title,
  subtitle,
  action,
  wide = false,
  interactive = false,
  className = '',
  children,
}: {
  title?: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  wide?: boolean;
  interactive?: boolean;
  className?: string;
  children: ReactNode;
}) {
  const withHead = title != null && (subtitle != null || action != null);
  return (
    <section
      className={['card', wide ? 'wide' : '', interactive ? 'interactive' : '', className]
        .filter(Boolean)
        .join(' ')}
    >
      {withHead ? (
        <div className="card-head">
          <div>
            <h3>{title}</h3>
            {subtitle != null && <p className="card-sub">{subtitle}</p>}
          </div>
          {action}
        </div>
      ) : (
        title != null && <h3>{title}</h3>
      )}
      {children}
    </section>
  );
}

/**
 * Indicador (KPI): rótulo, ícone num quadrado de cor suave, número grande e uma legenda pequena;
 * opcionalmente a barra de progresso (com nome para o leitor de tela).
 */
export function Stat({
  Icon,
  label,
  value,
  hint,
  tone,
  progress,
  progressLabel = 'Progresso',
}: {
  Icon: LucideIcon;
  label: ReactNode;
  value: ReactNode;
  hint?: ReactNode;
  tone?: 'amber' | 'blue';
  progress?: number;
  progressLabel?: string;
}) {
  return (
    <div className={tone ? `kpi ${tone}` : 'kpi'}>
      <div className="kpi-top">
        <span className="kpi-label">{label}</span>
        <span className="kpi-ico" aria-hidden="true">
          <Icon size={20} />
        </span>
      </div>
      <strong className="kpi-value">{value}</strong>
      {progress != null && (
        <div
          className="bar"
          role="progressbar"
          aria-label={progressLabel}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(progress)}
        >
          <div className="bar-fill" style={{ width: `${progress}%` }} />
        </div>
      )}
      {hint && <span className="muted tiny">{hint}</span>}
    </div>
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

export interface Crumb {
  label: ReactNode;
  /** Sem endereço, é a página atual (aria-current). */
  to?: string;
}

/**
 * Migalhas: de onde a pessoa veio, com a página atual no fim, sem link. É uma lista com nome, e não
 * um <nav>: dentro do conteúdo, um marco de navegação a mais embaralharia a ordem "menu antes do
 * conteúdo" de quem anda pelos marcos da página.
 */
export function Breadcrumbs({ items }: { items: Crumb[] }) {
  return (
    <div className="breadcrumbs">
      <ol aria-label="Você está em">
        {items.map((c, i) => (
          <li key={i}>
            {i > 0 && <ChevronRight size={14} aria-hidden="true" />}
            {c.to ? <Link to={c.to}>{c.label}</Link> : <span aria-current="page">{c.label}</span>}
          </li>
        ))}
      </ol>
    </div>
  );
}

/**
 * Cabeçalho de página, o mesmo em todas as telas: migalhas (quando ajudam), uma linha de contexto
 * acima do título, o título (h1), a descrição e as ações à direita (quebram para baixo).
 */
export function PageHeader({
  title,
  subtitle,
  action,
  eyebrow,
  breadcrumbs,
  leading,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  action?: ReactNode;
  eyebrow?: ReactNode;
  breadcrumbs?: Crumb[];
  /** Algo antes do texto (o avatar no Início). */
  leading?: ReactNode;
}) {
  return (
    <div className={leading ? 'page-head has-leading' : 'page-head'}>
      {leading}
      <div className="page-head-text">
        {breadcrumbs && <Breadcrumbs items={breadcrumbs} />}
        {eyebrow && <span className="page-eyebrow">{eyebrow}</span>}
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
        <BrandMark onDark size={34} />
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

/** Estado vazio: ícone num círculo, título (opcional), a frase do que vai aparecer ali e a ação. */
export function EmptyState({
  children,
  title,
  icon: Icon = Inbox,
  action,
}: {
  children?: ReactNode;
  title?: ReactNode;
  icon?: LucideIcon;
  action?: ReactNode;
}) {
  return (
    <div className="empty">
      <span className="empty-ico" aria-hidden="true">
        <Icon size={26} />
      </span>
      {title && <p className="empty-title">{title}</p>}
      {children && <p className="muted">{children}</p>}
      {action && <div className="empty-action">{action}</div>}
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
  emptyTitle,
  emptyIcon,
  onRetry,
  children,
}: {
  isLoading: boolean;
  error: unknown;
  data: T | undefined;
  isEmpty?: (d: T) => boolean;
  empty?: ReactNode;
  /** Título e ícone do estado vazio (o padrão é a caixa de entrada, sem título). */
  emptyTitle?: ReactNode;
  emptyIcon?: LucideIcon;
  onRetry?: () => void;
  children: (d: T) => ReactNode;
}) {
  if (isLoading) return <Skeleton lines={3} />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (data === undefined) return null;
  if (isEmpty?.(data)) {
    return (
      <EmptyState title={emptyTitle} icon={emptyIcon}>
        {empty ?? 'Nada por aqui ainda.'}
      </EmptyState>
    );
  }
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
