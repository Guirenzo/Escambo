import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AdminAppeal, AdminAppealDecisionResult } from '@escambo/types';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { dtm } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { AppealsSection } from './AppealsSection';

const adminAppeals = vi.fn();
const adminAppealImage = vi.fn();
const adminDecideAppeal = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    adminAppeals: (status: string) => adminAppeals(status),
    adminAppealImage: (id: number) => adminAppealImage(id),
    adminDecideAppeal: (id: number, decision: string, body: unknown) =>
      adminDecideAppeal(id, decision, body),
  },
}));

/** O jsdom não tem URL de blob: a imagem guardada vira uma URL de mentira, e a revogação é vista. */
const createObjectURL = vi.fn<(blob: Blob) => string>();
const revokeObjectURL = vi.fn<(url: string) => void>();
Object.assign(URL, { createObjectURL, revokeObjectURL });

const newClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });
const wrap = (ui: ReactNode, client: QueryClient = newClient()) => (
  <QueryClientProvider client={client}>
    <MemoryRouter>
      <ToastProvider>{ui}</ToastProvider>
    </MemoryRouter>
  </QueryClientProvider>
);

const OWNER_ULID = '01HZX3J8K2M4N6P8Q0R2S4T6V8';
const MEDIA = '/api/media/2026/09/01HZX3J8K2M4N6P8Q0R2S4T6V8.jpg';
const REMOVED = '2026-09-20T13:00:00.000Z';
const APPEALED = '2026-09-21T09:30:00.000Z';
const DECIDED = '2026-09-22T17:45:00.000Z';
const BLOB_URL = 'blob:escambo/quarentena-7';

const appeal = (over: Partial<AdminAppeal> = {}): AdminAppeal => ({
  id: 7,
  owner: { id: 5, ulid: OWNER_ULID, name: 'Ana Souza' },
  targetType: 'avatar',
  label: 'Foto de perfil',
  excerpt: null,
  reason: 'offensive',
  note: 'Nudez explícita.',
  removedAt: REMOVED,
  imageUrl: MEDIA,
  appealText: 'A foto é minha e não tem nada de errado.',
  appealedAt: APPEALED,
  status: 'appealed',
  decidedAt: null,
  decisionNote: null,
  hasImage: true,
  ownerStrikes: 2,
  ...over,
});

const reviewAppeal = (over: Partial<AdminAppeal> = {}): AdminAppeal =>
  appeal({
    id: 8,
    targetType: 'review',
    label: 'Avaliação',
    excerpt: 'Trabalho ruim, não recomendo.',
    reason: 'spam',
    note: null,
    imageUrl: null,
    hasImage: false,
    appealText: 'Foi uma avaliação honesta.',
    ownerStrikes: 1,
    ...over,
  });

const messageAppeal = (over: Partial<AdminAppeal> = {}): AdminAppeal =>
  reviewAppeal({
    id: 9,
    targetType: 'message',
    label: 'Mensagem no chat',
    excerpt: 'Me chama no zap',
    reason: 'off_platform',
    ...over,
  });

const decision = (over: Partial<AdminAppealDecisionResult> = {}): AdminAppealDecisionResult => ({
  status: 'overturned',
  restoredReferences: 1,
  imageRestored: true,
  contentRestored: true,
  fileDeleted: false,
  ...over,
});

// O item da lista não tem nome acessível próprio; o data-testid só delimita a contestação.
const item = (id: number) => within(screen.getByTestId(`appeal-${id}`));
/** A miniatura do item: imagem decorativa (alt vazio), ou nada quando cai no ícone. */
const thumb = (id: number) => item(id).queryByRole('presentation');

/** Abre a decisão de uma contestação e devolve o diálogo. */
async function openDecision(
  user: ReturnType<typeof userEvent.setup>,
  id: number,
  button: 'Reverter' | 'Manter',
) {
  await user.click(item(id).getByRole('button', { name: button }));
  return within(
    screen.getByRole('dialog', {
      name: button === 'Reverter' ? 'Reverter remoção' : 'Manter remoção',
    }),
  );
}

