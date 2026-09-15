import { SlidersHorizontal } from 'lucide-react';
import { useEffect, useState } from 'react';
import type { PlatformSetting } from '@escambo/types';
import { Button, Input, QueryState } from '../../components/ui';
import { dtm } from '../../lib/format';
import { useAdminSettings, useUpdateSetting } from '../../lib/hooks';
import { useToast } from '../../lib/toast';

/** Uma linha: valor atual editável dentro dos limites, padrão e quem mudou por último. */
function SettingRow({ setting }: { setting: PlatformSetting }) {
  const update = useUpdateSetting();
  const toast = useToast();
  const [draft, setDraft] = useState(String(setting.value));
  useEffect(() => setDraft(String(setting.value)), [setting.value]);
  const parsed = Number(draft);
  const changed = draft.trim() !== '' && parsed !== setting.value;
  const valid = Number.isInteger(parsed) && parsed >= setting.min && parsed <= setting.max;

  async function save(): Promise<void> {
    try {
      const saved = await update.mutateAsync({ key: setting.key, value: parsed });
      toast.success(`${saved.label}: ${saved.value} ${saved.unit}. Vale a partir de agora.`);
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
          Padrão {setting.defaultValue} {setting.unit} · entre {setting.min} e {setting.max}
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
        <Input
          type="number"
          aria-label={setting.label}
          value={draft}
          min={setting.min}
          max={setting.max}
          step={1}
          onChange={(e) => setDraft(e.target.value)}
        />
        <span className="muted tiny">{setting.unit}</span>
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

/** Parâmetros da plataforma (ADR 32): o que a API lê em tempo de execução, editável pelo admin. */
export function SettingsSection() {
  const settings = useAdminSettings();
  return (
    <section className="card wide" aria-labelledby="settings-title" data-testid="settings-card">
      <div className="card-head">
        <h3 id="settings-title">
          <SlidersHorizontal size={16} /> Parâmetros da plataforma
        </h3>
        <span className="muted tiny">efeito imediato · cada mudança fica na auditoria</span>
      </div>
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
    </section>
  );
}
