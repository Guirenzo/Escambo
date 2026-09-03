import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

/* Kit de componentes base — consistência visual em cima do tema (styles.css). */

type Variant = 'primary' | 'dark' | 'ghost' | 'mini';

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

export function Chip({ kind = 'rank', children }: { kind?: 'rank' | 'level'; children: ReactNode }) {
  return <span className={`chip ${kind}`}>{children}</span>;
}

export function PageHeader({ title, action }: { title: ReactNode; action?: ReactNode }) {
  return (
    <div className="view-head">
      <h2>{title}</h2>
      {action}
    </div>
  );
}

/* Estados padronizados: toda tela usa os mesmos. */

export function Spinner({ label = 'Carregando…' }: { label?: string }) {
  return (
    <p className="muted state" role="status">
      {label}
    </p>
  );
}

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="muted state">{children}</p>;
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Não foi possível carregar.';
  return (
    <div className="state error-state" role="alert">
      <p className="error">{message}</p>
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
  if (isLoading) return <Spinner />;
  if (error) return <ErrorState error={error} onRetry={onRetry} />;
  if (data === undefined) return null;
  if (isEmpty?.(data)) return <EmptyState>{empty ?? 'Nada por aqui ainda.'}</EmptyState>;
  return <>{children(data)}</>;
}
