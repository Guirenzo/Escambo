import { describe, expect, it } from 'vitest';
import {
  buildPayload,
  passCategoryFor,
  PUSHED_NOTIFICATION_TYPES,
  pushService,
  pushUrl,
  QUIET_PASS_BY_TYPE,
  trimBody,
} from './push.service';
import { isPushEndpointAllowed } from './push.endpoint';
import { resultForStatus } from './push.provider';

describe('avisos push (ADR 52)', () => {
  it('pushUrl leva para a tela do assunto; contratação manda em qualquer tipo', () => {
    expect(pushUrl('contract_proposal', { contractId: 42 })).toBe('/contratos/42');
    expect(pushUrl('milestone_approved', { contractId: '7' })).toBe('/contratos/7');
    expect(pushUrl('barter_proposed', null)).toBe('/trocas');
    expect(pushUrl('withdrawal_completed', {})).toBe('/carteira');
    expect(pushUrl('deposit_confirmed', undefined)).toBe('/carteira');
    expect(pushUrl('saved_search_match', { searchId: 3 })).toBe('/servicos');
    expect(pushUrl('review_received', null)).toBe('/notificacoes');
  });

  it('trimBody junta espaços e corta com reticência', () => {
    expect(trimBody('  Proposta   nova \n aceita ')).toBe('Proposta nova aceita');
    expect(trimBody(null)).toBe('');
    expect(trimBody('a'.repeat(130))).toBe(`${'a'.repeat(119)}…`);
    expect(trimBody('a'.repeat(120))).toHaveLength(120);
    expect(trimBody('12345 78901', 8)).toBe('12345 7…');
  });

  it('buildPayload monta título, corpo, destino e a etiqueta que substitui o aviso anterior', () => {
    expect(
      buildPayload({
        type: 'contract_delivered',
        title: 'Entrega registrada',
        body: '  A entrega do contrato chegou  ',
        data: { contractId: 9 },
      }),
    ).toEqual({
      title: 'Entrega registrada',
      body: 'A entrega do contrato chegou',
      url: '/contratos/9',
      tag: 'contract_delivered:9',
    });
    // A disputa é o assunto quando não há contrato no aviso.
    expect(
      buildPayload({ type: 'dispute_opened', title: 'Disputa', data: { disputeId: 4 } }).tag,
    ).toBe('dispute_opened:4');
  });

  it('sem assunto, cada aviso fica com etiqueta própria e não apaga o anterior', () => {
    expect(
      buildPayload({ type: 'review_received', title: 'Nova avaliação', notificationId: 31 }),
    ).toEqual({
      title: 'Nova avaliação',
      body: '',
      url: '/notificacoes',
      tag: 'review_received:n31',
    });
    const primeiro = buildPayload({ type: 'review_received', title: 'A', notificationId: 31 });
    const segundo = buildPayload({ type: 'review_received', title: 'B', notificationId: 32 });
    expect(primeiro.tag).not.toBe(segundo.tag);
  });

  it('resposta do serviço de push: assinatura morta some, falha passageira fica', () => {
    expect(resultForStatus(404)).toBe('gone');
    expect(resultForStatus(410)).toBe('gone');
    // Chave VAPID trocada: o serviço recusa a assinatura, que não serve mais.
    expect(resultForStatus(401)).toBe('gone');
    expect(resultForStatus(403)).toBe('gone');
    expect(resultForStatus(429)).toBe('failed');
    expect(resultForStatus(500)).toBe('failed');
    expect(resultForStatus(undefined)).toBe('failed');
  });

  it('endpoint de push: só https de serviço conhecido quando o envio é de verdade', () => {
    const real = (e: string): boolean => isPushEndpointAllowed(e, true);
    expect(real('https://fcm.googleapis.com/fcm/send/abc')).toBe(true);
    expect(real('https://updates.push.services.mozilla.com/wpush/v2/abc')).toBe(true);
    expect(real('https://web.push.apple.com/abc')).toBe(true);
    expect(real('https://sub.notify.windows.com/abc')).toBe(true);
    // A API é quem faz a requisição: endereço interno viraria sonda de rede.
    expect(real('https://localhost/abc')).toBe(false);
    expect(real('https://10.0.0.5/abc')).toBe(false);
    expect(real('http://fcm.googleapis.com/abc')).toBe(false);
    expect(real('https://fcm.googleapis.com.invasor.test/abc')).toBe(false);
    expect(real('nada')).toBe(false);
    // Com o provedor simulado nada sai da máquina: basta ser https e não apontar para um IP.
    expect(isPushEndpointAllowed('https://push.escambo.test/abc', false)).toBe(true);
    expect(isPushEndpointAllowed('https://127.0.0.1/abc', false)).toBe(false);
    expect(isPushEndpointAllowed('https://[::1]/abc', false)).toBe(false);
  });

  it('com o canal desligado não há chave pública: a tela explica em vez de oferecer', () => {
    // vitest.config.ts fixa PUSH_PROVIDER='off' nos testes de unidade.
    expect(pushService.publicKey()).toBe('');
  });

  it('os tipos que batem no aparelho são os mesmos do e-mail, sem o ruído do chat', () => {
    expect(PUSHED_NOTIFICATION_TYPES.has('contract_proposal')).toBe(true);
    expect(PUSHED_NOTIFICATION_TYPES.has('dispute_opened')).toBe(true);
    expect(PUSHED_NOTIFICATION_TYPES.has('message_received')).toBe(false);
  });
});

