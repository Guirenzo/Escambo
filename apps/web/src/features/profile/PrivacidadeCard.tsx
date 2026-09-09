import { Download, LogOut, ShieldCheck, Trash2 } from 'lucide-react';
import { Button, QueryState } from '../../components/ui';
import { dtm } from '../../lib/format';
import {
  useConsents,
  useDeletionRequests,
  useExportRequests,
  useRequestDeletion,
  useRequestExport,
} from '../../lib/hooks';
import { useToast } from '../../lib/toast';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';

const CONSENT_LABEL: Record<string, string> = {
  terms_of_use: 'Termos de Uso',
  privacy_policy: 'Política de Privacidade',
  marketing: 'Comunicações de marketing',
  data_processing: 'Tratamento de dados',
};

const STATUS: Record<string, string> = {
  pending: 'pendente',
  processing: 'em processamento',
  completed: 'concluída',
  done: 'concluída',
  rejected: 'recusada',
  cancelled: 'cancelada',
};

/** Direitos do titular (LGPD): exportar meus dados e pedir a exclusão da conta. */
export function PrivacidadeCard() {
  const toast = useToast();
  const { logout } = useAuth();
  const exports = useExportRequests();
  const consents = useConsents();

  /** Revoga todas as sessões (RN-008) e sai daqui também. */
  async function logoutEverywhere(): Promise<void> {
    if (!window.confirm('Sair de todos os dispositivos? Você precisará entrar de novo em cada um.'))
      return;
    try {
      const { revoked } = await api.logoutAll();
      toast.success(`${revoked} sessão(ões) encerrada(s).`);
      logout();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao encerrar sessões');
    }
  }
  const deletions = useDeletionRequests();
  const requestExport = useRequestExport();
  const requestDeletion = useRequestDeletion();

  async function onExport(): Promise<void> {
    try {
      await requestExport.mutateAsync();
      toast.success('Exportação solicitada. Você será avisado quando o arquivo estiver pronto.');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao solicitar exportação');
    }
  }

  async function onDelete(): Promise<void> {
    if (
      !window.confirm(
        'Pedir a exclusão da sua conta e dos seus dados? Isso é analisado pela plataforma e não pode ser desfeito depois de concluído.',
      )
    )
      return;
    try {
      await requestDeletion.mutateAsync(null);
      toast.success('Exclusão solicitada. Você receberá a confirmação por e-mail.');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao solicitar exclusão');
    }
  }

  const pendingDeletion = deletions.data?.some((d) => d.status === 'pending') ?? false;

  return (
    <section className="card wide">
      <div className="card-head">
        <h3>
          <ShieldCheck size={16} /> Privacidade e dados (LGPD)
        </h3>
      </div>
      <p className="muted tiny">
        Você pode pedir uma cópia de tudo que o Escambo guarda sobre você, e pedir a exclusão da
        conta. As solicitações ficam registradas aqui com o status.
      </p>
      {consents.data && consents.data.length > 0 && (
        <ul className="req-list" aria-label="Consentimentos" style={{ marginBottom: 14 }}>
          {consents.data.map((c) => (
            <li key={`${c.type}-${c.version}-${c.at}`}>
              <span>
                {CONSENT_LABEL[c.type] ?? c.type} · v{c.version}
              </span>
              <span className="muted tiny">
                {c.accepted ? 'aceito' : 'recusado'} em {dtm(c.at)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div className="loc-row" style={{ marginBottom: 14 }}>
        <Button variant="ghost" onClick={() => void logoutEverywhere()}>
          <LogOut size={14} /> Sair de todos os dispositivos
        </Button>
        <span className="muted tiny">Encerra todas as sessões abertas, inclusive esta.</span>
      </div>
      <div className="two-col">
        <div className="stack">
          <Button
            variant="secondary"
            onClick={() => void onExport()}
            disabled={requestExport.isPending}
          >
            <Download size={14} /> Solicitar exportação dos meus dados
          </Button>
          <QueryState
            isLoading={exports.isLoading}
            error={exports.error}
            data={exports.data}
            empty="Nenhuma exportação solicitada."
            onRetry={() => void exports.refetch()}
          >
            {(list) => (
              <ul className="req-list" aria-label="Exportações solicitadas">
                {list.map((r) => (
                  <li key={r.id}>
                    <span>Exportação · {dtm(r.createdAt)}</span>
                    <span className="pill">{STATUS[r.status] ?? r.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </div>
        <div className="stack">
          <Button
            variant="danger"
            onClick={() => void onDelete()}
            disabled={requestDeletion.isPending || pendingDeletion}
          >
            <Trash2 size={14} />{' '}
            {pendingDeletion ? 'Exclusão em análise' : 'Solicitar exclusão da conta'}
          </Button>
          <QueryState
            isLoading={deletions.isLoading}
            error={deletions.error}
            data={deletions.data}
            empty="Nenhuma exclusão solicitada."
            onRetry={() => void deletions.refetch()}
          >
            {(list) => (
              <ul className="req-list" aria-label="Exclusões solicitadas">
                {list.map((r) => (
                  <li key={r.id}>
                    <span>Exclusão · {dtm(r.createdAt)}</span>
                    <span className="pill">{STATUS[r.status] ?? r.status}</span>
                  </li>
                ))}
              </ul>
            )}
          </QueryState>
        </div>
      </div>
    </section>
  );
}
