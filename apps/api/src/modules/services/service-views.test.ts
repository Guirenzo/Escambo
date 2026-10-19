import { afterEach, describe, expect, it } from 'vitest';
import { setClockForTests } from '../../utils/clock';
import { createViewWindow, serviceViews, VIEW_WINDOW_MS, viewKey } from './service-views';

/** A janela das visualizações (RF-029): recarregar não conta, voltar depois de 30 min conta. */
describe('janela das visualizações', () => {
  afterEach(() => {
    setClockForTests(null);
    serviceViews.clear();
  });

  it('o visitante é a conta (com login) ou o IP (sem login), sempre junto do serviço', () => {
    expect(viewKey(5, { userId: 7, ip: '10.0.0.1' })).toBe('5:u7');
    expect(viewKey(5, { ip: '10.0.0.1' })).toBe('5:ip10.0.0.1');
    expect(viewKey(6, { ip: '10.0.0.1' })).not.toBe(viewKey(5, { ip: '10.0.0.1' }));
    expect(viewKey(5, {})).toBe('5:ip?');
  });

  it('conta a primeira; recarregar dentro de 30 min não conta; depois dos 30 min conta de novo', () => {
    let now = 1_000_000;
    const views = createViewWindow({ now: () => now });

    expect(views.shouldCount('5:u7')).toBe(true);
    now += VIEW_WINDOW_MS - 1;
    expect(views.shouldCount('5:u7')).toBe(false);
    now += 1;
    expect(views.shouldCount('5:u7')).toBe(true);
    // A janela nova começa na visita que contou.
    now += 60_000;
    expect(views.shouldCount('5:u7')).toBe(false);
  });

  it('visitantes e serviços diferentes não se misturam', () => {
    const views = createViewWindow({ now: () => 0 });
    expect(views.shouldCount('5:u7')).toBe(true);
    expect(views.shouldCount('5:u8')).toBe(true);
    expect(views.shouldCount('6:u7')).toBe(true);
    expect(views.size()).toBe(3);
  });

  it('quem saiu da janela sai da memória', () => {
    let now = 0;
    const views = createViewWindow({ windowMs: 100, now: () => now });
    views.shouldCount('a');
    views.shouldCount('b');
    now = 50;
    views.shouldCount('c');
    now = 120; // a e b venceram; c ainda não
    views.shouldCount('d');
    expect(views.size()).toBe(2);
  });

  it('acima do teto, esquece o mais antigo (protege a memória num pico)', () => {
    let now = 0;
    const views = createViewWindow({ maxEntries: 2, now: () => now++ });
    views.shouldCount('a');
    views.shouldCount('b');
    views.shouldCount('c');
    expect(views.size()).toBe(2);
    // "a" foi esquecido: conta de novo; "c" ainda está na janela.
    expect(views.shouldCount('a')).toBe(true);
    expect(views.shouldCount('c')).toBe(false);
  });

  it('a janela da API segue o relógio do servidor (o mesmo dos testes de integração)', () => {
    setClockForTests(new Date('2026-10-19T12:00:00Z'), { frozen: true });
    expect(serviceViews.shouldCount('9:ip1')).toBe(true);
    expect(serviceViews.shouldCount('9:ip1')).toBe(false);
    setClockForTests(new Date('2026-10-19T12:30:00Z'), { frozen: true });
    expect(serviceViews.shouldCount('9:ip1')).toBe(true);
    serviceViews.clear();
    expect(serviceViews.size()).toBe(0);
  });
});
