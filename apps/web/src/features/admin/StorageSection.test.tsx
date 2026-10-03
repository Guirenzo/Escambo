import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminStorage, PurgeAttachmentsResult } from '@escambo/types';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dtm } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { StorageSection } from './StorageSection';

const adminStorage = vi.fn();
const adminPurgeAttachments = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    adminStorage: () => adminStorage(),
    adminPurgeAttachments: (...args: unknown[]) => adminPurgeAttachments(...args),
  },
}));

const wrap = (ui: ReactNode) => (
  <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <ToastProvider>{ui}</ToastProvider>
  </QueryClientProvider>
);

const storage = (over: Partial<AdminStorage> = {}): AdminStorage => ({
  retentionDays: 90,
  purgeHour: 3,
  uploads: { files: 12, bytes: 2048 },
  exports: { files: 2, bytes: 512 },
  media: { files: 7, variants: 21, bytes: 5 * 1024 * 1024, orphans: 0 },
  attachments: {
    active: 9,
    activeBytes: 1536,
    purged: 40,
    purged30d: 4,
    missing: 0,
    orphans: 0,
  },
  lastPurge: null,
  ...over,
});

const purged = (over: Partial<PurgeAttachmentsResult> = {}): PurgeAttachmentsResult => ({
  retentionDays: 90,
  cutoff: '2026-06-26T03:00:00.000Z',
  purged: 3,
  orphansRemoved: 1,
  failed: 0,
  skipped: null,
  ...over,
});

/** A frase do último expurgo, embaixo da grade. */
const lastPurge = (): Promise<HTMLElement> =>
  screen.findByText(/^(Último expurgo|Nenhum expurgo rodou ainda)/);

/** O valor ao lado de um rótulo da grade (dt → dd). */
const valueOf = (term: string): HTMLElement => {
  const dd = screen.getByText(term).nextElementSibling;
  if (!(dd instanceof HTMLElement)) throw new Error(`sem valor para "${term}"`);
  return dd;
};

beforeEach(() => {
  adminStorage.mockReset();
  adminPurgeAttachments.mockReset();
  adminStorage.mockResolvedValue(storage());
  adminPurgeAttachments.mockResolvedValue(purged());
});