/** O que pode sair durante o silêncio (ADR 56): todos os tipos classificados, e o par conferido. */
describe('o que sai no silêncio (ADR 56)', () => {
  it('o mapa classifica todos os tipos que viram push, nem um a mais', () => {
    expect(Object.keys(QUIET_PASS_BY_TYPE).sort()).toEqual([...PUSHED_NOTIFICATION_TYPES].sort());
  });

  it('só três tipos podem sair, todos pela categoria de prazo', () => {
    const podem = Object.entries(QUIET_PASS_BY_TYPE).filter(([, c]) => c !== null);
    expect(podem.map(([t]) => t).sort()).toEqual([
      'contract_overdue',
      'contract_revision',
      'deadline_extension_declined',
    ]);
    expect(new Set(podem.map(([, c]) => c))).toEqual(new Set(['deadline']));
  });

  it('passCategoryFor aceita só o par do mapa', () => {
    expect(passCategoryFor('contract_overdue', 'deadline')).toBe('deadline');
    expect(passCategoryFor('contract_proposal', 'deadline')).toBeNull();
    expect(passCategoryFor('message_received', 'deadline')).toBeNull();
    for (const t of ['constructor', 'toString', '__proto__', 'hasOwnProperty']) {
      expect(passCategoryFor(t, 'deadline')).toBeNull();
    }
    expect(passCategoryFor('contract_overdue', null)).toBeNull();
    expect(passCategoryFor('contract_overdue', undefined)).toBeNull();
  });

  it('etiqueta própria: tipo:alvo:nID; sem assunto, tipo:nID; sem a opção, igual a antes', () => {
    const p = { type: 'deadline_extension_declined', title: 't', data: { contractId: 3 } };
    expect(buildPayload({ ...p, notificationId: 41 }, { ownTag: true }).tag).toBe(
      'deadline_extension_declined:3:n41',
    );
    expect(buildPayload({ ...p, notificationId: 42 }, { ownTag: true }).tag).toBe(
      'deadline_extension_declined:3:n42',
    );
    expect(buildPayload({ ...p, notificationId: 41 }).tag).toBe('deadline_extension_declined:3');
    expect(
      buildPayload({ type: 'contract_overdue', title: 't', notificationId: 5 }, { ownTag: true })
        .tag,
    ).toBe('contract_overdue:n5');
  });
});
