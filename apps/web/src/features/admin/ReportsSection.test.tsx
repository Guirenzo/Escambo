import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminReportActionResult, AdminReportGroup } from '@escambo/types';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dtm } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { ReportsSection } from './ReportsSection';

const adminReports = vi.fn();
const adminReportAction = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    adminReports: (status: string) => adminReports(status),
    adminReportAction: (id: number, action: string, body: unknown) =>
      adminReportAction(id, action, body),
  },
}));

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (ui: ReactNode, client: QueryClient = newClient()) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>
      <ToastProvider>{ui}</ToastProvider>
    </MemoryRouter>
  </QueryClientProvider>
);

const OWNER_ULID = '01HZX3J8K2M4N6P8Q0R2S4T6V8';
/** Imagem enviada ao Escambo: tem miniatura (?w=128). */
const MEDIA = '/api/media/2026/09/01HZX3J8K2M4N6P8Q0R2S4T6V8.jpg';
const LAST = '2026-09-22T15:00:00.000Z';

const group = (over: Partial<AdminReportGroup> = {}): AdminReportGroup => ({
  id: 11,
  targetType: 'avatar',
  targetId: 5,
  imageUrl: MEDIA,
  imageLive: true,
  label: 'Foto de perfil',
  excerpt: null,
  owner: { id: 5, ulid: OWNER_ULID, name: 'Ana Souza' },
  status: 'pending',
  reports: 3,
  reasons: [
    { reason: 'offensive', count: 2 },
    { reason: 'spam', count: 1 },
  ],
  descriptions: ['Imagem imprópria para o perfil', 'outra descrição'],
  firstReportedAt: '2026-09-20T10:00:00.000Z',
  lastReportedAt: LAST,
  reviewedAt: null,
  resolutionNote: null,
  automatic: false,
  ...over,
});

const review = (over: Partial<AdminReportGroup> = {}): AdminReportGroup =>
  group({
    id: 21,
    targetType: 'review',
    imageUrl: null,
    imageLive: false,
    label: 'Avaliação de Bruno',
    excerpt: 'Péssimo, me chama no zap',
    reports: 1,
    reasons: [{ reason: 'off_platform', count: 1 }],
    descriptions: [],
    ...over,
  });

const message = (over: Partial<AdminReportGroup> = {}): AdminReportGroup =>
  review({ id: 31, targetType: 'message', label: 'Mensagem no chat', ...over });

const service = (over: Partial<AdminReportGroup> = {}): AdminReportGroup =>
  group({
    id: 41,
    targetType: 'service',
    imageUrl: null,
    imageLive: false,
    label: 'Serviço “Logo em 24h”',
    reports: 1,
    reasons: [{ reason: 'fraud', count: 1 }],
    descriptions: [],
    ...over,
  });

const result = (over: Partial<AdminReportActionResult> = {}): AdminReportActionResult => ({
  status: 'actioned',
  reports: 3,
  referencesCleared: 1,
  fileRemoved: true,
  blocked: true,
  removalId: 9,
  ownerStrikes: 1,
  uploadsBlockedUntil: null,
  accountReviewOpened: false,
  ...over,
});

/** A linha de um grupo: o nome acessível dela começa pelo alvo denunciado. */
const row = (target: string) =>
  within(screen.getByRole('row', { name: (name) => name.startsWith(target) }));
/** A miniatura (decorativa, alt vazio) de uma linha ou do diálogo. */
const thumbIn = (scope: ReturnType<typeof within>) => scope.queryByRole('presentation');
const headers = (): (string | null)[] =>
  screen.getAllByRole('columnheader').map((h) => h.textContent);

/** Abre a decisão de um grupo e devolve o diálogo. */
async function openDecision(
  user: ReturnType<typeof userEvent.setup>,
  target: string,
  button: string,
  title: string,
) {
  await user.click(row(target).getByRole('button', { name: button }));
  return within(screen.getByRole('dialog', { name: title }));
}

beforeEach(() => {
  adminReports.mockReset();
  adminReportAction.mockReset();
  adminReports.mockResolvedValue([group()]);
  adminReportAction.mockResolvedValue(result());
});

