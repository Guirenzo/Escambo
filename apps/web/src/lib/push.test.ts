import { describe, expect, it } from 'vitest';
import {
  lastDeviceEndpoint,
  pushStateOf,
  rememberDeviceEndpoint,
  sameServerKey,
  urlBase64ToUint8Array,
} from './push';

describe('avisos push no navegador (ADR 52)', () => {
  it('urlBase64ToUint8Array desfaz o base64url, com ou sem preenchimento', () => {
    // 'Escambo' em base64 é 'RXNjYW1ibw=='; em base64url, sem o preenchimento.
    expect([...urlBase64ToUint8Array('RXNjYW1ibw')]).toEqual([69, 115, 99, 97, 109, 98, 111]);
    expect([...urlBase64ToUint8Array('RXNjYW1ibw==')]).toEqual([69, 115, 99, 97, 109, 98, 111]);
    // '-' e '_' voltam a '+' e '/': 0xfb 0xff 0xbf.
    expect([...urlBase64ToUint8Array('-_-_')]).toEqual([251, 255, 191]);
    expect(urlBase64ToUint8Array('')).toHaveLength(0);
  });

  it('pushStateOf: sem suporte, negado, ligado ou desligado neste aparelho', () => {
    expect(pushStateOf(false, 'default', false)).toBe('unsupported');
    expect(pushStateOf(false, 'granted', true)).toBe('unsupported');
    expect(pushStateOf(true, 'denied', false)).toBe('denied');
    // Negado no navegador manda, mesmo com assinatura velha guardada.
    expect(pushStateOf(true, 'denied', true)).toBe('denied');
    expect(pushStateOf(true, 'granted', true)).toBe('on');
    expect(pushStateOf(true, 'granted', false)).toBe('off');
    expect(pushStateOf(true, 'default', false)).toBe('off');
  });

  it('sameServerKey reconhece a assinatura feita com outra chave VAPID', () => {
    const chave = 'RXNjYW1ibw';
    expect(sameServerKey(urlBase64ToUint8Array(chave).buffer, chave)).toBe(true);
    expect(sameServerKey(urlBase64ToUint8Array('-_-_').buffer, chave)).toBe(false);
    // Assinatura sem chave guardada (navegador antigo) conta como diferente: assina de novo.
    expect(sameServerKey(null, chave)).toBe(false);
    expect(sameServerKey(undefined, chave)).toBe(false);
  });

  it('o endpoint do aparelho fica guardado para sair da conta desligar os avisos', () => {
    rememberDeviceEndpoint('https://fcm.googleapis.com/fcm/send/abc');
    expect(lastDeviceEndpoint()).toBe('https://fcm.googleapis.com/fcm/send/abc');
    rememberDeviceEndpoint(null);
    expect(lastDeviceEndpoint()).toBeNull();
  });
});
