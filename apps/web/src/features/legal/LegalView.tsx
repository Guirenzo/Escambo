import { ArrowLeftRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../../lib/title';
import { LEGAL, LEGAL_UPDATED, LEGAL_VERSION } from './content';

/** Páginas públicas de Termos de Uso e Política de Privacidade (versão gravada no consentimento). */
export function LegalView({ kind }: { kind: 'termos' | 'privacidade' }) {
  const doc = LEGAL[kind];
  usePageTitle(doc.title);
  const other = kind === 'termos' ? 'privacidade' : 'termos';
  return (
    <main className="legal">
      <Link to="/login" className="brand">
        <span className="brand-mark">
          <ArrowLeftRight size={18} strokeWidth={2.5} />
        </span>
        <span className="brand-name">Escambo</span>
      </Link>
      <h1>{doc.title}</h1>
      <p className="muted tiny">
        Versão {LEGAL_VERSION} · atualizada em {LEGAL_UPDATED} ·{' '}
        <Link to={`/${other}`}>{LEGAL[other].title}</Link>
      </p>
      <p className="legal-note">
        Documento da versão de demonstração do Escambo (projeto acadêmico). Antes de operar
        comercialmente, revise com assessoria jurídica.
      </p>
      <p>{doc.intro}</p>
      {doc.sections.map((s) => (
        <section key={s.title}>
          <h2>{s.title}</h2>
          {s.paragraphs.map((p, i) => (
            <p key={i}>{p}</p>
          ))}
        </section>
      ))}
      <p className="muted tiny" style={{ marginTop: 32 }}>
        <Link to="/login">Voltar ao início</Link>
      </p>
    </main>
  );
}
