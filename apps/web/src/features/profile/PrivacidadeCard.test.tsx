import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { Consent, DataDeletionRequest, DataExportRequest } from '@escambo/types';
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { PrivacidadeCard } from './PrivacidadeCard';
import { dt, dtm } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';

/**
 * Direitos do titular (LGPD): a cópia dos dados (pedir e baixar), o pedido de exclusão da conta —
 * que só sai depois da confirmação — e sair de todos os dispositivos. As datas saem pelo `dt` e
 * pelo `dtm` do app (fuso de quem roda o teste).
 */

const consents = vi.fn();
const exportRequests = vi.fn();
const deletionRequests = vi.fn();
const requestExport = vi.fn();
const requestDeletion = vi.fn();
const downloadExport = vi.fn();
const logoutAll = vi.fn();
vi.mock('../../lib/api', () => ({
  api: {
    consents: () => consents(),
    exportRequests: () => exportRequests(),
    deletionRequests: () => deletionRequests(),
    requestExport: (...args: unknown[]) => requestExport(...args),
    requestDeletion: (reason: unknown) => requestDeletion(reason),
    downloadExport: (id: number) => downloadExport(id),
    logoutAll: (...args: unknown[]) => logoutAll(...args),
  },
}));

const logout = vi.fn();
vi.mock('../../lib/auth', () => ({ useAuth: () => ({ logout }) }));

/** O download por âncora é do navegador (lib/download tem o teste dele): aqui só o que é entregue. */
const saveBlob = vi.fn();
vi.mock('../../lib/download', () => ({
  saveBlob: (blob: Blob, name: string) => saveBlob(blob, name),
}));

const CREATED = '2026-09-20T15:00:00.000Z';
const EXPIRES = '2026-09-27T15:00:00.000Z';

const exportRequest = (o: Partial<DataExportRequest> = {}): DataExportRequest => ({
  id: 5,
  status: 'ready',
  downloadUrl: '/api/lgpd/export-requests/5/download',
  expiresAt: EXPIRES,
  createdAt: CREATED,
  processedAt: CREATED,
  ...o,
});

const deletionRequest = (o: Partial<DataDeletionRequest> = {}): DataDeletionRequest => ({
  id: 3,
  reason: null,
  status: 'pending',
  adminNote: null,
  createdAt: CREATED,
  processedAt: null,
  ...o,
});

