import type { CompanyRef } from '@escambo/types';
import { Building2 } from 'lucide-react';
import { Link } from 'react-router-dom';

/**
 * Quem contrata é empresa (RF-018): o nome fantasia, que leva à página pública, e o selo "Empresa".
 * Aparece na Sala, nas propostas e nas avaliações que o freelancer vê; pessoa continua sem nome.
 */
export function CompanyTag({ company, label }: { company: CompanyRef; label?: string }) {
  return (
    <span className="company-tag" data-testid="company-tag">
      {/* Os espaços entre as partes são texto: o leitor de tela e o copiar-colar não as grudam. */}
      {label && <span className="muted tiny">{label}</span>}{' '}
      <Link to={`/empresas/${company.ulid}`} className="company-tag-name">
        {company.tradeName}
      </Link>{' '}
      <span className="chip level company-seal">
        <Building2 size={12} aria-hidden="true" /> Empresa
      </span>
    </span>
  );
}
