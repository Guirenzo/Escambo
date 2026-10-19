import { beforeEach, describe, expect, it, vi } from 'vitest';
import { runSupportMaintenance } from './support-maintenance';
const { repo, dispatch, warn } = vi.hoisted(() => ({
  repo: { maintenanceCandidates: vi.fn(), activeAdmins: vi.fn(), maintain: vi.fn() },
  dispatch: vi.fn(),
  warn: vi.fn(),
}));
vi.mock('../modules/support/support.repository', () => ({ supportRepository: repo }));
vi.mock('../modules/notifications/notifications.service', () => ({
  notificationsService: { dispatch },
}));
vi.mock('../config/logger', () => ({ logger: { warn } }));
beforeEach(() => {
  vi.resetAllMocks();
  repo.maintenanceCandidates.mockResolvedValue([12, 13]);
  repo.activeAdmins.mockResolvedValue([90]);
  repo.maintain.mockResolvedValue({ alerted: false, closed: false, notices: [] });
});
describe('job de suporte', () => {
  it('consulta lote controlado, revalida e envia somente depois do commit do repository', async () => {
    const saved = { userId: 90, id: 99, params: {} };
    repo.maintain
      .mockResolvedValueOnce({ alerted: true, closed: false, notices: [saved] })
      .mockResolvedValueOnce({ alerted: false, closed: true, notices: [] });
    expect(await runSupportMaintenance()).toEqual({ alerted: [12], closed: [13], failed: [] });
    expect(repo.maintenanceCandidates).toHaveBeenCalledWith(100);
    expect(repo.maintain.mock.calls).toEqual([
      [12, [90]],
      [13, [90]],
    ]);
    expect(dispatch).toHaveBeenCalledWith(saved);
    expect(dispatch.mock.invocationCallOrder[0]).toBeGreaterThan(
      repo.maintain.mock.invocationCallOrder[0]!,
    );
  });
  it('sem admins ainda processa encerramentos', async () => {
    repo.activeAdmins.mockResolvedValue([]);
    await runSupportMaintenance();
    expect(repo.maintain).toHaveBeenCalledWith(12, []);
  });
  it('falha de um ticket deixa retry para próxima rodada sem logar texto privado', async () => {
    repo.maintain
      .mockRejectedValueOnce(new Error('TEXTO PRIVADO'))
      .mockResolvedValueOnce({ alerted: false, closed: true, notices: [] });
    expect(await runSupportMaintenance()).toEqual({ alerted: [], closed: [13], failed: [12] });
    expect(JSON.stringify(warn.mock.calls)).not.toContain('TEXTO PRIVADO');
  });
  it('falha de dispatch não desfaz marcador nem obstrui próximo chamado', async () => {
    repo.maintain.mockResolvedValueOnce({ alerted: true, closed: false, notices: [{}] });
    dispatch.mockImplementation(() => {
      throw new Error('Falhou');
    });
    expect(await runSupportMaintenance()).toEqual({ alerted: [12], closed: [], failed: [] });
    expect(repo.maintain).toHaveBeenCalledTimes(2);
  });
});
