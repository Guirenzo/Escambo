import { ArrowLeftRight } from 'lucide-react';
import { Link } from 'react-router-dom';
import { usePageTitle } from '../../lib/title';
import { dayLabel } from '../../lib/format';
import { LEGAL, LEGAL_CHANGES, LEGAL_UPDATED, LEGAL_VERSIONS, type LegalKind } from './content';

/**
 * Páginas públicas de Termos de Uso e Política de Privacidade (versão gravada no consentimento),
 * com o histórico de versões no fim: é o que a faixa de atualização aponta (ADR 54).
 */
export function LegalView({ kind }: { kind: LegalKind }) {
  const doc = LEGAL[kind];
  usePageTitle(doc.title);
  const other = kind === 'termos' ? 'privacidade' : 'termos';
  const history = LEGAL_CHANGES.filter((c) => c.doc === kind);
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
        Versão {LEGAL_VERSIONS[kind]} · atualizada em {dayLabel(LEGAL_UPDATED[kind])} ·{' '}
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
      <section id="historico" aria-labelledby="historico-title">
        <h2 id="historico-title">Histórico de versões</h2>
        <ul className="legal-history">
          {history.map((c) => (
            <li key={c.version}>
              <strong>
                {c.version} · {dayLabel(c.date)}
              </strong>{' '}
              {c.summary}
            </li>
          ))}
        </ul>
      </section>
      <p className="muted tiny" style={{ marginTop: 32 }}>
        <Link to="/login">Voltar ao início</Link>
      </p>
    </main>
  );
}
