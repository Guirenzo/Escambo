import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

export type SectionTone = 'green' | 'amber' | 'blue' | 'violet' | 'red';

/**
 * Cabeçalho de seção do painel: o ícone num quadrado de cor suave, o título (h3, só o texto, para o
 * nome do título ser o da seção), a contagem ao lado, uma linha dizendo para que a seção serve e as
 * ações à direita (quebram para baixo quando falta espaço).
 */
export function SectionHead({
  icon: Icon,
  title,
  titleId,
  subtitle,
  badge,
  tone = 'green',
  children,
}: {
  icon: LucideIcon;
  title: ReactNode;
  titleId?: string;
  subtitle?: ReactNode;
  /** Contagem ou situação ao lado do título ("3 pendentes"). */
  badge?: ReactNode;
  tone?: SectionTone;
  /** Ações e filtros da seção. */
  children?: ReactNode;
}) {
  return (
    <div className="card-head adm-head">
      <div className="adm-head-main">
        <span className={`adm-ico ${tone}`} aria-hidden="true">
          <Icon size={20} />
        </span>
        <div className="adm-head-text">
          <div className="adm-head-title">
            <h3 id={titleId}>{title}</h3>
            {badge}
          </div>
          {subtitle && <p className="card-sub">{subtitle}</p>}
        </div>
      </div>
      {children && <div className="adm-head-actions">{children}</div>}
    </div>
  );
}

/** Contagem ao lado do título; `hot` quando há algo esperando a equipe. */
export function CountBadge({ hot = false, children }: { hot?: boolean; children: ReactNode }) {
  return <span className={hot ? 'count-badge hot' : 'count-badge'}>{children}</span>;
}
