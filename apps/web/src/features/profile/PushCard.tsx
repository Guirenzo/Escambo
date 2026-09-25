import { BellRing, MoonStar } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import type { QuietHours, QuietPassCategory, UpdateEmailPreferenceRequest } from '@escambo/types';
import { Button } from '../../components/ui';
import { api } from '../../lib/api';
import { useAuth } from '../../lib/auth';
import { DIGEST_HOURS, digestHourLabel } from '../../lib/format';
import {
  currentSubscription,
  hourNowIn,
  inQuietWindow,
  pushStateOf,
  pushSupported,
  rememberDeviceEndpoint,
  subscribeDevice,
  type PushState,
} from '../../lib/push';
import { timezoneLabel } from '../../lib/timezones';
import { useToast } from '../../lib/toast';
import { passPhrase, QUIET_PASS_DEFAULT, QUIET_PASS_ORDER, QUIET_PASS_TEXT } from './quietPass';

/** A janela sugerida ao ligar o "não perturbe": a noite. */
const DEFAULT_QUIET: QuietHours = { start: 22, end: 7 };

const plural = (n: number, one: string, many: string): string => (n === 1 ? one : many);

/**
 * Avisos no navegador (ADR 52): ligar vale só para este aparelho, porque a assinatura é dele.
 * A conta pode ter vários. Sem suporte ou com a permissão negada, o cartão explica em vez de
 * oferecer um botão que não funciona.
 */
