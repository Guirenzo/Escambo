import { BellRing } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import { api } from '../../lib/api';
import {
  currentSubscription,
  pushStateOf,
  pushSupported,
  rememberDeviceEndpoint,
  subscribeDevice,
  type PushState,
} from '../../lib/push';
import { useToast } from '../../lib/toast';

/**
 * Avisos no navegador (ADR 52): ligar vale só para este aparelho, porque a assinatura é dele.
 * A conta pode ter vários. Sem suporte ou com a permissão negada, o cartão explica em vez de
 * oferecer um botão que não funciona.
 */
export function PushCard() {
  const toast = useToast();
  const [state, setState] = useState<PushState>('off');
  const [devices, setDevices] = useState(0);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(async (): Promise<void> => {
    const supported = pushSupported();
    const subscription = supported ? await currentSubscription() : null;
    const status = await api
      .pushStatus(subscription?.endpoint)
      .catch(() => ({ devices: 0, publicKey: '', subscribed: false }));
    setDevices(status.devices);
    // "Ligado" é a assinatura deste navegador registrada nesta conta: um aparelho emprestado pode
    // ter a assinatura de outra pessoa, e aí o certo é oferecer ligar, não desligar.
    setState(
      pushStateOf(
        supported,
        supported ? Notification.permission : 'default',
        subscription !== null && status.subscribed,
      ),
    );
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function turnOn(): Promise<void> {
    setBusy(true);
    try {
      const { publicKey } = await api.pushStatus();
      if (!publicKey) throw new Error('Os avisos no navegador estão desligados no servidor');
      await api.pushSubscribe(await subscribeDevice(publicKey));
      await refresh();
      toast.success('Pronto: este aparelho vai avisar você.');
    } catch (er) {
      await refresh();
      toast.error(er instanceof Error ? er.message : 'Não foi possível ligar os avisos');
    } finally {
      setBusy(false);
    }
  }

  async function turnOff(): Promise<void> {
    setBusy(true);
    try {
      const sub = await currentSubscription();
      if (sub) {
        // O aparelho para de receber mesmo que o servidor já não conheça a assinatura (404).
        await api.pushUnsubscribe(sub.endpoint).catch(() => undefined);
        await sub.unsubscribe();
      }
      rememberDeviceEndpoint(null);
      await refresh();
      toast.success('Avisos desligados neste aparelho.');
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível desligar');
    } finally {
      setBusy(false);
    }
  }

  async function test(): Promise<void> {
    setBusy(true);
    try {
      const { sent } = await api.pushTest();
      await refresh();
      toast.success(
        sent > 0
          ? `Aviso de teste enviado para ${sent} aparelho${sent === 1 ? '' : 's'}.`
          : 'Nenhum aparelho ligado para receber o teste.',
      );
    } catch (er) {
      toast.error(er instanceof Error ? er.message : 'Não foi possível enviar o teste');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card wide" aria-labelledby="push-title" data-testid="push-card">
      <div className="card-head">
        <h3 id="push-title">
          <BellRing size={16} /> Avisos no navegador
        </h3>
        <span className="muted tiny" data-testid="push-devices">
          {devices} aparelho{devices === 1 ? '' : 's'} ligado{devices === 1 ? '' : 's'}
        </span>
      </div>

      {state === 'unsupported' && (
        <p className="muted tiny">
          Este navegador não recebe avisos do Escambo. Os e-mails e a lista de notificações
          continuam funcionando normalmente.
        </p>
      )}
      {state === 'denied' && (
        <p className="muted tiny">
          Os avisos estão bloqueados para o Escambo nas configurações do navegador. Libere a
          permissão de notificações do site e volte aqui.
        </p>
      )}
      {(state === 'on' || state === 'off') && (
        <>
          <p className="muted tiny">
            Contratações, entregas, disputas e saques chegam neste aparelho, mesmo com a aba
            fechada. Vale só para ele; ligue em cada aparelho que você usa. Conversas do chat não
            entram, para não virar barulho.
          </p>
          <div className="push-actions">
            {state === 'on' ? (
              <>
                <Button variant="secondary" disabled={busy} onClick={() => void turnOff()}>
                  Desligar neste aparelho
                </Button>
                <Button variant="ghost" disabled={busy} onClick={() => void test()}>
                  Enviar aviso de teste
                </Button>
              </>
            ) : (
              <Button variant="secondary" disabled={busy} onClick={() => void turnOn()}>
                Ligar avisos neste aparelho
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
