import { ShieldCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Consent } from '@escambo/types';
import { api } from '../../lib/api';
import { dt } from '../../lib/format';
import { qk } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { LEGAL_UPDATED, LEGAL_VERSIONS } from '../legal/content';
import { answeredVersion, changesSince } from '../legal/version';

/**
 * A Política de Privacidade mudou desde a versão que a pessoa respondeu (ADR 54): a faixa resume
 * o que mudou, leva ao texto completo e registra a resposta — aceite ou recusa — na versão nova,
 * pelo mesmo consentimento do cadastro. As duas respostas encerram a faixa em todos os aparelhos,
 * porque ficam na conta. Erro mantém a faixa: ela volta na próxima vez.
 */
export function LegalUpdateBanner({ consents }: { consents: readonly Consent[] }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const version = LEGAL_VERSIONS.privacidade;
  const changes = changesSince('privacidade', answeredVersion(consents, 'privacidade'));

  async function answer(accepted: boolean): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      await api.recordConsent({ type: 'privacy_policy', version, accepted });
      await qc.invalidateQueries({ queryKey: qk.consents });
      toast.success(
        accepted
          ? `Pronto: a versão ${version} fica registrada nos seus consentimentos, no Perfil.`
          : 'Registrado. Você pode desligar os avisos no navegador e trocar o fuso no Perfil, ou pedir a exclusão da conta lá mesmo.',
      );
    } catch {
      toast.error('Não foi possível registrar agora; a faixa volta na próxima vez.');
      setSaving(false);
    }
  }

  return (
    <div
      className="verify-banner tz-banner"
      role="region"
      aria-label="Atualização da Política de Privacidade"
      data-testid="legal-banner"
    >
      <ShieldCheck size={16} aria-hidden="true" />
      <span>
        A <strong>Política de Privacidade</strong> mudou (versão {version},{' '}
        {dt(LEGAL_UPDATED.privacidade)}):{' '}
        {changes.map((c) => c.summary).join(' Antes disso, na versão anterior: ')}
      </span>
      <span className="tz-actions">
        <a className="link" href="/privacidade#historico" target="_blank" rel="noopener noreferrer">
          Ler a política
        </a>
        <button type="button" className="link" disabled={saving} onClick={() => void answer(true)}>
          Li e aceito
        </button>
        <button type="button" className="link" disabled={saving} onClick={() => void answer(false)}>
          Não aceito
        </button>
      </span>
    </div>
  );
}