function renderCard(): void {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <PrivacidadeCard />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const exportsList = (): Promise<HTMLElement> =>
  screen.findByRole('list', { name: 'Exportações solicitadas' });
const deletionsList = (): Promise<HTMLElement> =>
  screen.findByRole('list', { name: 'Exclusões solicitadas' });
const exportButton = (): HTMLElement =>
  screen.getByRole('button', { name: 'Solicitar exportação dos meus dados' });
const deleteButton = (): HTMLElement =>
  screen.getByRole('button', { name: 'Solicitar exclusão da conta' });

let confirm: MockInstance<typeof window.confirm>;

beforeEach(() => {
  for (const fn of [
    consents,
    exportRequests,
    deletionRequests,
    requestExport,
    requestDeletion,
    downloadExport,
    logoutAll,
    logout,
    saveBlob,
  ]) {
    fn.mockReset();
  }
  consents.mockResolvedValue([]);
  exportRequests.mockResolvedValue([]);
  deletionRequests.mockResolvedValue([]);
  confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
});

afterEach(() => {
  confirm.mockRestore();
});

describe('privacidade: o que o cartão mostra', () => {
  it('explica os dois direitos e, enquanto as listas carregam, mostra o esqueleto de cada uma', async () => {
    let soltaExportacoes!: (v: DataExportRequest[]) => void;
    let soltaExclusoes!: (v: DataDeletionRequest[]) => void;
    exportRequests.mockReturnValue(new Promise((r) => (soltaExportacoes = r)));
    deletionRequests.mockReturnValue(new Promise((r) => (soltaExclusoes = r)));
    renderCard();

    expect(screen.getByRole('heading', { name: 'Privacidade e dados (LGPD)' })).toBeInTheDocument();
    expect(
      screen.getByText(
        /Você pode baixar uma cópia de tudo que o Escambo guarda sobre você \(JSON, disponível por 7 dias\) e pedir a exclusão da conta\./,
      ),
    ).toBeInTheDocument();
    expect(screen.getAllByRole('status', { name: 'Carregando' })).toHaveLength(2);
    expect(screen.queryByRole('list', { name: 'Exportações solicitadas' })).not.toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Exclusões solicitadas' })).not.toBeInTheDocument();

    // Cada lista sai do esqueleto quando a sua consulta volta, sem esperar a outra.
    soltaExportacoes([exportRequest({ id: 1 })]);
    expect(await exportsList()).toHaveTextContent('pronta');
    expect(screen.getAllByRole('status', { name: 'Carregando' })).toHaveLength(1);

    soltaExclusoes([deletionRequest({ id: 2, status: 'completed' })]);
    expect(await deletionsList()).toHaveTextContent('concluída');
    expect(screen.queryByRole('status', { name: 'Carregando' })).not.toBeInTheDocument();
  });

  it('sem pedido nenhum, nenhum pedido é listado e os dois pedidos ficam liberados', async () => {
    renderCard();

    await waitFor(() =>
      expect(screen.queryByRole('status', { name: 'Carregando' })).not.toBeInTheDocument(),
    );
    expect(screen.queryAllByRole('listitem')).toHaveLength(0);
    expect(exportButton()).toBeEnabled();
    expect(deleteButton()).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Baixar' })).not.toBeInTheDocument();
    // Sem consentimento registrado, a lista de consentimentos nem aparece.
    expect(screen.queryByRole('list', { name: 'Consentimentos' })).not.toBeInTheDocument();
  });

  // Defeito de produção: PrivacidadeCard.tsx passa `empty` ao QueryState das duas listas (linhas
  // 147 e 193), mas não passa `isEmpty`; sem ele o QueryState nunca mostra o estado vazio, e a
  // tela fica com uma lista vazia, sem as frases abaixo.
  it.todo(
    'sem pedido nenhum, diz "Nenhuma exportação solicitada." e "Nenhuma exclusão solicitada." (falta isEmpty no QueryState)',
  );

  it('consentimentos: o documento, a versão e se foi aceito ou recusado, com a data', async () => {
    const at = '2026-09-01T12:00:00.000Z';
    const list: Consent[] = [
      { type: 'terms_of_use', version: '1.2', accepted: true, at },
      { type: 'privacy_policy', version: '2.0', accepted: true, at },
      { type: 'marketing', version: '1.0', accepted: false, at },
      { type: 'data_processing', version: '1.0', accepted: true, at },
      { type: 'cookies' as Consent['type'], version: '3', accepted: true, at },
    ];
    consents.mockResolvedValue(list);
    renderCard();

    const itens = within(await screen.findByRole('list', { name: 'Consentimentos' })).getAllByRole(
      'listitem',
    );
    expect(itens.map((li) => li.textContent)).toEqual([
      `Termos de Uso · v1.2aceito em ${dtm(at)}`,
      `Política de Privacidade · v2.0aceito em ${dtm(at)}`,
      `Comunicações de marketing · v1.0recusado em ${dtm(at)}`,
      `Tratamento de dados · v1.0aceito em ${dtm(at)}`,
      // Tipo que a tela não conhece aparece como veio.
      `cookies · v3aceito em ${dtm(at)}`,
    ]);
  });

  it('exportações: a data, a situação de cada uma e o Baixar só onde há arquivo', async () => {
    exportRequests.mockResolvedValue([
      exportRequest({ id: 1, status: 'ready' }),
      exportRequest({ id: 2, status: 'downloaded' }),
      exportRequest({ id: 3, status: 'pending', downloadUrl: null, expiresAt: null }),
      exportRequest({ id: 4, status: 'processing', downloadUrl: null, expiresAt: null }),
      exportRequest({ id: 5, status: 'expired', downloadUrl: null }),
      exportRequest({ id: 6, status: 'failed', downloadUrl: null, expiresAt: null }),
    ]);
    renderCard();

    const itens = within(await exportsList()).getAllByRole('listitem');
    const pedido = `Exportação · ${dtm(CREATED)}`;
    const validade = ` · válida até ${dt(EXPIRES)}`;
    expect(itens.map((li) => li.textContent)).toEqual([
      `${pedido}${validade}pronta Baixar`,
      `${pedido}${validade}baixada Baixar`,
      `${pedido}gerando`,
      `${pedido}gerando`,
      // Expirada não tem mais arquivo: nem a validade nem o botão.
      `${pedido}expirada`,
      `${pedido}falhou`,
    ]);
    expect(screen.getAllByRole('button', { name: 'Baixar' })).toHaveLength(2);
  });

  it('exclusões: a situação de cada pedido e o motivo da recusa', async () => {
    deletionRequests.mockResolvedValue([
      deletionRequest({
        id: 1,
        status: 'rejected',
        adminNote: 'Há uma contratação em andamento.',
      }),
      deletionRequest({ id: 2, status: 'completed', adminNote: 'nota que não é de recusa' }),
      deletionRequest({ id: 3, status: 'processing' }),
      deletionRequest({ id: 4, status: 'rejected', adminNote: null }),
    ]);
    renderCard();

    const itens = within(await deletionsList()).getAllByRole('listitem');
    const pedido = `Exclusão · ${dtm(CREATED)}`;
    expect(itens.map((li) => li.textContent)).toEqual([
      `${pedido} · Há uma contratação em andamento.recusada`,
      `${pedido}concluída`,
      `${pedido}em processamento`,
      `${pedido}recusada`,
    ]);
    // Nenhum pedido em análise: dá para pedir de novo.
    expect(deleteButton()).toBeEnabled();
  });

  it('lista que não carrega mostra o erro e tenta de novo pelo botão', async () => {
    const user = userEvent.setup();
    exportRequests.mockRejectedValueOnce(new Error('Não foi possível listar as exportações'));
    renderCard();

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('Não foi possível listar as exportações');
    // A outra lista não depende desta.
    expect(await deletionsList()).toBeInTheDocument();

    exportRequests.mockResolvedValue([exportRequest({ status: 'ready' })]);
    await user.click(within(alerta).getByRole('button', { name: 'Tentar de novo' }));

    expect(await within(await exportsList()).findByText('pronta')).toBeInTheDocument();
    expect(exportRequests).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('a lista de exclusões também mostra o erro dela e tenta de novo', async () => {
    const user = userEvent.setup();
    deletionRequests.mockRejectedValueOnce(new Error('Não foi possível listar as exclusões'));
    renderCard();

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent('Não foi possível listar as exclusões');

    deletionRequests.mockResolvedValue([deletionRequest({ status: 'completed' })]);
    await user.click(within(alerta).getByRole('button', { name: 'Tentar de novo' }));

    expect(await within(await deletionsList()).findByText('concluída')).toBeInTheDocument();
    expect(deletionRequests).toHaveBeenCalledTimes(2);
  });
});

describe('privacidade: cópia dos meus dados', () => {
  it('pedir a exportação que já sai pronta avisa do download e recarrega a lista', async () => {
    const user = userEvent.setup();
    requestExport.mockResolvedValue(exportRequest({ status: 'ready' }));
    renderCard();
    await exportsList();

    await user.click(exportButton());

    expect(
      await screen.findByText('Sua cópia de dados está pronta para download.'),
    ).toBeInTheDocument();
    expect(requestExport).toHaveBeenCalledTimes(1);
    expect(requestExport).toHaveBeenCalledWith();
    await waitFor(() => expect(exportRequests).toHaveBeenCalledTimes(2));
    // Pedir a cópia não mexe nos pedidos de exclusão.
    expect(requestDeletion).not.toHaveBeenCalled();
  });

  it('exportação que fica na fila avisa que o arquivo vem depois', async () => {
    const user = userEvent.setup();
    requestExport.mockResolvedValue(
      exportRequest({ status: 'pending', downloadUrl: null, expiresAt: null }),
    );
    renderCard();
    await exportsList();

    await user.click(exportButton());

    expect(
      await screen.findByText(
        'Exportação solicitada. Você será avisado quando o arquivo estiver pronto.',
      ),
    ).toBeInTheDocument();
  });

  it('enquanto a exportação é gerada, o botão diz Gerando… e não aceita outro pedido', async () => {
    const user = userEvent.setup();
    let solta!: (v: DataExportRequest) => void;
    requestExport.mockImplementation(() => new Promise<DataExportRequest>((r) => (solta = r)));
    renderCard();
    await exportsList();

    await user.click(exportButton());

    const gerando = await screen.findByRole('button', { name: 'Gerando…' });
    expect(gerando).toBeDisabled();
    await user.click(gerando);
    expect(requestExport).toHaveBeenCalledTimes(1);

    solta(exportRequest());
    await waitFor(() => expect(exportButton()).toBeEnabled());
  });

  it('recusa da API ao pedir a exportação mostra a mensagem dela', async () => {
    const user = userEvent.setup();
    requestExport.mockRejectedValue(new Error('Já existe uma exportação em andamento.'));
    renderCard();
    await exportsList();

    await user.click(exportButton());

    expect(await screen.findByText('Já existe uma exportação em andamento.')).toBeInTheDocument();
    expect(exportRequests).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(exportButton()).toBeEnabled());
  });

  it('falha sem mensagem ao pedir a exportação cai no texto padrão', async () => {
    const user = userEvent.setup();
    requestExport.mockRejectedValue('sem rede');
    renderCard();
    await exportsList();

    await user.click(exportButton());

    expect(await screen.findByText('Erro ao solicitar exportação')).toBeInTheDocument();
  });

  it('Baixar busca o arquivo daquele pedido, entrega com o nome que veio e recarrega a lista', async () => {
    const user = userEvent.setup();
    const blob = new Blob(['{"usuario":1}'], { type: 'application/json' });
    exportRequests.mockResolvedValue([
      exportRequest({ id: 8, status: 'ready' }),
      exportRequest({ id: 9, status: 'ready' }),
    ]);
    downloadExport.mockResolvedValue({ blob, fileName: 'escambo-dados-9.json' });
    renderCard();
    const itens = within(await exportsList()).getAllByRole('listitem');

    await user.click(within(itens[1]!).getByRole('button', { name: 'Baixar' }));

    await waitFor(() => expect(saveBlob).toHaveBeenCalledTimes(1));
    expect(downloadExport).toHaveBeenCalledTimes(1);
    expect(downloadExport).toHaveBeenCalledWith(9);
    expect(saveBlob).toHaveBeenCalledWith(blob, 'escambo-dados-9.json');
    // A situação muda para "baixada" no servidor: a lista é lida de novo.
    await waitFor(() => expect(exportRequests).toHaveBeenCalledTimes(2));
  });

  it('durante o download só o botão daquele pedido fica em Baixando…', async () => {
    const user = userEvent.setup();
    let solta!: (v: { blob: Blob; fileName: string }) => void;
    exportRequests.mockResolvedValue([exportRequest({ id: 8 }), exportRequest({ id: 9 })]);
    downloadExport.mockImplementation(() => new Promise((r) => (solta = r)));
    renderCard();
    const itens = within(await exportsList()).getAllByRole('listitem');

    await user.click(within(itens[0]!).getByRole('button', { name: 'Baixar' }));

    expect(within(itens[0]!).getByRole('button', { name: 'Baixando…' })).toBeDisabled();
    expect(within(itens[1]!).getByRole('button', { name: 'Baixar' })).toBeEnabled();
    expect(saveBlob).not.toHaveBeenCalled();

    solta({ blob: new Blob(['{}']), fileName: 'escambo-dados-8.json' });
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Baixando…' })).not.toBeInTheDocument(),
    );
    expect(screen.getAllByRole('button', { name: 'Baixar' })).toHaveLength(2);
  });

  it('download recusado mostra a mensagem, não entrega arquivo e libera o botão', async () => {
    const user = userEvent.setup();
    exportRequests.mockResolvedValue([exportRequest({ id: 8 })]);
    downloadExport.mockRejectedValue(new Error('Exportação expirada'));
    renderCard();
    await exportsList();

    await user.click(screen.getByRole('button', { name: 'Baixar' }));

    expect(await screen.findByText('Exportação expirada')).toBeInTheDocument();
    expect(saveBlob).not.toHaveBeenCalled();
    expect(exportRequests).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'Baixar' })).toBeEnabled();
  });

  it('falha sem mensagem no download cai no texto padrão', async () => {
    const user = userEvent.setup();
    exportRequests.mockResolvedValue([exportRequest({ id: 8 })]);
    downloadExport.mockRejectedValue('sem rede');
    renderCard();
    await exportsList();

    await user.click(screen.getByRole('button', { name: 'Baixar' }));

    expect(await screen.findByText('Erro ao baixar')).toBeInTheDocument();
  });
});