/** Armazenamento do painel (ADR 31): o que está no disco e o expurgo sob demanda. */
describe('StorageSection', () => {
  it('enquanto carrega mostra o esqueleto, e o botão do expurgo já está lá', async () => {
    let release!: (s: AdminStorage) => void;
    adminStorage.mockReturnValue(new Promise<AdminStorage>((r) => (release = r)));
    render(wrap(<StorageSection />));

    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rodar expurgo agora' })).toBeEnabled();
    expect(screen.queryByText('Anexos no disco')).not.toBeInTheDocument();

    release(storage());
    expect(await screen.findByText('Anexos no disco')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Carregando' })).not.toBeInTheDocument();
  });

  it('mostra cada número do disco com o tamanho legível', async () => {
    render(wrap(<StorageSection />));

    expect(await screen.findByText('Anexos no disco')).toBeInTheDocument();
    expect(valueOf('Anexos no disco')).toHaveTextContent('9 · 2 KB');
    expect(valueOf('Pasta de uploads')).toHaveTextContent('12 arquivo(s) · 2 KB');
    expect(valueOf('Cópias LGPD')).toHaveTextContent('2 arquivo(s) · 512 B');
    expect(valueOf('Fotos e portfólio')).toHaveTextContent('7 imagem(ns) · 21 miniatura(s) · 5 MB');
    expect(valueOf('Já removidos')).toHaveTextContent('40 (4 nos últimos 30 dias)');
    expect(valueOf('Inconsistências')).toHaveTextContent('0 sem arquivo · 0 órfão(s)');
    expect(valueOf('Retenção')).toHaveTextContent('90 dias · expurgo diário às 3h');
    // Tudo consistente: a linha das inconsistências não ganha o destaque de alerta.
    expect(valueOf('Inconsistências').parentElement).not.toHaveClass('warn');
  });

  // O destaque é só visual (a classe `warn`); qualquer uma das três contagens acende a linha.
  it.each([
    ['anexo sem arquivo', { missing: 1, orphans: 0 }, 0, '1 sem arquivo · 0 órfão(s)'],
    ['anexo órfão', { missing: 0, orphans: 1 }, 0, '0 sem arquivo · 1 órfão(s)'],
    ['imagem órfã', { missing: 0, orphans: 0 }, 1, '0 sem arquivo · 1 órfão(s)'],
  ])('%s destaca a linha das inconsistências', async (_, attachments, mediaOrphans, text) => {
    const base = storage();
    adminStorage.mockResolvedValue(
      storage({
        attachments: { ...base.attachments, ...attachments },
        media: { ...base.media, orphans: mediaOrphans },
      }),
    );
    render(wrap(<StorageSection />));

    await screen.findByText('Inconsistências');
    expect(valueOf('Inconsistências')).toHaveTextContent(text);
    expect(valueOf('Inconsistências').parentElement).toHaveClass('warn');
  });

  it('as inconsistências somam os órfãos dos anexos com os das imagens', async () => {
    adminStorage.mockResolvedValue(
      storage({
        attachments: {
          active: 9,
          activeBytes: 1536,
          purged: 40,
          purged30d: 4,
          missing: 2,
          orphans: 3,
        },
        media: { files: 7, variants: 21, bytes: 100, orphans: 4 },
      }),
    );
    render(wrap(<StorageSection />));

    await screen.findByText('Inconsistências');
    expect(valueOf('Inconsistências')).toHaveTextContent('2 sem arquivo · 7 órfão(s)');
  });

  it('sem expurgo ainda, diz isso e explica a regra com a retenção atual', async () => {
    adminStorage.mockResolvedValue(storage({ retentionDays: 45 }));
    render(wrap(<StorageSection />));

    expect((await lastPurge()).textContent).toBe(
      'Nenhum expurgo rodou ainda. Anexos com mais de 45 dias em conversas sem contratação aberta saem do disco; a mensagem fica e diz por quê.',
    );
  });

  it('o último expurgo diz quando foi, quem rodou e o que saiu', async () => {
    const at = '2026-09-24T06:00:00.000Z';
    adminStorage.mockResolvedValue(
      storage({ lastPurge: { at, purged: 5, orphansRemoved: 2, trigger: 'admin' } }),
    );
    const { unmount } = render(wrap(<StorageSection />));
    expect(await lastPurge()).toHaveTextContent(
      `Último expurgo ${dtm(at)} (pelo admin): 5 anexo(s), 2 órfão(s). Anexos com mais de 90 dias`,
    );
    unmount();

    adminStorage.mockResolvedValue(
      storage({ lastPurge: { at, purged: 0, orphansRemoved: 0, trigger: 'job' } }),
    );
    render(wrap(<StorageSection />));
    expect(await lastPurge()).toHaveTextContent(
      `Último expurgo ${dtm(at)} (pelo job): 0 anexo(s), 0 órfão(s).`,
    );
  });

  it('rodar o expurgo chama a API sem argumentos, avisa o resultado e recarrega o cartão', async () => {
    const user = userEvent.setup();
    render(wrap(<StorageSection />));
    await screen.findByText('Anexos no disco');
    expect(adminStorage).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('button', { name: 'Rodar expurgo agora' }));

    expect(
      await screen.findByText('Expurgo concluído: 3 anexo(s) removido(s), 1 órfão(s).'),
    ).toBeInTheDocument();
    expect(adminPurgeAttachments).toHaveBeenCalledTimes(1);
    expect(adminPurgeAttachments).toHaveBeenCalledWith();
    await waitFor(() => expect(adminStorage).toHaveBeenCalledTimes(2));
  });

  it('expurgo com falhas diz quantas', async () => {
    adminPurgeAttachments.mockResolvedValue(purged({ purged: 1, orphansRemoved: 0, failed: 2 }));
    const user = userEvent.setup();
    render(wrap(<StorageSection />));
    await screen.findByText('Anexos no disco');

    await user.click(screen.getByRole('button', { name: 'Rodar expurgo agora' }));

    expect(
      await screen.findByText('Expurgo concluído: 1 anexo(s) removido(s), 0 órfão(s), 2 falha(s).'),
    ).toBeInTheDocument();
  });

  it('enquanto o expurgo roda, o botão fica desabilitado e diz "Rodando…"', async () => {
    let release!: (r: PurgeAttachmentsResult) => void;
    adminPurgeAttachments.mockImplementation(
      () => new Promise<PurgeAttachmentsResult>((r) => (release = r)),
    );
    const user = userEvent.setup();
    render(wrap(<StorageSection />));
    await screen.findByText('Anexos no disco');

    await user.click(screen.getByRole('button', { name: 'Rodar expurgo agora' }));
    expect(await screen.findByRole('button', { name: 'Rodando…' })).toBeDisabled();

    release(purged());
    expect(await screen.findByRole('button', { name: 'Rodar expurgo agora' })).toBeEnabled();
  });

  it('expurgo recusado vira aviso com a mensagem da API, sem recarregar o cartão', async () => {
    adminPurgeAttachments.mockRejectedValue(new Error('O expurgo já está rodando.'));
    const user = userEvent.setup();
    render(wrap(<StorageSection />));
    await screen.findByText('Anexos no disco');

    await user.click(screen.getByRole('button', { name: 'Rodar expurgo agora' }));

    expect(await screen.findByText('O expurgo já está rodando.')).toBeInTheDocument();
    expect(adminStorage).toHaveBeenCalledTimes(1);
  });

  it('falha sem mensagem cai no aviso genérico', async () => {
    adminPurgeAttachments.mockRejectedValue(null);
    const user = userEvent.setup();
    render(wrap(<StorageSection />));
    await screen.findByText('Anexos no disco');

    await user.click(screen.getByRole('button', { name: 'Rodar expurgo agora' }));

    expect(await screen.findByText('Não foi possível rodar o expurgo')).toBeInTheDocument();
  });

  it('erro ao carregar mostra a mensagem e "Tentar de novo" busca outra vez', async () => {
    adminStorage.mockRejectedValueOnce(new Error('Erro 500 ao ler o disco'));
    const user = userEvent.setup();
    render(wrap(<StorageSection />));

    expect(await screen.findByRole('alert')).toHaveTextContent('Erro 500 ao ler o disco');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByText('Anexos no disco')).toBeInTheDocument();
    expect(adminStorage).toHaveBeenCalledTimes(2);
  });
});
