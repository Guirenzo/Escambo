import { describe, expect, it } from 'vitest';
import { notificationPath } from './notifications';

describe('notificationPath', () => {
  it('leva cada notificação para a tela certa', () => {
    expect(notificationPath({ contractId: 12 })).toBe('/contratos/12');
    expect(notificationPath({ savedSearchId: 7, serviceIds: [1, 2] })).toBe('/servicos?busca=7');
    expect(notificationPath({ barterId: 3 })).toBe('/trocas');
    expect(notificationPath({ withdrawalId: 1 })).toBe('/carteira');
    expect(notificationPath({ depositId: 1 })).toBe('/carteira');
    expect(notificationPath({ exportRequestId: 5 })).toBe('/perfil');
    expect(notificationPath({ contentRemoved: 'avatar', reportId: 3 })).toBe('/perfil');
    expect(notificationPath({ imageRemovalId: 8, decision: 'overturned' })).toBe('/perfil');
  });

  it('sem destino conhecido não inventa link', () => {
    expect(notificationPath(null)).toBeNull();
    expect(notificationPath({})).toBeNull();
    expect(notificationPath({ contractId: '12' })).toBeNull();
  });
});