/** Fila de moderação (ADR 39): denúncias agrupadas por alvo, com uma decisão para o grupo todo. */
describe('ReportsSection: a fila', () => {
  it('abre nas pendentes e mostra o esqueleto enquanto carrega; a tabela entra no lugar dele', async () => {
    let release!: (list: AdminReportGroup[]) => void;
    adminReports.mockReturnValue(new Promise<AdminReportGroup[]>((r) => (release = r)));
    render(wrap(<ReportsSection />));

    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pendentes' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Resolvidas' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(adminReports).toHaveBeenCalledTimes(1);
    expect(adminReports).toHaveBeenCalledWith('pending');

    release([group()]);
    expect(await screen.findByText('Foto de perfil')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Carregando' })).not.toBeInTheDocument();
    // O cabeçalho e uma linha por grupo.
    expect(screen.getAllByRole('row')).toHaveLength(2);
  });

  it('erro ao carregar mostra a mensagem e "Tentar de novo" busca outra vez', async () => {
    adminReports.mockRejectedValueOnce(new Error('Erro 500 na fila'));
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));

    expect(await screen.findByRole('alert')).toHaveTextContent('Erro 500 na fila');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByText('Foto de perfil')).toBeInTheDocument();
    expect(adminReports).toHaveBeenCalledTimes(2);
  });

  it('cada grupo diz o alvo, o dono com link para o perfil, os motivos contados e a última denúncia', async () => {
    render(wrap(<ReportsSection />));

    expect(await screen.findByText('Foto de perfil')).toBeInTheDocument();
    expect(headers()).toEqual(['Alvo', 'Motivos', 'Situação', 'Ações']);
    const r = row('Foto de perfil');
    expect(r.getByText(/^de Ana Souza/)).toHaveTextContent('de Ana Souza · ver perfil');
    expect(r.getByRole('link', { name: 'ver perfil' })).toHaveAttribute(
      'href',
      `/freelancers/${OWNER_ULID}`,
    );
    // Motivo repetido leva o contador; o que veio uma vez só não.
    expect(r.getByText('Conteúdo ofensivo ×2')).toBeInTheDocument();
    expect(r.getByText('Spam')).toBeInTheDocument();
    expect(r.queryByText('Sinalização automática')).not.toBeInTheDocument();
    // Só a descrição mais recente aparece na linha.
    expect(r.getByText('Imagem imprópria para o perfil')).toBeInTheDocument();
    expect(r.queryByText('outra descrição')).not.toBeInTheDocument();
    expect(r.getByText(`3 denúncias · última em ${dtm(LAST)}`)).toBeInTheDocument();
    expect(r.getByText('Pendente')).toBeInTheDocument();
    expect(r.queryByText('esta imagem já não está no ar')).not.toBeInTheDocument();
    // Ainda sem decisão: a coluna da situação não tem data de análise.
    expect(r.queryByText(/^em \d/)).not.toBeInTheDocument();
  });

  it('uma denúncia só fica no singular, e a automática ganha a etiqueta', async () => {
    adminReports.mockResolvedValue([
      message({ status: 'reviewing', automatic: true, owner: null }),
    ]);
    render(wrap(<ReportsSection />));

    expect(await screen.findByText('Mensagem no chat')).toBeInTheDocument();
    const r = row('Mensagem no chat');
    expect(r.getByText(`1 denúncia · última em ${dtm(LAST)}`)).toBeInTheDocument();
    expect(r.getByText('Tenta negociar fora da plataforma')).toBeInTheDocument();
    expect(r.getByText('Sinalização automática')).toBeInTheDocument();
    expect(r.getByText('Em análise')).toBeInTheDocument();
    // Alvo sem dono (conta apagada): a linha não inventa um "de …".
    expect(r.queryByText(/^de /)).not.toBeInTheDocument();
  });

  it('avaliação e mensagem mostram o trecho denunciado entre aspas e não dão link para o perfil', async () => {
    adminReports.mockResolvedValue([
      review(),
      message({ owner: { id: 8, ulid: 'X', name: null } }),
    ]);
    render(wrap(<ReportsSection />));

    expect(await screen.findByText('Avaliação de Bruno')).toBeInTheDocument();
    expect(row('Avaliação de Bruno').getByText('“Péssimo, me chama no zap”')).toBeInTheDocument();
    expect(row('Avaliação de Bruno').getByText('de Ana Souza')).toBeInTheDocument();
    expect(row('Avaliação de Bruno').queryByRole('link')).not.toBeInTheDocument();
    expect(row('Mensagem no chat').getByText('de conta sem nome')).toBeInTheDocument();
    expect(row('Mensagem no chat').queryByRole('link')).not.toBeInTheDocument();
    // Texto não tem imagem: nem miniatura, nem o aviso de imagem fora do ar.
    for (const target of ['Avaliação de Bruno', 'Mensagem no chat']) {
      expect(thumbIn(row(target))).not.toBeInTheDocument();
      expect(row(target).queryByText('esta imagem já não está no ar')).not.toBeInTheDocument();
    }
  });

  it('a ação oferecida depende do alvo: imagem, avaliação, mensagem ou só "Resolvida"', async () => {
    adminReports.mockResolvedValue([
      group(),
      group({ id: 12, targetType: 'portfolio_item', label: 'Trabalho “Logo”' }),
      // Foto de perfil sem imagem guardada: não há o que remover.
      group({ id: 13, label: 'Foto antiga', imageUrl: null, imageLive: false }),
      review(),
      message(),
      service(),
      service({ id: 42, targetType: 'user', label: 'Conta de Ana' }),
    ]);
    render(wrap(<ReportsSection />));
    await screen.findByText('Trabalho “Logo”');

    const actions = (target: string) =>
      row(target)
        .getAllByRole('button')
        .map((b) => b.textContent?.trim());
    expect(actions('Foto de perfil')).toEqual(['Remover imagem', 'Dispensar']);
    expect(actions('Trabalho “Logo”')).toEqual(['Remover imagem', 'Dispensar']);
    expect(actions('Foto antiga')).toEqual(['Resolvida', 'Dispensar']);
    expect(actions('Avaliação de Bruno')).toEqual(['Remover avaliação', 'Dispensar']);
    expect(actions('Mensagem no chat')).toEqual(['Remover mensagem', 'Dispensar']);
    expect(actions('Serviço “Logo em 24h”')).toEqual(['Resolvida', 'Dispensar']);
    expect(actions('Conta de Ana')).toEqual(['Resolvida', 'Dispensar']);
  });

  it('a miniatura pede a versão pequena da imagem; se ela não abre, cai no ícone', async () => {
    render(wrap(<ReportsSection />));
    await screen.findByText('Foto de perfil');

    const thumb = row('Foto de perfil').getByRole('presentation');
    expect(thumb).toHaveAttribute('src', `${MEDIA}?w=128`);
    expect(thumb).toHaveAttribute('alt', '');

    fireEvent.error(thumb);
    expect(thumbIn(row('Foto de perfil'))).not.toBeInTheDocument();
  });

  it('imagem que já saiu do ar: avisa na linha', async () => {
    adminReports.mockResolvedValue([group({ imageLive: false })]);
    render(wrap(<ReportsSection />));

    expect(await screen.findByText('esta imagem já não está no ar')).toBeInTheDocument();
    // Ainda pendente: a miniatura continua sendo pedida (é a prova da denúncia).
    expect(thumbIn(row('Foto de perfil'))).toHaveAttribute('src', `${MEDIA}?w=128`);
  });

  it('"Resolvidas" busca as decididas e mostra a decisão, a nota e quando, sem ações', async () => {
    const reviewedAt = '2026-09-23T18:30:00.000Z';
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Foto de perfil');
    adminReports.mockResolvedValue([
      group({
        status: 'actioned',
        imageLive: false,
        reviewedAt,
        resolutionNote: 'Nudez explícita.',
      }),
      // Resolvida com a imagem ainda no ar (a ação foi em outro lugar): a miniatura continua.
      group({
        id: 12,
        targetType: 'portfolio_item',
        label: 'Trabalho “Logo”',
        status: 'actioned',
        imageLive: true,
        reviewedAt,
      }),
      service({ status: 'dismissed', reviewedAt }),
    ]);

    await user.click(screen.getByRole('tab', { name: 'Resolvidas' }));

    expect(await screen.findAllByText('Com ação')).toHaveLength(2);
    expect(adminReports).toHaveBeenLastCalledWith('resolved');
    expect(screen.getByRole('tab', { name: 'Resolvidas' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: 'Pendentes' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(headers()).toEqual(['Alvo', 'Motivos', 'Decisão']);
    expect(row('Foto de perfil').getByText('Nudez explícita.')).toBeInTheDocument();
    expect(row('Foto de perfil').getByText(`em ${dtm(reviewedAt)}`)).toBeInTheDocument();
    expect(row('Foto de perfil').getByText('esta imagem já não está no ar')).toBeInTheDocument();
    // Removida com ação: o arquivo já foi apagado, então a miniatura nem é pedida.
    expect(thumbIn(row('Foto de perfil'))).not.toBeInTheDocument();
    expect(thumbIn(row('Trabalho “Logo”'))).toHaveAttribute('src', `${MEDIA}?w=128`);
    expect(
      row('Trabalho “Logo”').queryByText('esta imagem já não está no ar'),
    ).not.toBeInTheDocument();
    expect(row('Serviço “Logo em 24h”').getByText('Dispensada')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Dispensar' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Remover imagem' })).not.toBeInTheDocument();

    // De volta às pendentes, a fila pendente é buscada de novo e as ações reaparecem.
    adminReports.mockResolvedValue([group()]);
    await user.click(screen.getByRole('tab', { name: 'Pendentes' }));
    expect(await screen.findByRole('button', { name: 'Remover imagem' })).toBeInTheDocument();
    expect(adminReports).toHaveBeenLastCalledWith('pending');
    expect(headers()).toEqual(['Alvo', 'Motivos', 'Situação', 'Ações']);
  });

  // Hoje a lista vazia desenha a tabela só com o cabeçalho: o QueryState recebe `empty` sem
  // `isEmpty`, e por isso nunca mostra o texto (defeito relatado, não corrigido aqui).
  it.todo('fila vazia diz "Nenhuma denúncia pendente. A comunidade está tranquila."');
});

