import { Download, LogOut, ShieldCheck, Trash2 } from 'lucide-react';
import { useState } from 'react';
import { Button, QueryState } from '../../components/ui';
import { DELETION_STATUS_LABEL, dt, dtm, EXPORT_STATUS_LABEL } from '../../lib/format';
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

const exportPill = (status: string): string =>
  status === 'ready' || status === 'downloaded'
    ? 'status-completed'
    : status === 'expired' || status === 'failed'
      ? 'status-cancelled'
      : 'status-pending';

const deletionPill = (status: string): string =>
  status === 'completed'
    ? 'status-completed'
    : status === 'rejected'
      ? 'status-cancelled'
      : 'status-pending';

/** Direitos do titular (LGPD): cópia dos meus dados (download) e exclusão da conta. */
export function PrivacidadeCard() {
  const toast = useToast();
  const { logout } = useAuth();
  const exports = useExportRequests();
  const consents = useConsents();
  const deletions = useDeletionRequests();
  const requestExport = useRequestExport();
  const requestDeletion = useRequestDeletion();
  const [downloading, setDownloading] = useState<number | null>(null);

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

  async function onExport(): Promise<void> {
    try {
      const r = await requestExport.mutateAsync();
      toast.success(
        r.status === 'ready'
          ? 'Sua cópia de dados está pronta para download.'
          : 'Exportação solicitada. Você será avisado quando o arquivo estiver pronto.',
      );
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao solicitar exportação');
    }
  }

  /** Baixa com o token (a rota é autenticada) e dispara o download no navegador. */
  async function onDownload(id: number): Promise<void> {
    setDownloading(id);
    try {
      const { blob, fileName } = await api.downloadExport(id);
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = fileName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      void exports.refetch();
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Erro ao baixar');
    } finally {
      setDownloading(null);
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
        Você pode baixar uma cópia de tudo que o Escambo guarda sobre você (JSON, disponível por 7
        dias) e pedir a exclusão da conta. As solicitações ficam registradas aqui com o status.
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
            <Download size={14} />{' '}
            {requestExport.isPending ? 'Gerando…' : 'Solicitar exportação dos meus dados'}
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
                    <span>
                      Exportação · {dtm(r.createdAt)}
                      {r.expiresAt && r.downloadUrl ? (
                        <span className="muted tiny"> · válida até {dt(r.expiresAt)}</span>
                      ) : null}
                    </span>
                    <span className="acts">
                      <span className={`pill ${exportPill(r.status)}`}>
                        {EXPORT_STATUS_LABEL[r.status] ?? r.status}
                      </span>
                      {r.downloadUrl && (
                        <Button
                          variant="mini"
                          onClick={() => void onDownload(r.id)}
                          disabled={downloading === r.id}
                        >
                          <Download size={12} /> {downloading === r.id ? 'Baixando…' : 'Baixar'}
                        </Button>
                      )}
                    </span>
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
                    <span>
                      Exclusão · {dtm(r.createdAt)}
                      {r.status === 'rejected' && r.adminNote ? (
                        <span className="muted tiny"> · {r.adminNote}</span>
                      ) : null}
                    </span>
                    <span className={`pill ${deletionPill(r.status)}`}>
                      {DELETION_STATUS_LABEL[r.status] ?? r.status}
                    </span>
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
