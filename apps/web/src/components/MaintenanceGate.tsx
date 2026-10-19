import { ServerCrash, Wrench } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { api, MAINTENANCE_EVENT, OUTAGE_EVENT } from '../lib/api';
import { useAuth } from '../lib/auth';
import { usePublicSettings } from '../lib/hooks';
import { Button } from './ui';

const RETRY_MS = 30_000;

/** Por que o app saiu do ar: manutenção ligada no painel (ADR 33) ou API/web sem responder (RNF-010). */
export type DownKind = 'maintenance' | 'outage';

/**
 * "hoje às 15:40", "amanhã às 01:10" ou "20/10 às 09:00", no horário de quem vê. Nulo quando não
 * há previsão ou ela já passou (a manutenção atrasou): aí vale o "Voltamos em instantes".
 */
export function returnForecast(iso: string | null | undefined, now = new Date()): string | null {
  if (!iso) return null;
  const at = new Date(iso);
  if (!Number.isFinite(at.getTime()) || at.getTime() <= now.getTime()) return null;
  const time = at.toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
  const day = (d: Date): string => d.toDateString();
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (day(at) === day(now)) return `hoje às ${time}`;
  if (day(at) === day(tomorrow)) return `amanhã às ${time}`;
  return `${at.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' })} às ${time}`;
}

/** Tela cheia enquanto a API está em manutenção ou fora do ar; tenta de novo sozinha e a pedido. */
export function MaintenanceView({
  onRetry,
  busy,
  kind = 'maintenance',
  returnAt,
}: {
  onRetry: () => void;
  busy: boolean;
  kind?: DownKind;
  /** Hora prevista da volta, do painel (RNF-010); só vale na manutenção. */
  returnAt?: string | null;
}) {
  const outage = kind === 'outage';
  const forecast = outage ? null : returnForecast(returnAt);
  return (
    <div className="maintenance-view" role="alert" data-testid="maintenance-view">
      <div className="maintenance-card">
        <span className="maintenance-ico">
          {outage ? <ServerCrash size={28} /> : <Wrench size={28} />}
        </span>
        <h1>{outage ? 'O Escambo está fora do ar' : 'Estamos em manutenção'}</h1>
        <p className="muted">
          {outage
            ? 'Já estamos cuidando disso.'
            : forecast
              ? `Previsão de volta: ${forecast}.`
              : 'Voltamos em instantes.'}{' '}
          Suas contratações, saldo e mensagens continuam guardados; nada se perde enquanto isso.
        </p>
        {outage && <p className="muted">Esta tela tenta de novo sozinha a cada 30 segundos.</p>}
        <Button onClick={onRetry} disabled={busy}>
          {busy ? 'Verificando…' : 'Tentar de novo'}
        </Button>
      </div>
    </div>
  );
}

/**
 * Ouve o 503 do client HTTP e troca o app pela tela de manutenção até a API voltar. Admin
 * não é bloqueado pela manutenção, então em vez da tela vê uma faixa lembrando de desligar.
 * Fora do ar (o proxy não alcançou a API) vale para todo mundo, admin inclusive.
 */
export function MaintenanceGate({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const settings = usePublicSettings();
  const [down, setDown] = useState<DownKind | null>(null);
  const [busy, setBusy] = useState(false);
  const [returnAt, setReturnAt] = useState<string | null>(null);

  useEffect(() => {
    // O 503 de manutenção traz a previsão de volta, quando há (RNF-010).
    const onMaintenance = (event: Event): void => {
      setDown('maintenance');
      const detail = (event as CustomEvent<{ returnAt?: unknown } | undefined>).detail;
      if (typeof detail?.returnAt === 'string') setReturnAt(detail.returnAt);
    };
    const onOutage = (): void => setDown('outage');
    window.addEventListener(MAINTENANCE_EVENT, onMaintenance);
    window.addEventListener(OUTAGE_EVENT, onOutage);
    return () => {
      window.removeEventListener(MAINTENANCE_EVENT, onMaintenance);
      window.removeEventListener(OUTAGE_EVENT, onOutage);
    };
  }, []);

  async function retry(): Promise<void> {
    setBusy(true);
    try {
      const s = await api.publicSettings();
      // A API respondeu: se ainda está em manutenção, a tela passa a dizer isso.
      if (s.maintenanceMode) {
        setDown('maintenance');
        setReturnAt(s.maintenanceReturnAt);
      } else {
        setDown(null);
        void settings.refetch();
      }
    } catch {
      /* segue fora do ar */
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!down) return;
    const t = setInterval(() => void retry(), RETRY_MS);
    return () => clearInterval(t);
  }, [down]);

  if (down === 'outage' || (down === 'maintenance' && user?.role !== 'admin'))
    return (
      <MaintenanceView
        onRetry={() => void retry()}
        busy={busy}
        kind={down}
        returnAt={returnAt ?? settings.data?.maintenanceReturnAt}
      />
    );
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