export function PushCard() {
  const toast = useToast();
  const { user, refreshUser } = useAuth();
  const [state, setState] = useState<PushState>('off');
  const [devices, setDevices] = useState(0);
  const [held, setHeld] = useState(0);
  const [busy, setBusy] = useState(false);
  const [savingQuiet, setSavingQuiet] = useState(false);
  /** Só quem entrega trabalho vê a escolha do que sai no silêncio (ADR 56). */
  const [deliversWork, setDeliversWork] = useState(false);
  const quiet = user?.quietHours ?? null;
  /** O que sai mesmo no silêncio; null = nunca escolheu, que vale como nada (ADR 56). */
  const pass = user?.quietPass ?? null;
  const passOn = pass ?? [];
  const zone = user?.timezone ?? 'America/Sao_Paulo';
  const quietNow = inQuietWindow(hourNowIn(zone), quiet);

  const refresh = useCallback(async (): Promise<void> => {
    const supported = pushSupported();
    const subscription = supported ? await currentSubscription() : null;
    // Falha na consulta não é o mesmo que canal desligado: com publicKey nulo, o cartão segue
    // oferecendo ligar (e o erro aparece na hora de ligar, dizendo a verdade).
    const status = await api.pushStatus(subscription?.endpoint).catch(() => ({
      devices: 0,
      publicKey: null,
      subscribed: false,
      held: 0,
      deliversWork: false,
    }));
    setDevices(status.devices);
    setHeld(status.held);
    setDeliversWork(status.deliversWork);
    // "Ligado" é a assinatura deste navegador registrada nesta conta: um aparelho emprestado pode
    // ter a assinatura de outra pessoa, e aí o certo é oferecer ligar, não desligar. Sem chave
    // pública, o canal está desligado no servidor.
    setState(
      pushStateOf(
        supported,
        supported ? Notification.permission : 'default',
        subscription !== null && status.subscribed,
        status.publicKey !== '',
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

  /**
   * "Não perturbe" (ADR 54) e o que sai durante ele (ADR 56): grava a parte que mudou, como o
   * cartão de e-mails grava, e relê a sessão.
   */
  async function savePush(
    build:
      | { change: UpdateEmailPreferenceRequest; done: string }
      | (() => Promise<{ change: UpdateEmailPreferenceRequest; done: string }>),
    fail: string,
  ): Promise<void> {
    if (savingQuiet) return;
    setSavingQuiet(true);
    try {
      const { change, done } = typeof build === 'function' ? await build() : build;
      await api.updateEmailPreference(change);
      await refreshUser();
      await refresh();
      toast.success(done);
    } catch (er) {
      toast.error(er instanceof Error ? er.message : fail);
    } finally {
      setSavingQuiet(false);
    }
  }

  const range = (w: QuietHours): string =>
    `das ${digestHourLabel(w.start)} às ${digestHourLabel(w.end)}`;

  function toggleQuiet(on: boolean): void {
    if (on === (quiet !== null)) return;
    if (!on) {
      void savePush(
        { change: { quietHours: null }, done: 'Pronto: os avisos voltam a bater a qualquer hora.' },
        'Não foi possível salvar o silêncio',
      );
      return;
    }
    // Quem entrega trabalho e nunca escolheu liga com o prazo vencido marcado (ADR 56): a caixa
    // aparece marcada logo abaixo, e a mensagem diz isso. Escolha já feita não é trocada — lida do
    // que está gravado, não da sessão deste aparelho, que pode ser de antes de uma escolha feita em
    // outro.
    void savePush(async () => {
      const saved = deliversWork ? (await api.emailPreference()).quietPass : pass;
      const applyDefault = deliversWork && saved === null;
      const next = applyDefault ? QUIET_PASS_DEFAULT : (saved ?? []);
      const p = deliversWork ? passPhrase(next) : null;
      return {
        change: {
          quietHours: DEFAULT_QUIET,
          ...(applyDefault ? { quietPass: [...QUIET_PASS_DEFAULT] } : {}),
        },
        done: `Pronto: silêncio ${range(DEFAULT_QUIET)}, horário de ${timezoneLabel(zone)}. Ao fim chega um aviso só com o que ficou por ver${p ? `; ${p} (dá para desmarcar logo abaixo)` : ''}.`,
      };
    }, 'Não foi possível salvar o silêncio');
  }

  function chooseQuiet(part: 'start' | 'end', hour: number): void {
    if (!quiet || quiet[part] === hour) return;
    const next = { ...quiet, [part]: hour };
    void savePush(
      {
        change: { quietHours: next },
        done: `Pronto: silêncio ${range(next)}, horário de ${timezoneLabel(zone)}.`,
      },
      'Não foi possível salvar o silêncio',
    );
  }

  /** Marca ou desmarca uma categoria do que sai no silêncio (ADR 56); grava o conjunto inteiro. */
  function choosePass(c: QuietPassCategory, on: boolean): void {
    if (!quiet || passOn.includes(c) === on) return;
    const next = QUIET_PASS_ORDER.filter((x) => (x === c ? on : passOn.includes(x)));
    void savePush(
      {
        change: { quietPass: next },
        done: on ? QUIET_PASS_TEXT[c].on : QUIET_PASS_TEXT[c].off(digestHourLabel(quiet.end)),
      },
      'Não foi possível salvar o que sai no silêncio',
    );
  }

  // Sem aparelho e sem janela não há o que silenciar; com janela gravada por outro aparelho, o
  // bloco aparece para poder desligar — inclusive num navegador sem suporte a push.
  const showQuiet = state !== 'server-off' && (devices > 0 || quiet !== null);
  const showPass = quiet !== null && deliversWork;
  const heldLabel = `${held} ${plural(held, 'aviso', 'avisos')}`;
  const quietStatus = !quiet
    ? null
    : quietNow
      ? `silêncio até as ${digestHourLabel(quiet.end)}${held > 0 ? ` · ${heldLabel} ${plural(held, 'guardado', 'guardados')}` : ''}`
      : held > 0
        ? `${heldLabel} ${plural(held, 'sai', 'saem')} em instantes`
        : null;

  return (
    <section className="card wide" aria-labelledby="push-title" data-testid="push-card">
      <div className="card-head">
        <h3 id="push-title">
          <BellRing size={16} /> Avisos no navegador
        </h3>
        {state !== 'server-off' && (
          <span className="muted tiny" data-testid="push-devices">
            {devices} aparelho{devices === 1 ? '' : 's'} ligado{devices === 1 ? '' : 's'}
            {quietStatus && (
              <>
                {' · '}
                <span data-testid="push-quiet-now">{quietStatus}</span>
              </>
            )}
          </span>
        )}
      </div>

      {state === 'server-off' && (
        <p className="muted tiny">
          Os avisos no navegador estão desligados neste servidor. As notificações aqui dentro e os
          e-mails continuam funcionando normalmente.
        </p>
      )}
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
            entram, para não virar barulho. Os avisos passam pelo serviço de push do seu navegador
            (Google, Mozilla, Microsoft ou Apple), fora do Brasil, que recebe o endereço deste
            aparelho e o aviso cifrado, com a hora, o tamanho, o prazo de guarda e a prioridade de
            entrega de cada um. Ligar é autorizar isso para este aparelho; desligar apaga a
            assinatura na hora.
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

      {showQuiet && (
        <fieldset className="push-quiet" data-testid="push-quiet">
          <legend>
            <MoonStar size={14} aria-hidden="true" /> Não perturbe
          </legend>
          <label className="push-quiet-toggle">
            <input
              type="checkbox"
              checked={quiet !== null}
              disabled={savingQuiet}
              aria-describedby="push-quiet-hint"
              onChange={(e) => toggleQuiet(e.target.checked)}
            />
            <span>Silenciar os avisos num horário</span>
          </label>
          {quiet && (
            <div className="push-quiet-range">
              <span>Das</span>
              <select
                aria-label="Início do silêncio"
                aria-describedby="push-quiet-hint"
                value={quiet.start}
                disabled={savingQuiet}
                onChange={(e) => chooseQuiet('start', Number(e.target.value))}
              >
                {DIGEST_HOURS.filter((h) => h !== quiet.end).map((h) => (
                  <option key={h} value={h}>
                    {digestHourLabel(h)}
                  </option>
                ))}
              </select>
              <span>às</span>
              <select
                aria-label="Fim do silêncio"
                aria-describedby="push-quiet-hint"
                value={quiet.end}
                disabled={savingQuiet}
                onChange={(e) => chooseQuiet('end', Number(e.target.value))}
              >
                {DIGEST_HOURS.filter((h) => h !== quiet.start).map((h) => (
                  <option key={h} value={h}>
                    {digestHourLabel(h)}
                  </option>
                ))}
              </select>
              {quiet.start > quiet.end && <span className="muted tiny">(do dia seguinte)</span>}
            </div>
          )}
          <span id="push-quiet-hint" className="muted tiny">
            {quiet
              ? `Horário de ${timezoneLabel(zone)} (o fuso se troca no cartão E-mails do Escambo). ${range(quiet).replace(/^das/, 'Das')} os avisos ficam guardados${showPass ? ', menos o que estiver marcado logo abaixo' : ''}; a partir das ${digestHourLabel(quiet.end)} chega um aviso só com o que ficou por ver, com os avisos de prazo primeiro. As notificações aqui dentro e os e-mails não mudam, e o aviso de teste sai na hora. O não perturbe do próprio aparelho vale por cima deste.`
              : 'Escolha um horário em que os avisos ficam guardados. Ao fim dele chega um aviso só com o que ficou por ver; as notificações aqui dentro e os e-mails não mudam.'}
          </span>
          {showPass && (
            <fieldset
              className="push-quiet-pass"
              data-testid="push-quiet-pass"
              disabled={savingQuiet}
            >
              <legend>Mesmo no silêncio, sai na hora</legend>
              {QUIET_PASS_ORDER.map((c) => (
                <div key={c} className="push-quiet-pass-item">
                  <label className="push-quiet-toggle">
                    <input
                      type="checkbox"
                      checked={passOn.includes(c)}
                      aria-describedby={`push-quiet-pass-${c}-hint`}
                      onChange={(e) => choosePass(c, e.target.checked)}
                    />
                    <span>{QUIET_PASS_TEXT[c].label}</span>
                  </label>
                  <span id={`push-quiet-pass-${c}-hint`} className="muted tiny">
                    {QUIET_PASS_TEXT[c].hint}
                  </span>
                </div>
              ))}
            </fieldset>
          )}
        </fieldset>
      )}
    </section>
  );
}
