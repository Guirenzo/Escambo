import { Lock, SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PlatformSetting } from '@escambo/types';
import { Button, Input, QueryState } from '../../components/ui';
import { dtm } from '../../lib/format';
import { useAdminSettings, usePublicSettings, useUpdateSetting } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { SectionHead } from './SectionHead';

const show = (s: PlatformSetting, v: number | boolean): string =>
  s.type === 'boolean' ? (v ? 'ligado' : 'desligado') : `${v} ${s.unit}`.trim();

/** Uma linha: valor atual editável dentro dos limites, padrão e quem mudou por último. */
function SettingRow({ setting }: { setting: PlatformSetting }) {
  const update = useUpdateSetting();
  const toast = useToast();
  const isFlag = setting.type === 'boolean';
  const [draft, setDraft] = useState(String(setting.value));
  const [flag, setFlag] = useState(setting.value === true);
  useEffect(() => {
    setDraft(String(setting.value));
    setFlag(setting.value === true);
  }, [setting.value]);

  const parsed = Number(draft);
  const changed = isFlag ? flag !== setting.value : draft.trim() !== '' && parsed !== setting.value;
  const valid = isFlag
    ? true
    : Number.isFinite(parsed) &&
      parsed >= setting.min &&
      parsed <= setting.max &&
      (setting.type === 'integer'
        ? Number.isInteger(parsed)
        : Math.round(parsed * 100) / 100 === parsed);

  async function save(): Promise<void> {
    try {
      const saved = await update.mutateAsync({ key: setting.key, value: isFlag ? flag : parsed });
      toast.success(`${saved.label}: ${show(saved, saved.value)}. Vale a partir de agora.`);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível salvar');
    }
  }

  return (
    <div className="setting-row" data-testid={`setting-${setting.key}`}>
      <div className="setting-text">
        <strong>{setting.label}</strong>
        <span className="muted tiny">{setting.description}</span>
        <span className="muted tiny">
          Padrão {show(setting, setting.defaultValue)}
          {isFlag ? '' : ` · entre ${setting.min} e ${setting.max}`}
          {setting.updatedAt
            ? ` · alterado ${dtm(setting.updatedAt)}${setting.updatedBy ? ` por ${setting.updatedBy}` : ''}`
            : ''}
        </span>
      </div>
      <form
        className="setting-edit"
        onSubmit={(e) => {
          e.preventDefault();
          if (changed && valid) void save();
        }}
      >
        {isFlag ? (
          <label className="switch">
            <input
              type="checkbox"
              role="switch"
              aria-label={setting.label}
              checked={flag}
              onChange={(e) => setFlag(e.target.checked)}
            />
            <span>{flag ? 'ligado' : 'desligado'}</span>
          </label>
        ) : (
          <>
            <Input
              type="number"
              aria-label={setting.label}
              value={draft}
              min={setting.min}
              max={setting.max}
              step={setting.type === 'integer' ? 1 : 0.01}
              onChange={(e) => setDraft(e.target.value)}
            />
            <span className="muted tiny">{setting.unit}</span>
          </>
        )}
        <Button
          type="submit"
          variant="secondary"
          className="mini"
          disabled={!changed || !valid || update.isPending}
        >
          {update.isPending ? 'Salvando…' : 'Salvar'}
        </Button>
      </form>
    </div>
  );
}

/** Parâmetros da plataforma (ADR 32/33): o que a API lê em tempo de execução, editável pelo admin. */
export function SettingsSection() {
  const settings = useAdminSettings();
  const publicSettings = usePublicSettings();
  const rules = publicSettings.data?.fixedContractRules;
  return (
    <section className="card wide" aria-labelledby="settings-title" data-testid="settings-card">
      <SectionHead
        icon={SlidersHorizontal}
        tone="violet"
        title="Parâmetros da plataforma"
        titleId="settings-title"
        subtitle="O que a API lê em tempo de execução: efeito imediato · cada mudança fica na auditoria"
      />
      <QueryState
        isLoading={settings.isLoading}
        error={settings.error}
        data={settings.data}
        onRetry={() => void settings.refetch()}
      >
        {(items) => (
          <div className="settings-list">
            {items.map((s) => (
              <SettingRow key={s.key} setting={s} />
            ))}
          </div>
        )}
      </QueryState>
      <div className="stack fixed-rules" data-testid="fixed-contract-rules">
        <h4>
          <Lock size={16} aria-hidden="true" /> Regras fixas das contratações
        </h4>
        <p className="muted tiny">
          Somente leitura. Alterar estas regras exige uma atualização do sistema e uma nova versão
          dos documentos legais.
        </p>
        {rules ? (
          <ul>
            <li>
              {rules.includedRevisions} revisões sem custo por entrega ou marco. O freelancer pode
              liberar mais uma; contratações antigas mantêm o limite combinado.
            </li>
            <li>
              Até {rules.maxOffers} ofertas na negociação ({Math.ceil(rules.maxOffers / 2)}{' '}
              rodadas).
            </li>
            <li>
              Disputa manual após {rules.disputeWaitHours} horas da primeira entrega ou, sem
              entrega, do aceite. A espera termina pelo menos {rules.disputeTacitMarginHours} horas
              antes da aprovação tácita. A disputa automática por atraso segue a carência própria.
            </li>
            <li>
              Desistências do freelancer contam por {rules.dropoutWindowDays} dias;{' '}
              {rules.dropoutAlertAt} abrem revisão humana da conta. O cliente pode confirmar um
              encerramento de comum acordo em até {rules.dropoutAgreementDays} dias.
            </li>
          </ul>
        ) : publicSettings.error ? (
          <p className="muted tiny">
            Não foi possível consultar as regras fixas.{' '}
            <Button type="button" variant="mini" onClick={() => void publicSettings.refetch()}>
              Consultar regras novamente
            </Button>
          </p>
        ) : (
          <p className="muted tiny">
            {publicSettings.isLoading
              ? 'Consultando regras fixas…'
              : 'As regras fixas não estão disponíveis nesta versão da API.'}
          </p>
        )}
      </div>
    </section>
  );
}
