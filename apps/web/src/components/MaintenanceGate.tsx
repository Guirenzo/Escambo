import { Wrench } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, MAINTENANCE_EVENT } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePublicSettings } from '../lib/hooks';
import { Button } from './ui';

const RETRY_MS = 30_000;

/** Tela cheia enquanto a API responde 503 (ADR 33); tenta de novo sozinha e a pedido. */
export function MaintenanceView({ onRetry, busy }: { onRetry: () => void; busy: boolean }) {
  return (
    <div className="maintenance-view" role="alert" data-testid="maintenance-view">
      <div className="maintenance-card">
        <span className="maintenance-ico">
          <Wrench size={28} />
        </span>
        <h1>Estamos em manutenção</h1>
        <p className="muted">
          Voltamos em instantes. Suas contratações, saldo e mensagens continuam guardados; nada se
          perde enquanto isso.
        </p>
        <Button onClick={onRetry} disabled={busy}>
          {busy ? 'Verificando…' : 'Tentar de novo'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Ouve o 503 do client HTTP e troca o app pela tela de manutenção até a API voltar. Admin
 * não é bloqueado pela API, então em vez da tela vê uma faixa lembrando de desligar.
 */
export function MaintenanceGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const settings = usePublicSettings();
  const [down, setDown] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onMaintenance = (): void => setDown(true);
    window.addEventListener(MAINTENANCE_EVENT, onMaintenance);
    return () => window.removeEventListener(MAINTENANCE_EVENT, onMaintenance);
  }, []);

  async function retry(): Promise<void> {
    setBusy(true);
    try {
      const s = await api.publicSettings();
      if (!s.maintenanceMode) {
        setDown(false);
        void settings.refetch();
      }
    } catch {
      /* segue em manutenção */
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!down) return;
    const t = setInterval(() => void retry(), RETRY_MS);
    return () => clearInterval(t);
  }, [down]);

  if (down && user?.role !== 'admin')
    return <MaintenanceView onRetry={() => void retry()} busy={busy} />;
  return (
    <>
      {settings.data?.maintenanceMode && user?.role === 'admin' && (
        <div className="maintenance-banner" role="status" data-testid="maintenance-banner">
          <Wrench size={14} /> Modo de manutenção ligado: só admins acessam. Desligue em
          Administração › Parâmetros da plataforma.
        </div>
      )}
      {children}
    </>
  );
}