beforeEach(() => {
  adminAppeals.mockReset();
  adminAppealImage.mockReset();
  adminDecideAppeal.mockReset();
  createObjectURL.mockReset();
  revokeObjectURL.mockReset();
  createObjectURL.mockReturnValue(BLOB_URL);
  adminAppeals.mockResolvedValue([appeal()]);
  adminAppealImage.mockResolvedValue({ blob: new Blob(['img']), fileName: 'contestacao-7' });
  adminDecideAppeal.mockResolvedValue(decision());
});

/** Contestações de remoção (ADR 41 e 44): o admin vê o que foi removido e mantém ou reverte. */
describe('AppealsSection: a fila', () => {
  it('abre nas pendentes e mostra o esqueleto enquanto carrega; a fila entra no lugar dele', async () => {
    let release!: (list: AdminAppeal[]) => void;
    adminAppeals.mockReturnValue(new Promise<AdminAppeal[]>((r) => (release = r)));
    render(wrap(<AppealsSection />));

    expect(screen.getByRole('status', { name: 'Carregando' })).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Pendentes' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Decididas' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(adminAppeals).toHaveBeenCalledTimes(1);
    expect(adminAppeals).toHaveBeenCalledWith('pending');

    release([appeal({ hasImage: false })]);
    expect(await screen.findByText('Foto de perfil')).toBeInTheDocument();
    expect(screen.queryByRole('status', { name: 'Carregando' })).not.toBeInTheDocument();
    expect(screen.getAllByRole('listitem')).toHaveLength(1);
  });

  it('erro ao carregar mostra a mensagem e "Tentar de novo" busca outra vez', async () => {
    adminAppeals.mockRejectedValueOnce(new Error('Erro 500 nas contestações'));
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));

    expect(await screen.findByRole('alert')).toHaveTextContent('Erro 500 nas contestações');
    await user.click(screen.getByRole('button', { name: 'Tentar de novo' }));

    expect(await screen.findByText('Foto de perfil')).toBeInTheDocument();
    expect(adminAppeals).toHaveBeenCalledTimes(2);
  });

  it('cada contestação diz o dono, a reincidência, a remoção com a nota e o texto de quem contesta', async () => {
    render(wrap(<AppealsSection />));

    expect(await screen.findByText('Foto de perfil')).toBeInTheDocument();
    const a = item(7);
    expect(a.getByText('Aguardando decisão')).toBeInTheDocument();
    expect(a.getByText(/^de Ana Souza/)).toHaveTextContent(
      'de Ana Souza · ver perfil · 2 remoções na janela',
    );
    expect(a.getByRole('link', { name: 'ver perfil' })).toHaveAttribute(
      'href',
      `/freelancers/${OWNER_ULID}`,
    );
    expect(a.getByText(`Removida em ${dtm(REMOVED)} · Conteúdo ofensivo`)).toBeInTheDocument();
    expect(a.getByText('Nudez explícita.')).toHaveTextContent('Nota da remoçãoNudez explícita.');
    expect(a.getByText('A foto é minha e não tem nada de errado.')).toHaveTextContent(
      `Contestação · ${dtm(APPEALED)}A foto é minha e não tem nada de errado.`,
    );
    // Imagem não tem texto removido, e sem decisão não há bloco de decisão.
    expect(a.queryByText('Conteúdo removido')).not.toBeInTheDocument();
    expect(a.queryByText(/^Decisão · /)).not.toBeInTheDocument();
    expect(a.getByRole('button', { name: 'Reverter' })).toBeEnabled();
    expect(a.getByRole('button', { name: 'Manter' })).toBeEnabled();
  });

  it('uma remoção só fica no singular; conta anonimizada aparece sem nome e sem o texto', async () => {
    adminAppeals.mockResolvedValue([
      reviewAppeal({ owner: { id: 5, ulid: OWNER_ULID, name: null }, appealText: '' }),
    ]);
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));

    expect(await screen.findByText('Avaliação')).toBeInTheDocument();
    const a = item(8);
    expect(a.getByText(/^de conta sem nome/)).toHaveTextContent(
      'de conta sem nome · ver perfil · 1 remoção na janela',
    );
    expect(a.getByText('Texto apagado com a conta do titular (LGPD).')).toHaveTextContent(
      `Contestação · ${dtm(APPEALED)}Texto apagado com a conta do titular (LGPD).`,
    );
    expect(a.queryByText('Nota da remoção')).not.toBeInTheDocument();

    // O diálogo da decisão diz o mesmo: sem nome e sem o texto da contestação.
    const dialog = await openDecision(user, 8, 'Manter');
    expect(
      dialog.getByText(`de conta sem nome · removida em ${dtm(REMOVED)} · Spam`),
    ).toBeInTheDocument();
    expect(dialog.getByText('Texto apagado com a conta do titular (LGPD).')).toHaveTextContent(
      'ContestaçãoTexto apagado com a conta do titular (LGPD).',
    );
  });

  it('avaliação e mensagem mostram o texto removido e não pedem imagem nenhuma', async () => {
    adminAppeals.mockResolvedValue([reviewAppeal(), messageAppeal()]);
    render(wrap(<AppealsSection />));

    expect(await screen.findByText('Mensagem no chat')).toBeInTheDocument();
    expect(item(8).getByText('Trabalho ruim, não recomendo.')).toHaveTextContent(
      'Conteúdo removidoTrabalho ruim, não recomendo.',
    );
    expect(item(8).getByText(`Removida em ${dtm(REMOVED)} · Spam`)).toBeInTheDocument();
    expect(item(9).getByText('Me chama no zap')).toHaveTextContent(
      'Conteúdo removidoMe chama no zap',
    );
    expect(
      item(9).getByText(`Removida em ${dtm(REMOVED)} · Tenta negociar fora da plataforma`),
    ).toBeInTheDocument();
    expect(thumb(8)).toBeNull();
    expect(thumb(9)).toBeNull();
    expect(adminAppealImage).not.toHaveBeenCalled();
  });

  it('a imagem em quarentena é buscada com o token e mostrada; ao sair da tela a URL é revogada', async () => {
    const { unmount } = render(wrap(<AppealsSection />));
    await screen.findByText('Foto de perfil');

    await waitFor(() => expect(thumb(7)).toHaveAttribute('src', BLOB_URL));
    expect(adminAppealImage).toHaveBeenCalledTimes(1);
    expect(adminAppealImage).toHaveBeenCalledWith(7);
    expect(createObjectURL).toHaveBeenCalledWith(expect.any(Blob));
    expect(revokeObjectURL).not.toHaveBeenCalled();

    unmount();
    expect(revokeObjectURL).toHaveBeenCalledWith(BLOB_URL);
  });

  it('sem arquivo guardado, a miniatura é só o ícone e nada é buscado', async () => {
    adminAppeals.mockResolvedValue([appeal({ hasImage: false })]);
    render(wrap(<AppealsSection />));

    await screen.findByText('Foto de perfil');
    expect(thumb(7)).toBeNull();
    expect(adminAppealImage).not.toHaveBeenCalled();
  });

  it('"Decididas" busca as decididas e mostra a decisão com a nota, sem botões', async () => {
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));
    await screen.findByText('Foto de perfil');
    adminAppeals.mockResolvedValue([
      appeal({
        status: 'upheld',
        hasImage: false,
        decidedAt: DECIDED,
        decisionNote: 'A regra é clara.',
      }),
      reviewAppeal({ status: 'overturned', decidedAt: DECIDED }),
    ]);

    await user.click(screen.getByRole('tab', { name: 'Decididas' }));

    expect(await screen.findByText('Mantida')).toBeInTheDocument();
    expect(adminAppeals).toHaveBeenLastCalledWith('decided');
    expect(screen.getByRole('tab', { name: 'Decididas' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('tab', { name: 'Pendentes' })).toHaveAttribute(
      'aria-selected',
      'false',
    );
    expect(item(7).getByText('A regra é clara.')).toHaveTextContent(
      `Decisão · ${dtm(DECIDED)}A regra é clara.`,
    );
    expect(item(8).getByText('Revertida')).toBeInTheDocument();
    expect(item(8).getByText('Sem nota.')).toHaveTextContent(`Decisão · ${dtm(DECIDED)}Sem nota.`);
    expect(screen.queryByRole('button', { name: 'Reverter' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Manter' })).not.toBeInTheDocument();
    // Mantida: o arquivo guardado foi apagado, não há miniatura.
    expect(thumb(7)).toBeNull();

    // De volta às pendentes, a fila pendente é buscada de novo e os botões reaparecem.
    adminAppeals.mockResolvedValue([appeal()]);
    await user.click(screen.getByRole('tab', { name: 'Pendentes' }));
    expect(await screen.findByRole('button', { name: 'Reverter' })).toBeInTheDocument();
    expect(adminAppeals).toHaveBeenLastCalledWith('pending');
    expect(screen.getByRole('tab', { name: 'Pendentes' })).toHaveAttribute('aria-selected', 'true');
  });

  it('revertida: a miniatura é a imagem pública que voltou ao ar; se não abre, cai no ícone', async () => {
    adminAppeals.mockResolvedValue([
      appeal({ status: 'overturned', hasImage: false, decidedAt: DECIDED }),
    ]);
    render(wrap(<AppealsSection />));
    await screen.findByText('Revertida');

    expect(thumb(7)).toHaveAttribute('src', `${MEDIA}?w=128`);
    expect(adminAppealImage).not.toHaveBeenCalled();

    fireEvent.error(thumb(7)!);
    expect(thumb(7)).toBeNull();
  });

  // Hoje a lista vazia não diz nada: o QueryState recebe `empty` sem `isEmpty` e desenha a lista
  // sem itens (defeito relatado, não corrigido aqui).
  it.todo('fila vazia diz "Nenhuma contestação esperando decisão."');
});

describe('AppealsSection: a decisão', () => {
  it('reverter imagem: mostra a imagem guardada, explica o efeito e manda a nota', async () => {
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 7, 'Reverter');
    expect(
      await dialog.findByRole('img', { name: 'Imagem removida: Foto de perfil' }),
    ).toHaveAttribute('src', BLOB_URL);
    // A miniatura e o diálogo usam a mesma cópia: uma busca só.
    expect(adminAppealImage).toHaveBeenCalledTimes(1);
    expect(
      dialog.getByText(`de Ana Souza · removida em ${dtm(REMOVED)} · Conteúdo ofensivo`),
    ).toBeInTheDocument();
    expect(dialog.getByText('A foto é minha e não tem nada de errado.')).toHaveTextContent(
      'ContestaçãoA foto é minha e não tem nada de errado.',
    );
    expect(
      dialog.getByText(
        'A imagem volta para onde estava, se o lugar continua vazio, sai da lista de bloqueio e a remoção deixa de contar para a reincidência. O dono recebe a sua nota.',
      ),
    ).toBeInTheDocument();
    const note = dialog.getByRole('textbox', { name: 'Nota para o dono' });
    expect(note).toHaveAttribute('maxlength', '500');
    await user.type(note, '  Era só uma foto de praia.  ');
    adminAppeals.mockResolvedValue([]);
    await user.click(dialog.getByRole('button', { name: 'Reverter e devolver a imagem' }));

    expect(
      await screen.findByText('Remoção revertida. A imagem voltou para o perfil.'),
    ).toBeInTheDocument();
    expect(adminDecideAppeal).toHaveBeenCalledTimes(1);
    expect(adminDecideAppeal).toHaveBeenCalledWith(7, 'overturn', {
      note: 'Era só uma foto de praia.',
    });
    // Decidida: o diálogo fecha e a fila é buscada de novo.
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(adminAppeals).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.queryByText('Foto de perfil')).not.toBeInTheDocument());
  });

  it('reverter avaliação: decide pelo texto removido, e o aviso diz que o conteúdo voltou', async () => {
    adminAppeals.mockResolvedValue([reviewAppeal()]);
    adminDecideAppeal.mockResolvedValue(decision({ imageRestored: false, contentRestored: true }));
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));
    await screen.findByText('Avaliação');

    const dialog = await openDecision(user, 8, 'Reverter');
    expect(dialog.getByText('Trabalho ruim, não recomendo.')).toHaveTextContent(
      'Conteúdo removidoTrabalho ruim, não recomendo.',
    );
    expect(dialog.queryByRole('img')).not.toBeInTheDocument();
    expect(
      dialog.getByText(
        'A avaliação volta ao perfil do freelancer e à nota média, e a remoção deixa de contar para a reincidência. O autor recebe a sua nota.',
      ),
    ).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Reverter e devolver o conteúdo' }));

    expect(
      await screen.findByText('Remoção revertida. O conteúdo voltou para onde estava.'),
    ).toBeInTheDocument();
    // Sem nota escrita, vai null (e não string vazia).
    expect(adminDecideAppeal).toHaveBeenCalledWith(8, 'overturn', { note: null });
  });

  it('reverter mensagem: fala do chat; se o conteúdo não pôde voltar, o aviso explica por quê', async () => {
    adminAppeals.mockResolvedValue([messageAppeal()]);
    adminDecideAppeal.mockResolvedValue(decision({ imageRestored: false, contentRestored: false }));
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));
    await screen.findByText('Mensagem no chat');

    const dialog = await openDecision(user, 9, 'Reverter');
    expect(
      dialog.getByText(
        'A mensagem volta ao chat das duas partes, e a remoção deixa de contar para a reincidência. O autor recebe a sua nota.',
      ),
    ).toBeInTheDocument();
    await user.click(dialog.getByRole('button', { name: 'Reverter e devolver o conteúdo' }));

    expect(
      await screen.findByText(
        'Remoção revertida. O conteúdo não foi recolocado: já havia outro no lugar ou o arquivo não existe mais.',
      ),
    ).toBeInTheDocument();
    expect(adminDecideAppeal).toHaveBeenCalledWith(9, 'overturn', { note: null });
  });

  it('manter imagem: avisa que o arquivo guardado é apagado, e nota só de espaços vai como null', async () => {
    adminDecideAppeal.mockResolvedValue(
      decision({
        status: 'upheld',
        imageRestored: false,
        contentRestored: false,
        fileDeleted: true,
      }),
    );
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 7, 'Manter');
    expect(
      dialog.getByText(
        'A imagem continua fora do ar, o arquivo guardado é apagado e a remoção continua contando para a reincidência. O dono recebe a sua nota.',
      ),
    ).toBeInTheDocument();
    await user.type(dialog.getByRole('textbox', { name: 'Nota para o dono' }), '   ');
    await user.click(dialog.getByRole('button', { name: 'Manter remoção' }));

    expect(
      await screen.findByText('Remoção mantida. O arquivo guardado foi apagado.'),
    ).toBeInTheDocument();
    expect(adminDecideAppeal).toHaveBeenCalledWith(7, 'uphold', { note: null });
  });

  it('manter avaliação: o conteúdo continua fora do ar, e o aviso é só "Remoção mantida."', async () => {
    adminAppeals.mockResolvedValue([reviewAppeal()]);
    adminDecideAppeal.mockResolvedValue(
      decision({
        status: 'upheld',
        imageRestored: false,
        contentRestored: false,
        fileDeleted: false,
      }),
    );
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));
    await screen.findByText('Avaliação');

    const dialog = await openDecision(user, 8, 'Manter');
    expect(
      dialog.getByText(
        'O conteúdo continua fora do ar e a remoção continua contando para a reincidência. O autor recebe a sua nota.',
      ),
    ).toBeInTheDocument();
    await user.type(dialog.getByRole('textbox', { name: 'Nota para o dono' }), 'É propaganda.');
    await user.click(dialog.getByRole('button', { name: 'Manter remoção' }));

    expect(await screen.findByText('Remoção mantida.')).toBeInTheDocument();
    expect(adminDecideAppeal).toHaveBeenCalledWith(8, 'uphold', { note: 'É propaganda.' });
  });

  it('no diálogo, enquanto a imagem guardada não chega diz que está carregando; quando chega, mostra', async () => {
    let release!: (r: { blob: Blob; fileName: string }) => void;
    adminAppealImage.mockReturnValue(
      new Promise<{ blob: Blob; fileName: string }>((r) => (release = r)),
    );
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 7, 'Reverter');

    expect(dialog.getByText('Carregando a imagem…')).toBeInTheDocument();
    expect(dialog.queryByRole('img')).not.toBeInTheDocument();
    expect(dialog.queryByText('O arquivo guardado já foi apagado.')).not.toBeInTheDocument();
    // Enquanto isso, a miniatura da fila é só o ícone.
    expect(thumb(7)).toBeNull();

    release({ blob: new Blob(['img']), fileName: 'contestacao-7' });
    expect(
      await dialog.findByRole('img', { name: 'Imagem removida: Foto de perfil' }),
    ).toHaveAttribute('src', BLOB_URL);
    expect(dialog.queryByText('Carregando a imagem…')).not.toBeInTheDocument();
    await waitFor(() => expect(thumb(7)).toHaveAttribute('src', BLOB_URL));
  });

  it('no diálogo, arquivo já apagado (ou que não abre) é dito em texto, sem imagem quebrada', async () => {
    adminAppealImage.mockRejectedValue(new Error('Erro 404 ao carregar a imagem'));
    adminAppeals.mockResolvedValue([
      appeal(),
      appeal({ id: 17, label: 'Trabalho “Logo”', targetType: 'portfolio_item', hasImage: false }),
    ]);
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));
    await screen.findByText('Trabalho “Logo”');

    const failed = await openDecision(user, 7, 'Manter');
    expect(await failed.findByText('O arquivo guardado já foi apagado.')).toBeInTheDocument();
    expect(failed.queryByRole('img')).not.toBeInTheDocument();
    await user.click(failed.getByRole('button', { name: 'Fechar' }));

    const gone = await openDecision(user, 17, 'Manter');
    expect(gone.getByText('O arquivo guardado já foi apagado.')).toBeInTheDocument();
    // Só a que tem arquivo guardado é pedida à API.
    expect(adminAppealImage).toHaveBeenCalledWith(7);
    expect(adminAppealImage).not.toHaveBeenCalledWith(17);
  });

  it('fechar o diálogo não decide nada, e reabrir começa com a nota em branco', async () => {
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));
    await screen.findByText('Foto de perfil');

    const first = await openDecision(user, 7, 'Manter');
    await user.type(first.getByRole('textbox', { name: 'Nota para o dono' }), 'rascunho');
    await user.click(first.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(adminDecideAppeal).not.toHaveBeenCalled();

    const second = await openDecision(user, 7, 'Reverter');
    expect(second.getByRole('textbox', { name: 'Nota para o dono' })).toHaveValue('');
  });

  it('Esc fecha o diálogo sem decidir, e a contestação continua na fila com os dois botões', async () => {
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 7, 'Manter');
    await user.type(dialog.getByRole('textbox', { name: 'Nota para o dono' }), 'rascunho');
    await user.keyboard('{Escape}');

    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(adminDecideAppeal).not.toHaveBeenCalled();
    expect(item(7).getByRole('button', { name: 'Reverter' })).toBeEnabled();
    expect(item(7).getByRole('button', { name: 'Manter' })).toBeEnabled();
    expect(adminAppeals).toHaveBeenCalledTimes(1);
  });

  it('a decisão vence a saúde da moderação e a fila de denúncias; o que não depende dela fica como está', async () => {
    const client = newClient();
    client.setQueryData(['moderationHealth', 30], { windowDays: 30 });
    client.setQueryData(['adminReports', 'pending'], []);
    client.setQueryData(['adminStorage'], { retentionDays: 90 });
    const invalidated = (key: readonly unknown[]) => client.getQueryState(key)?.isInvalidated;
    const user = userEvent.setup();
    render(wrap(<AppealsSection />, client));
    await screen.findByText('Foto de perfil');
    expect(invalidated(['moderationHealth', 30])).toBe(false);
    expect(invalidated(['adminReports', 'pending'])).toBe(false);

    const dialog = await openDecision(user, 7, 'Reverter');
    await user.click(dialog.getByRole('button', { name: 'Reverter e devolver a imagem' }));
    await screen.findByText('Remoção revertida. A imagem voltou para o perfil.');

    expect(invalidated(['moderationHealth', 30])).toBe(true);
    expect(invalidated(['adminReports', 'pending'])).toBe(true);
    expect(invalidated(['adminStorage'])).toBe(false);
    await waitFor(() => expect(adminAppeals).toHaveBeenCalledTimes(2));
  });

  it('enquanto grava, o botão do diálogo diz "Salvando…" e fica desabilitado', async () => {
    let release!: (r: AdminAppealDecisionResult) => void;
    adminDecideAppeal.mockImplementation(
      () => new Promise<AdminAppealDecisionResult>((r) => (release = r)),
    );
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 7, 'Reverter');
    await user.click(dialog.getByRole('button', { name: 'Reverter e devolver a imagem' }));
    expect(await dialog.findByRole('button', { name: 'Salvando…' })).toBeDisabled();

    release(decision());
    expect(
      await screen.findByText('Remoção revertida. A imagem voltou para o perfil.'),
    ).toBeInTheDocument();
  });

  it('recusa da API vira aviso com a mensagem dela, e o diálogo continua aberto com a nota', async () => {
    adminDecideAppeal.mockRejectedValue(new Error('Esta contestação já foi decidida.'));
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 7, 'Manter');
    await user.type(dialog.getByRole('textbox', { name: 'Nota para o dono' }), 'Mantida');
    await user.click(dialog.getByRole('button', { name: 'Manter remoção' }));

    expect(await screen.findByText('Esta contestação já foi decidida.')).toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Manter remoção' })).toBeInTheDocument();
    expect(dialog.getByRole('textbox', { name: 'Nota para o dono' })).toHaveValue('Mantida');
    // O botão volta ao normal, para o admin tentar de novo; nenhum aviso de sucesso, fila intacta.
    expect(dialog.getByRole('button', { name: 'Manter remoção' })).toBeEnabled();
    expect(screen.queryByText(/^Remoção mantida/)).not.toBeInTheDocument();
    expect(adminDecideAppeal).toHaveBeenCalledTimes(1);
    expect(adminDecideAppeal).toHaveBeenCalledWith(7, 'uphold', { note: 'Mantida' });
    expect(adminAppeals).toHaveBeenCalledTimes(1);
  });

  it('falha sem mensagem cai no aviso genérico', async () => {
    adminDecideAppeal.mockRejectedValue('timeout');
    const user = userEvent.setup();
    render(wrap(<AppealsSection />));
    await screen.findByText('Foto de perfil');

    const dialog = await openDecision(user, 7, 'Manter');
    await user.click(dialog.getByRole('button', { name: 'Manter remoção' }));

    expect(await screen.findByText('Não foi possível registrar a decisão')).toBeInTheDocument();
  });
});
