import { Link } from 'react-router-dom';
import { BrandMark } from '../../components/BrandMark';

export interface SectionLink {
  href: string;
  label: string;
}

/**
 * Cabeçalho das páginas públicas, escuro como o topo: a marca (volta para o início), as âncoras da
 * página (somem no celular, sem menu escondido) e as duas portas de entrada, Entrar e Criar conta.
 */
export function PublicHeader({ sections = [] }: { sections?: SectionLink[] }) {
  return (
    <header className="lp-header">
      <div className="lp-wrap lp-header-inner">
        <Link to="/" className="brand lp-brand">
          <BrandMark onDark />
          <span className="brand-name">Escambo</span>
        </Link>
        {sections.length > 0 && (
          <nav className="lp-nav" aria-label="Seções da página">
            <ul>
              {sections.map((s) => (
                <li key={s.href}>
                  <a href={s.href}>{s.label}</a>
                </li>
              ))}
            </ul>
          </nav>
        )}
        <div className="lp-header-actions">
          <Link to="/login" className="lp-link-quiet">
            Entrar
          </Link>
          <Link to="/cadastro" className="lp-btn lp-btn-amber">
            Criar conta
          </Link>
        </div>
      </div>
    </header>
  );
}
