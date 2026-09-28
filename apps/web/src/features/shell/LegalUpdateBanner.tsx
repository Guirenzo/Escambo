import { ShieldCheck } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Consent } from '@escambo/types';
import { api } from '../../lib/api';
import { dayLabel } from '../../lib/format';
import { qk } from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { LEGAL_UPDATED, LEGAL_VERSIONS, type LegalKind } from '../legal/content';
import { answeredVersion, changesSince } from '../legal/version';

/**
 * Um documento legal mudou desde a versão que a pessoa respondeu. A faixa resume o que mudou,
 * leva ao texto completo e registra a resposta na versão nova, pelo mesmo consentimento do
 * cadastro; a resposta fica na conta e encerra a faixa em todos os aparelhos. Erro mantém a faixa:
 * ela volta na próxima vez.
 * - Política de Privacidade (ADR 54): pede aceite ou recusa.
 * - Termos de Uso (ADR 57): informativa. A seção 7 diz que o uso continuado vale como aceite, então
 *   não há "Não aceito": quem não concorda pode pedir a exclusão da conta.
 */
export function LegalUpdateBanner({
  kind,
  consents,
}: {
  kind: LegalKind;
  consents: readonly Consent[];
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const version = LEGAL_VERSIONS[kind];
  const changes = changesSince(kind, answeredVersion(consents, kind));
  const terms = kind === 'termos';

  async function answer(accepted: boolean): Promise<void> {
    if (saving) return;
    setSaving(true);
    try {
      await api.recordConsent({
        type: terms ? 'terms_of_use' : 'privacy_policy',
        version,
        accepted,
      });
      await qc.invalidateQueries({ queryKey: qk.consents });
      toast.success(
        accepted
          ? `Pronto: a versão ${version}${terms ? ' dos Termos' : ''} fica registrada nos seus consentimentos, no Perfil.`
          : 'Registrado. No Perfil você pode desligar os avisos no navegador, escolher o que sai no silêncio e trocar o fuso, ou pedir a exclusão da conta.',
      );
    } catch {
      toast.error('Não foi possível registrar agora; a faixa volta na próxima vez.');
      setSaving(false);
    }
  }

  const summary = changes.map((c) => c.summary).join(' Antes disso, na versão anterior: ');

  return (
    <div
      className="verify-banner tz-banner"
      role="region"
      aria-label={
        terms ? 'Atualização dos Termos de Uso' : 'Atualização da Política de Privacidade'
      }
      data-testid={terms ? 'terms-banner' : 'legal-banner'}
    >
      <ShieldCheck size={16} aria-hidden="true" />
      {terms ? (
        <span>
          Os <strong>Termos de Uso</strong> mudaram (versão {version},{' '}
          {dayLabel(LEGAL_UPDATED.termos)}): {summary} Continuar usando o Escambo vale como aceite
          (seção 7); se não concordar, você pode pedir a exclusão da conta no Perfil.
        </span>
      ) : (
        <span>
          A <strong>Política de Privacidade</strong> mudou (versão {version},{' '}
          {dayLabel(LEGAL_UPDATED.privacidade)}): {summary}
        </span>
      )}
      <span className="tz-actions">
        <a
          className="link"
          href={terms ? '/termos#historico' : '/privacidade#historico'}
          target="_blank"
          rel="noopener noreferrer"
        >
          {terms ? 'Ler os termos' : 'Ler a política'}
        </a>
        <button type="button" className="link" disabled={saving} onClick={() => void answer(true)}>
          Li e aceito
        </button>
        {!terms && (
          <button
            type="button"
            className="link"
            disabled={saving}
            onClick={() => void answer(false)}
          >
            Não aceito
          </button>
        )}
      </span>
    </div>
  );
}