describe('privacidade: exclusão da conta', () => {
  it('pede confirmação dizendo que não pode ser desfeito; recusada a confirmação, nada é pedido', async () => {
    const user = userEvent.setup();
    confirm.mockReturnValue(false);
    renderCard();
    await deletionsList();

    await user.click(deleteButton());

    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm).toHaveBeenCalledWith(
      'Pedir a exclusão da sua conta e dos seus dados? Isso é analisado pela plataforma e não pode ser desfeito depois de concluído.',
    );
    expect(requestDeletion).not.toHaveBeenCalled();
    expect(screen.queryByText(/^Exclusão solicitada/)).not.toBeInTheDocument();
    expect(deletionRequests).toHaveBeenCalledTimes(1);
  });

  it('confirmada, pede a exclusão sem motivo, avisa do e-mail e recarrega a lista', async () => {
    const user = userEvent.setup();
    requestDeletion.mockResolvedValue(deletionRequest());
    renderCard();
    await deletionsList();

    await user.click(deleteButton());

    expect(
      await screen.findByText('Exclusão solicitada. Você receberá a confirmação por e-mail.'),
    ).toBeInTheDocument();
    expect(requestDeletion).toHaveBeenCalledTimes(1);
    expect(requestDeletion).toHaveBeenCalledWith(null);
    await waitFor(() => expect(deletionRequests).toHaveBeenCalledTimes(2));
    // Pedir a exclusão não encerra a sessão nem pede exportação.
    expect(logout).not.toHaveBeenCalled();
    expect(requestExport).not.toHaveBeenCalled();
  });

  it('com um pedido em análise, o botão vira "Exclusão em análise" e não aceita outro', async () => {
    const user = userEvent.setup();
    deletionRequests.mockResolvedValue([deletionRequest({ status: 'pending' })]);
    renderCard();

    expect(await within(await deletionsList()).findByText('em análise')).toBeInTheDocument();
    const botao = screen.getByRole('button', { name: 'Exclusão em análise' });
    expect(botao).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Solicitar exclusão da conta' }),
    ).not.toBeInTheDocument();

    await user.click(botao);
    expect(confirm).not.toHaveBeenCalled();
    expect(requestDeletion).not.toHaveBeenCalled();
  });

  it('enquanto o pedido de exclusão é enviado, o botão fica travado', async () => {
    const user = userEvent.setup();
    let solta!: (v: DataDeletionRequest) => void;
    requestDeletion.mockImplementation(() => new Promise<DataDeletionRequest>((r) => (solta = r)));
    renderCard();
    await deletionsList();

    await user.click(deleteButton());

    await waitFor(() => expect(deleteButton()).toBeDisabled());
    expect(screen.queryByText(/^Exclusão solicitada/)).not.toBeInTheDocument();

    solta(deletionRequest());
    expect(
      await screen.findByText('Exclusão solicitada. Você receberá a confirmação por e-mail.'),
    ).toBeInTheDocument();
  });

  it('recusa da API ao pedir a exclusão mostra a mensagem dela e libera o botão', async () => {
    const user = userEvent.setup();
    requestDeletion.mockRejectedValue(new Error('Há saldo na carteira: saque antes de excluir.'));
    renderCard();
    await deletionsList();

    await user.click(deleteButton());

    expect(
      await screen.findByText('Há saldo na carteira: saque antes de excluir.'),
    ).toBeInTheDocument();
    expect(screen.queryByText(/^Exclusão solicitada/)).not.toBeInTheDocument();
    expect(deletionRequests).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(deleteButton()).toBeEnabled());
  });

  it('falha sem mensagem ao pedir a exclusão cai no texto padrão', async () => {
    const user = userEvent.setup();
    requestDeletion.mockRejectedValue('sem rede');
    renderCard();
    await deletionsList();

    await user.click(deleteButton());

    expect(await screen.findByText('Erro ao solicitar exclusão')).toBeInTheDocument();
  });
});