describe('ReportsSection: a decisão', () => {
  it('remover imagem: explica o efeito, manda a nota e avisa que removeu e bloqueou', async () => {
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 'Foto de perfil', 'Remover imagem', 'Remover imagem');
    expect(dialog.getByText('Foto de perfil')).toBeInTheDocument();
    expect(dialog.getByText('3 denúncias · de Ana Souza')).toBeInTheDocument();
    // A imagem denunciada aparece também no diálogo, na versão pequena.
    expect(thumbIn(dialog)).toHaveAttribute('src', `${MEDIA}?w=128`);
    expect(
      dialog.getByText(
        'A imagem sai de todo perfil e trabalho que a mostra e a mesma imagem não pode ser enviada de novo. O arquivo fica guardado fora do ar enquanto o dono pode contestar, o dono recebe um aviso com a sua nota e o prazo, e a remoção conta para a reincidência dele.',
      ),
    ).toBeInTheDocument();
    const note = dialog.getByRole('textbox', { name: 'Nota para o registro' });
    expect(note).toHaveAttribute('maxlength', '500');
    await user.type(note, '  Nudez explícita.  ');
    adminReports.mockResolvedValue([]);
    await user.click(dialog.getByRole('button', { name: 'Remover e bloquear' }));

    expect(await screen.findByText('Imagem removida e bloqueada.')).toBeInTheDocument();
    expect(adminReportAction).toHaveBeenCalledTimes(1);
    expect(adminReportAction).toHaveBeenCalledWith(11, 'remove-image', {
      note: 'Nudez explícita.',
    });
    // Decidido: o diálogo fecha e a fila é buscada de novo.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(adminReports).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Foto de perfil')).not.toBeInTheDocument());
  });

  it('remover imagem que era link externo avisa que não há arquivo para bloquear', async () => {
    adminReportAction.mockResolvedValue(result({ blocked: false, fileRemoved: false }));
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 'Foto de perfil', 'Remover imagem', 'Remover imagem');
    await user.click(dialog.getByRole('button', { name: 'Remover e bloquear' }));

    expect(
      await screen.findByText(
        'Imagem removida. Era um link externo, então não há arquivo para bloquear.',
      ),
    ).toBeInTheDocument();
    // Sem nota escrita, vai null (e não string vazia).
    expect(adminReportAction).toHaveBeenCalledWith(11, 'remove-image', { note: null });
  });

  it('remoção que bloqueia os envios do dono diz até quando', async () => {
    const until = '2026-10-01T03:00:00.000Z';
    adminReportAction.mockResolvedValue(result({ ownerStrikes: 2, uploadsBlockedUntil: until }));
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 'Foto de perfil', 'Remover imagem', 'Remover imagem');
    await user.click(dialog.getByRole('button', { name: 'Remover e bloquear' }));

    expect(
      await screen.findByText(
        `Imagem removida e bloqueada. O dono fica sem enviar imagens até ${dtm(until)}.`,
      ),
    ).toBeInTheDocument();
  });

  it('remoção que leva o dono ao limite avisa da revisão da conta (e isso vem antes do bloqueio)', async () => {
    adminReportAction.mockResolvedValue(
      result({
        ownerStrikes: 3,
        accountReviewOpened: true,
        uploadsBlockedUntil: '2026-10-01T03:00:00.000Z',
      }),
    );
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 'Foto de perfil', 'Remover imagem', 'Remover imagem');
    await user.click(dialog.getByRole('button', { name: 'Remover e bloquear' }));

    expect(
      await screen.findByText(
        'Imagem removida e bloqueada. O dono chegou a 3 remoções e a conta entrou na fila para revisão.',
      ),
    ).toBeInTheDocument();
  });

  it('remover avaliação: o diálogo fala da nota média e o aviso diz "Avaliação removida."', async () => {
    adminReports.mockResolvedValue([review()]);
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Avaliação de Bruno');

    const dialog = await openDecision(
      user,
      'Avaliação de Bruno',
      'Remover avaliação',
      'Remover avaliação',
    );
    expect(dialog.getByText('1 denúncia · de Ana Souza')).toBeInTheDocument();
    expect(dialog.getByText('“Péssimo, me chama no zap”')).toBeInTheDocument();
    expect(
      dialog.getByText(
        'A avaliação sai do perfil e da nota média do freelancer, e na contratação as partes veem que ela foi removida. O texto fica guardado para a contestação, o autor recebe um aviso com a sua nota e o prazo, e a remoção conta para a reincidência dele.',
      ),
    ).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Remover e avisar o autor' }));

    expect(await screen.findByText('Avaliação removida.')).toBeInTheDocument();
    expect(adminReportAction).toHaveBeenCalledWith(21, 'remove-content', { note: null });
  });

  it('remover mensagem: o diálogo fala do chat, e no limite o aviso inclui a revisão da conta', async () => {
    adminReports.mockResolvedValue([message({ owner: null })]);
    adminReportAction.mockResolvedValue(result({ ownerStrikes: 3, accountReviewOpened: true }));
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Mensagem no chat');

    const dialog = await openDecision(
      user,
      'Mensagem no chat',
      'Remover mensagem',
      'Remover mensagem',
    );
    // Sem dono conhecido, o resumo fica só na contagem.
    expect(dialog.getByText('1 denúncia')).toBeInTheDocument();
    expect(
      dialog.getByText(
        'A mensagem vira um aviso no chat das duas partes, e o anexo dela deixa de abrir. O texto fica guardado para a contestação, o autor recebe um aviso com a sua nota e o prazo, e a remoção conta para a reincidência dele.',
      ),
    ).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Remover e avisar o autor' }));

    expect(
      await screen.findByText(
        'Mensagem removida. O autor chegou a 3 remoções e a conta entrou na fila para revisão.',
      ),
    ).toBeInTheDocument();
    expect(adminReportAction).toHaveBeenCalledWith(31, 'remove-content', { note: null });
  });

  it('dispensar: nada muda no conteúdo, e nota só de espaços vai como null', async () => {
    adminReportAction.mockResolvedValue(result({ status: 'dismissed' }));
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 'Foto de perfil', 'Dispensar', 'Dispensar denúncias');
    expect(
      dialog.getByText(
        'Nada muda no conteúdo. As denúncias saem da fila com a sua nota no histórico.',
      ),
    ).toBeInTheDocument();
    await user.type(dialog.getByRole('textbox', { name: 'Nota para o registro' }), '   ');
    await user.click(dialog.getByRole('button', { name: 'Dispensar' }));

    expect(await screen.findByText('Denúncias dispensadas.')).toBeInTheDocument();
    expect(adminReportAction).toHaveBeenCalledWith(11, 'dismiss', { note: null });
  });

  it('marcar como resolvida: para quando a ação foi tomada em outro lugar', async () => {
    adminReports.mockResolvedValue([service()]);
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Serviço “Logo em 24h”');

    const dialog = await openDecision(
      user,
      'Serviço “Logo em 24h”',
      'Resolvida',
      'Marcar como resolvida',
    );
    expect(
      dialog.getByText(
        'Use quando a ação já foi tomada em outro lugar, como suspender a conta no perfil.',
      ),
    ).toBeInTheDocument();
    await user.type(
      dialog.getByRole('textbox', { name: 'Nota para o registro' }),
      'Conta suspensa.',
    );
    await user.click(dialog.getByRole('button', { name: 'Marcar resolvida' }));

    expect(await screen.findByText('Denúncias marcadas como resolvidas.')).toBeInTheDocument();
    expect(adminReportAction).toHaveBeenCalledWith(41, 'resolve', { note: 'Conta suspensa.' });
  });

  it('fechar o diálogo não decide nada, e reabrir começa com a nota em branco', async () => {
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Foto de perfil');

    const first = await openDecision(user, 'Foto de perfil', 'Dispensar', 'Dispensar denúncias');
    await user.type(first.getByRole('textbox', { name: 'Nota para o registro' }), 'rascunho');
    await user.click(first.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(adminReportAction).not.toHaveBeenCalled();

    const second = await openDecision(user, 'Foto de perfil', 'Remover imagem', 'Remover imagem');
    expect(second.getByRole('textbox', { name: 'Nota para o registro' })).toHaveValue('');
  });

  it('Esc fecha o diálogo sem decidir, e o grupo continua na fila com as ações', async () => {
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 'Foto de perfil', 'Remover imagem', 'Remover imagem');
    await user.type(dialog.getByRole('textbox', { name: 'Nota para o registro' }), 'rascunho');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(adminReportAction).not.toHaveBeenCalled();
    expect(row('Foto de perfil').getByRole('button', { name: 'Remover imagem' })).toBeEnabled();
    expect(row('Foto de perfil').getByRole('button', { name: 'Dispensar' })).toBeEnabled();
    expect(adminReports).toHaveBeenCalledTimes(1);
  });

  it('dono sem nome (conta anonimizada): o resumo do diálogo fica só na contagem, sem "de …"', async () => {
    adminReports.mockResolvedValue([
      service({ owner: { id: 8, ulid: OWNER_ULID, name: null }, reports: 2 }),
    ]);
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Serviço “Logo em 24h”');
    // Na fila, o dono sem nome aparece como "conta sem nome", com o link do perfil.
    expect(row('Serviço “Logo em 24h”').getByText(/^de conta sem nome/)).toHaveTextContent(
      'de conta sem nome · ver perfil',
    );

    const dialog = await openDecision(
      user,
      'Serviço “Logo em 24h”',
      'Dispensar',
      'Dispensar denúncias',
    );

    expect(dialog.getByText('Serviço “Logo em 24h”')).toBeInTheDocument();
    expect(dialog.getByText('2 denúncias')).toBeInTheDocument();
    expect(dialog.queryByText(/ · de /)).not.toBeInTheDocument();
    // Serviço não tem trecho denunciado nem imagem: nada entre aspas, nenhuma miniatura.
    expect(dialog.queryByText(/^“/)).not.toBeInTheDocument();
    expect(thumbIn(dialog)).not.toBeInTheDocument();
  });

  it('a decisão vence o armazenamento e a saúde da moderação; as contestações ficam como estão', async () => {
    const client = newClient();
    client.setQueryData(['adminStorage'], { retentionDays: 90 });
    client.setQueryData(['moderationHealth', 30], { windowDays: 30 });
    client.setQueryData(['adminAppeals', 'pending'], []);
    const invalidated = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
    const user = userEvent.setup();
    render(wrap(<ReportsSection />, client));
    await screen.findByText('Foto de perfil');
    expect(invalidated(['adminStorage'])).toBe(false);
    expect(invalidated(['moderationHealth', 30])).toBe(false);

    const dialog = await openDecision(user, 'Foto de perfil', 'Remover imagem', 'Remover imagem');
    await user.click(dialog.getByRole('button', { name: 'Remover e bloquear' }));
    await screen.findByText('Imagem removida e bloqueada.');

    expect(invalidated(['adminStorage'])).toBe(true);
    expect(invalidated(['moderationHealth', 30])).toBe(true);
    expect(invalidated(['adminAppeals', 'pending'])).toBe(false);
    await waitFor(() => expect(adminReports).toHaveBeenCalledTimes(2));
  });

  it('enquanto grava, o botão do diálogo diz "Salvando…" e fica desabilitado', async () => {
    let release!: (r: AdminReportActionResult) => void;
    adminReportAction.mockImplementation(
      () => new Promise<AdminReportActionResult>((r) => (release = r)),
    );
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 'Foto de perfil', 'Dispensar', 'Dispensar denúncias');
    await user.click(dialog.getByRole('button', { name: 'Dispensar' }));
    expect(await dialog.findByRole('button', { name: 'Salvando…' })).toBeDisabled();

    release(result({ status: 'dismissed' }));
    expect(await screen.findByText('Denúncias dispensadas.')).toBeInTheDocument();
  });

  it('recusa da API vira aviso com a mensagem dela, e o diálogo continua aberto com a nota', async () => {
    adminReportAction.mockRejectedValue(new Error('Outro admin já decidiu este grupo.'));
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 'Foto de perfil', 'Remover imagem', 'Remover imagem');
    await user.type(dialog.getByRole('textbox', { name: 'Nota para o registro' }), 'Ofensiva');
    await user.click(dialog.getByRole('button', { name: 'Remover e bloquear' }));

    expect(await screen.findByText('Outro admin já decidiu este grupo.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Remover imagem' })).toBeInTheDocument();
    expect(dialog.getByRole('textbox', { name: 'Nota para o registro' })).toHaveValue('Ofensiva');
    expect(screen.queryByText('Imagem removida e bloqueada.')).not.toBeInTheDocument();
    // O botão volta ao normal, para o admin tentar de novo; a fila não é buscada outra vez.
    expect(dialog.getByRole('button', { name: 'Remover e bloquear' })).toBeEnabled();
    expect(adminReportAction).toHaveBeenCalledTimes(1);
    expect(adminReportAction).toHaveBeenCalledWith(11, 'remove-image', { note: 'Ofensiva' });
    expect(adminReports).toHaveBeenCalledTimes(1);
  });

  it('falha sem mensagem cai no aviso genérico', async () => {
    adminReportAction.mockRejectedValue(undefined);
    const user = userEvent.setup();
    render(wrap(<ReportsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 'Foto de perfil', 'Dispensar', 'Dispensar denúncias');
    await user.click(dialog.getByRole('button', { name: 'Dispensar' }));

    expect(await screen.findByText('Não foi possível registrar a decisão')).toBeInTheDocument();
  });
});
