import type { ServicePackage } from '@escambo/types';
import { Check } from 'lucide-react';
import { daysLabel, PACKAGE_TIER_LABEL, revisionsLabel } from '../services/packages';

/**
 * O pacote contratado na tabela de valores da Sala (RF-086): o nível e o nome, como estavam
 * publicados na proposta, e o que ele inclui. São duas células da tabela (o rótulo e o valor); sem
 * pacote, nada. Editar o serviço depois não muda o que aparece aqui: é a cópia da contratação.
 */
export function ContractPackageSummary({ pkg }: { pkg: ServicePackage | null | undefined }) {
  if (!pkg) return null;
  return (
    <>
      <span className="muted">Pacote</span>
      <span className="pkg-summary" data-testid="package-kv">
        <strong>
          {PACKAGE_TIER_LABEL[pkg.tier]} — {pkg.name}
        </strong>
        <span className="muted tiny">
          entrega em {daysLabel(pkg.deliveryDays)} · {revisionsLabel(pkg.revisions)} sem custo
        </span>
        {pkg.features.length > 0 && (
          <ul className="pkg-features compact" aria-label="O que o pacote inclui">
            {pkg.features.map((f) => (
              <li key={f}>
                <Check size={14} aria-hidden="true" /> {f}
              </li>
            ))}
          </ul>
        )}
      </span>
    </>
  );
}