describe('privacidade: sair de todos os dispositivos', () => {
  const everywhere = (): HTMLElement =>
    screen.getByRole('button', { name: 'Sair de todos os dispositivos' });

  it('pede confirmação; recusada, nenhuma sessão é encerrada', async () => {
    const user = userEvent.setup();
    confirm.mockReturnValue(false);
    renderCard();

    await user.click(everywhere());

    expect(confirm).toHaveBeenCalledWith(
      'Sair de todos os dispositivos? Você precisará entrar de novo em cada um.',
    );
    expect(logoutAll).not.toHaveBeenCalled();
    expect(logout).not.toHaveBeenCalled();
  });

  it('confirmada, revoga as sessões, diz quantas e sai daqui também', async () => {
    const user = userEvent.setup();
    logoutAll.mockResolvedValue({ revoked: 3 });
    renderCard();
    expect(screen.getByText('Encerra todas as sessões abertas, inclusive esta.')).toBeVisible();

    await user.click(everywhere());

    expect(await screen.findByText('3 sessão(ões) encerrada(s).')).toBeInTheDocument();
    expect(logoutAll).toHaveBeenCalledTimes(1);
    expect(logoutAll).toHaveBeenCalledWith();
    expect(logout).toHaveBeenCalledTimes(1);
    expect(logout).toHaveBeenCalledWith();
  });

  it('se a API recusa, mostra a mensagem e a sessão daqui continua', async () => {
    const user = userEvent.setup();
    logoutAll.mockRejectedValue(new Error('Sessão expirada'));
    renderCard();

    await user.click(everywhere());

    expect(await screen.findByText('Sessão expirada')).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
  });

  it('falha sem mensagem cai no texto padrão', async () => {
    const user = userEvent.setup();
    logoutAll.mockRejectedValue('sem rede');
    renderCard();

    await user.click(everywhere());

    expect(await screen.findByText('Erro ao encerrar sessões')).toBeInTheDocument();
    expect(logout).not.toHaveBeenCalled();
  });
});
