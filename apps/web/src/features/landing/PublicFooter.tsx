import { ArrowLeftRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import type { Category } from '@escambo/types';
import type { SectionLink } from './PublicHeader';

const REPO = 'https://github.com/Guirenzo/Escambo';

/**
 * Rodapé das páginas públicas, por assunto: produto (as âncoras da página), categorias (a busca do
 * app já filtrada), conta e documentos. Sem `<nav>`: os links repetem o que já está no topo e no
 * corpo da página.
 */
export function PublicFooter({
  sections = [],
  categories = [],
}: {
  sections?: SectionLink[];
  categories?: Category[];
}) {
  const year = new Date().getFullYear();
  return (
    <footer className="lp-footer">
      <div className="lp-wrap">
        <div className="lp-footer-grid">
          <div className="lp-footer-brand">
            <Link to="/" className="brand lp-brand">
              <span className="brand-mark">
                <ArrowLeftRight size={18} strokeWidth={2.5} />
              </span>
              <span className="brand-name">Escambo</span>
            </Link>
            <p>
              Marketplace de freelancers: contrate com o pagamento protegido ou troque serviço por
              serviço.
            </p>
            <p className="lp-footer-sign">Troque. Contrate. Evolua.</p>
          </div>
          {sections.length > 0 && (
            <div className="lp-footer-col">
              <h2>Produto</h2>
              <ul>
                <li>
                  <a href="#vitrine">Serviços</a>
                </li>
                {sections.map((s) => (
                  <li key={s.href}>
                    <a href={s.href}>{s.label}</a>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {categories.length > 0 && (
            <div className="lp-footer-col">
              <h2>Categorias</h2>
              <ul>
                {categories.map((c) => (
                  <li key={c.id}>
                    <Link to={`/servicos?categoria=${c.id}`}>{c.name}</Link>
                  </li>
                ))}
              </ul>
            </div>
          )}
          <div className="lp-footer-col">
            <h2>Conta</h2>
            <ul>
              <li>
                <Link to="/login">Entrar</Link>
              </li>
              <li>
                <Link to="/cadastro">Criar conta</Link>
              </li>
              <li>
                <Link to="/esqueci-senha">Esqueci minha senha</Link>
              </li>
            </ul>
          </div>
          <div className="lp-footer-col">
            <h2>Documentos</h2>
            <ul>
              <li>
                <Link to="/termos">Termos de Uso</Link>
              </li>
              <li>
                <Link to="/privacidade">Política de Privacidade</Link>
              </li>
              <li>
                <a href={REPO}>Código-fonte no GitHub</a>
              </li>
            </ul>
          </div>
        </div>
        <div className="lp-footer-base">
          <p>Projeto acadêmico (TCC) · PAC Extensionista VII e VIII · Católica SC</p>
          <p>© {year} Escambo</p>
        </div>
      </div>
    </footer>
  );
}
