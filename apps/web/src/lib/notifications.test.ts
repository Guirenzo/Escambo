import { describe, expect, it } from 'vitest';
import { notificationPath } from './notifications';

describe('notificationPath', () => {
  it('leva cada notificação para a tela certa', () => {
    expect(notificationPath({ contractId: 12 })).toBe('/contratos/12');
    expect(notificationPath({ dropoutId: 7, contractId: 12 })).toBe('/perfil#desistencias');
    expect(notificationPath({ savedSearchId: 7, serviceIds: [1, 2] })).toBe('/servicos?busca=7');
    expect(notificationPath({ barterId: 3 })).toBe('/trocas');
    expect(notificationPath({ withdrawalId: 1 })).toBe('/carteira');
    expect(notificationPath({ depositId: 1 })).toBe('/carteira');
    expect(notificationPath({ exportRequestId: 5 })).toBe('/perfil');
    expect(notificationPath({ contentRemoved: 'avatar', reportId: 3 })).toBe('/perfil');
    expect(notificationPath({ removalId: 8, decision: 'overturned' })).toBe('/perfil');
    expect(notificationPath({ imageRemovalId: 8 })).toBe('/perfil');
  });

  it('sem destino conhecido não inventa link', () => {
    expect(notificationPath(null)).toBeNull();
    expect(notificationPath({})).toBeNull();
    expect(notificationPath({ contractId: '12' })).toBeNull();
  });

  it('abre o chamado correto e só usa a fila administrativa com flag booleana', () => {
    expect(notificationPath({ supportTicketId: 18, contractId: 12 })).toBe('/suporte?ticket=18');
    expect(notificationPath({ supportTicketId: 18, supportAdmin: true })).toBe(
      '/admin?ticket=18#suporte',
    );
    expect(notificationPath({ supportTicketId: 18, supportAdmin: 'true' })).toBe(
      '/suporte?ticket=18',
    );
  });

  it.each(['18', -1, 0, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'não monta destino de suporte a partir de identificador inválido: %s',
    (supportTicketId) => expect(notificationPath({ supportTicketId })).toBeNull(),
  );
});
