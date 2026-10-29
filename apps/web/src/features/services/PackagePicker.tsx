import type { PackageTier, ServicePackage } from '@escambo/types';
import { ArrowRight, Check, Clock, Minus, RefreshCw } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { BusinessButton } from '../../components/BusinessActions';
import { onTablistKeyDown, TableWrap } from '../../components/ui';
import { brl } from '../../lib/format';
import { allFeatures, daysLabel, includes, PACKAGE_TIER_LABEL, revisionsLabel } from './packages';

/**
 * Os pacotes no detalhe do serviço (RF-086), como nos marketplaces: uma aba por nível (com dois ou
 * mais), o painel do nível com preço, prazo, revisões e itens, e "Continuar" abre a proposta já com
 * o nível. As abas seguem o padrão do ARIA (setas, Home e End trocam de aba e a acionam; Tab vai
 * para o painel). Quem não pode contratar (o dono, serviço pausado) vê os pacotes com o aviso no
 * lugar do botão.
 */
export function PackagePicker({
  packages,
  onContinue,
  extra,
  notice,
}: {
  packages: ServicePackage[];
  /** Ausente quando quem vê não pode contratar (dono, pausado). */
  onContinue?: (tier: PackageTier) => void;
  /** Ações a mais embaixo do botão (propor troca). */
  extra?: ReactNode;
  /** O que aparece no lugar do botão quando não dá para contratar. */
  notice?: ReactNode;
}) {
  const base = useId();
  const [active, setActive] = useState<PackageTier>(packages[0]?.tier ?? 'basic');
  const current = packages.find((p) => p.tier === active) ?? packages[0];
  if (!current) return null;
  const tabs = packages.length > 1;

  return (
    <section
      className="card pkg-card"
      aria-labelledby={`${base}-title`}
      data-testid="package-picker"
    >
      <h2 id={`${base}-title`} className="pkg-card-title">
        {tabs ? 'Escolha o pacote' : 'Pacote'}
      </h2>
      {tabs && (
        <div
          className="tabs tabs-mini pkg-tabs"
          role="tablist"
          aria-label="Pacotes"
          onKeyDown={onTablistKeyDown}
        >
          {packages.map((p) => (
            <button
              key={p.tier}
              type="button"
              role="tab"
              id={`${base}-tab-${p.tier}`}
              aria-controls={`${base}-panel-${p.tier}`}
              aria-selected={p.tier === current.tier}
              tabIndex={p.tier === current.tier ? 0 : -1}
              className={p.tier === current.tier ? 'active' : ''}
              onClick={() => setActive(p.tier)}
            >
              {PACKAGE_TIER_LABEL[p.tier]}
            </button>
          ))}
        </div>
      )}
      {packages.map((p) => (
        <div
          key={p.tier}
          className="pkg-panel"
          {...(tabs
            ? {
                role: 'tabpanel',
                id: `${base}-panel-${p.tier}`,
                'aria-labelledby': `${base}-tab-${p.tier}`,
                tabIndex: 0,
              }
            : {})}
          hidden={p.tier !== current.tier}
        >
          <div className="pkg-head">
            <h3>
              <span className="pkg-tier">{PACKAGE_TIER_LABEL[p.tier]}</span>
              <span className="pkg-name">{p.name}</span>
            </h3>
            <strong className="pkg-price">{brl(p.price)}</strong>
          </div>
          {p.description && <p className="pkg-desc">{p.description}</p>}
          <ul className="pkg-facts">
            <li>
              <Clock size={15} aria-hidden="true" /> Entrega em {daysLabel(p.deliveryDays)}
            </li>
            <li>
              <RefreshCw size={15} aria-hidden="true" /> {revisionsLabel(p.revisions)} sem custo
            </li>
          </ul>
          {p.features.length > 0 && (
            <ul
              className="pkg-features"
              aria-label={`O que o ${PACKAGE_TIER_LABEL[p.tier]} inclui`}
            >
              {p.features.map((f) => (
                <li key={f}>
                  <Check size={15} aria-hidden="true" /> {f}
                </li>
              ))}
            </ul>
          )}
          {onContinue && (
            <BusinessButton onClick={() => onContinue(p.tier)} className="pkg-continue">
              Continuar ({brl(p.price)})
              <ArrowRight size={16} aria-hidden="true" />{' '}
              <span className="sr-only">com o pacote {PACKAGE_TIER_LABEL[p.tier]}</span>
            </BusinessButton>
          )}
        </div>
      ))}
      {/* Fora dos painéis: o mesmo para todos os níveis, uma vez só na página. */}
      {onContinue ? extra && <div className="pkg-actions">{extra}</div> : notice}
      {tabs && (
        // Leva o foco à tabela sem mexer na URL (como o SkipLink): a âncora fica para quem abre
        // o link em outra aba.
        <a
          className="pkg-compare-link"
          href="#comparar-pacotes"
          onClick={(e) => {
            const target = document.getElementById('comparar-pacotes');
            if (!target) return;
            e.preventDefault();
            target.focus();
          }}
        >
          Comparar pacotes
        </a>
      )}
    </section>
  );
}

/**
 * "Comparar pacotes": os níveis lado a lado, com preço, prazo, revisões e cada item incluso (✓) ou
 * não (—). É uma tabela de verdade (cabeçalhos de linha e de coluna); na tela estreita ela rola
 * dentro da própria região, que entra no Tab.
 */
export function PackageCompare({
  packages,
  onChoose,
}: {
  packages: ServicePackage[];
  onChoose?: (tier: PackageTier) => void;
}) {
  if (packages.length < 2) return null;
  const features = allFeatures(packages);
  return (
    <section
      className="card pkg-compare-card"
      aria-labelledby="comparar-pacotes"
      data-testid="package-compare"
    >
      {/* Destino do link "Comparar pacotes" (ADR 55): o título recebe o foco, sem anel. */}
      <h2 id="comparar-pacotes" tabIndex={-1} data-hash-target="">
        Comparar pacotes
      </h2>
      <TableWrap label="Tabela de comparação dos pacotes">
        <table className="pkg-compare">
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Item</span>
              </th>
              {packages.map((p) => (
                <th key={p.tier} scope="col">
                  <span className="pkg-tier">{PACKAGE_TIER_LABEL[p.tier]}</span>
                  <span className="pkg-name">{p.name}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr>
              <th scope="row">Preço</th>
              {packages.map((p) => (
                <td key={p.tier} className="pkg-compare-price">
                  {brl(p.price)}
                </td>
              ))}
            </tr>
            <tr>
              <th scope="row">Entrega</th>
              {packages.map((p) => (
                <td key={p.tier}>{daysLabel(p.deliveryDays)}</td>
              ))}
            </tr>
            <tr>
              <th scope="row">Revisões sem custo</th>
              {packages.map((p) => (
                <td key={p.tier}>{p.revisions}</td>
              ))}
            </tr>
            {features.map((f) => (
              <tr key={f}>
                <th scope="row">{f}</th>
                {packages.map((p) =>
                  includes(p, f) ? (
                    <td key={p.tier} className="pkg-yes">
                      <Check size={16} aria-hidden="true" />
                      <span className="sr-only">Incluso</span>
                    </td>
                  ) : (
                    <td key={p.tier} className="pkg-no">
                      <Minus size={16} aria-hidden="true" />
                      <span className="sr-only">Não incluso</span>
                    </td>
                  ),
                )}
              </tr>
            ))}
            {onChoose && (
              <tr className="pkg-compare-actions">
                <td />
                {packages.map((p) => (
                  <td key={p.tier}>
                    <BusinessButton variant="secondary" size="sm" onClick={() => onChoose(p.tier)}>
                      Escolher{' '}
                      <span className="sr-only">o pacote {PACKAGE_TIER_LABEL[p.tier]}</span>
                    </BusinessButton>
                  </td>
                ))}
              </tr>
            )}
          </tbody>
        </table>
      </TableWrap>
    </section>
  );
}
