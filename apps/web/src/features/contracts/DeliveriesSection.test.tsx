import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ContractDelivery, ContractWithHistory, DeliveryAttachment } from '@escambo/types';
import { describe, expect, it, vi } from 'vitest';
import { dtm, formatBytes } from '../../lib/format';
import { ToastProvider } from '../../lib/toast';
import { DeliveriesSection, DeliveryFiles, safeHref } from './DeliveriesSection';

const attachmentBlob = vi.fn();
vi.mock('../../lib/api', () => ({
  api: { attachmentBlob: (url: string, name: string) => attachmentBlob(url, name) },
}));
const saveBlob = vi.fn();
vi.mock('../../lib/download', () => ({
  saveBlob: (blob: Blob, name: string) => saveBlob(blob, name),
}));

/**
 * Entregas na Sala (RF-035): a mensagem e os links de cada entrega única, com as reentregas, para
 * as duas partes; só endereço http(s) vira link.
 */

const CLIENT = 1;
const FREELANCER = 2;

const delivery = (o: Partial<ContractDelivery> & { id: number }): ContractDelivery => ({
  message: 'Segue a entrega.',
  files: [],
  deliveredAt: '2026-10-02T15:00:00.000Z',
  ...o,
});

/** Arquivo de uma entrega como a API devolve: um anexo do chat do par. */
const file = (o: Partial<DeliveryAttachment> & { messageId: number }): DeliveryAttachment => ({
  name: 'final.pdf',
  mime: 'application/pdf',
  size: 204_800,
  url: `/api/messaging/attachments/${o.messageId}`,
  purgedAt: null,
  purgedReason: null,
  removedAt: null,
  sentAt: '2026-10-04T18:30:00.000Z',
  ...o,
});

/** Só o que a seção lê da contratação. */
const contract = (deliveries?: ContractDelivery[]): ContractWithHistory =>
  ({ clientId: CLIENT, freelancerId: FREELANCER, deliveries }) as ContractWithHistory;

describe('DeliveriesSection', () => {
  it('sem entrega (ou API anterior, sem o campo), a seção não aparece', () => {
    const { container, rerender } = render(
      <DeliveriesSection contract={contract([])} myId={CLIENT} />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<DeliveriesSection contract={contract(undefined)} myId={CLIENT} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('o cliente lê cada entrega, da reentrega mais recente à primeira, com mensagem, data e links', () => {
    render(
      <DeliveriesSection
        contract={contract([
          delivery({
            id: 3,
            message: 'Primeira versão.\nO roteiro está no link.',
            files: ['https://cdn.escambo.test/v1.mp4'],
            deliveredAt: '2026-10-02T15:00:00.000Z',
          }),
          delivery({ id: 5, message: 'Trilha trocada.', deliveredAt: '2026-10-04T18:30:00.000Z' }),
        ])}
        myId={CLIENT}
      />,
    );

    const section = screen.getByRole('region', { name: 'Entregas' });
    expect(within(section).getByText('2 entregas')).toBeInTheDocument();
    expect(
      within(section).getByText(
        'O que o freelancer mandou em cada entrega. Os arquivos também ficam no chat, e outros podem ter vindo por lá.',
      ),
    ).toBeInTheDocument();

    const items = within(
      screen.getByRole('list', { name: 'Entregas, da mais recente à primeira' }),
    ).getAllByRole('listitem');
    expect(items).toHaveLength(2);
    expect(items[0]).toHaveTextContent('Entrega 2 (reentrega) · mais recente');
    expect(items[0]).toHaveTextContent(dtm('2026-10-04T18:30:00.000Z'));
    expect(items[0]).toHaveTextContent('Trilha trocada.');
    expect(within(items[0]!).queryByRole('link')).not.toBeInTheDocument();

    expect(items[1]).toHaveTextContent('Entrega 1');
    expect(items[1]).not.toHaveTextContent('reentrega');
    expect(items[1]).toHaveTextContent(dtm('2026-10-02T15:00:00.000Z'));
    // A quebra de linha da mensagem é mantida.
    const message = within(items[1]!).getByText(/^Primeira versão\./);
    expect(message.textContent).toBe('Primeira versão.\nO roteiro está no link.');
    expect(message).toHaveStyle({ whiteSpace: 'pre-wrap' });
    const link = within(items[1]!).getByRole('link', { name: /cdn\.escambo\.test\/v1\.mp4/ });
    expect(link).toHaveAttribute('href', 'https://cdn.escambo.test/v1.mp4');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  });

  it('o freelancer vê o mesmo, com o texto de quem entregou; uma entrega só não diz "mais recente"', () => {
    render(
      <DeliveriesSection
        contract={contract([delivery({ id: 3, message: 'Pronto.' })])}
        myId={FREELANCER}
      />,
    );
    expect(screen.getByText('1 entrega')).toBeInTheDocument();
    expect(
      screen.getByText('O que você mandou em cada entrega; o cliente vê o mesmo.'),
    ).toBeInTheDocument();
    expect(screen.getByTestId('delivery-1')).toHaveTextContent('Entrega 1');
    expect(screen.queryByText(/mais recente/)).not.toBeInTheDocument();
  });

  it('endereço que não é http(s) aparece como texto, sem link', () => {
    render(
      <DeliveriesSection
        contract={contract([
          delivery({
            id: 3,
            files: ['javascript:alert(1)', 'http://drive.escambo.test/pasta'],
          }),
        ])}
        myId={CLIENT}
      />,
    );
    expect(screen.getByText('javascript:alert(1)')).toBeInTheDocument();
    expect(screen.getByText('(endereço sem http, não abre)')).toBeInTheDocument();
    expect(screen.getAllByRole('link').map((a) => a.getAttribute('href'))).toEqual([
      'http://drive.escambo.test/pasta',
    ]);
  });

  it('os arquivos de cada entrega (RF-035): nome, tamanho e o download com o token', async () => {
    const user = userEvent.setup();
    const blob = new Blob(['pdf']);
    attachmentBlob.mockResolvedValue({ blob, fileName: 'final.pdf' });
    render(
      <ToastProvider>
        <DeliveriesSection
          contract={contract([
            delivery({
              id: 3,
              attachments: [file({ messageId: 40, name: 'rascunho.png', mime: 'image/png' })],
            }),
            delivery({
              id: 5,
              attachments: [file({ messageId: 41 }), file({ messageId: 42, name: 'fontes.zip' })],
            }),
          ])}
          myId={CLIENT}
        />
      </ToastProvider>,
    );

    const [latest, first] = screen.getAllByTestId(/^delivery-[0-9]$/);
    expect(within(latest!).getByText('Arquivos da entrega:')).toBeInTheDocument();
    expect(
      within(latest!)
        .getAllByRole('button')
        .map((b) => b.textContent),
    ).toEqual([
      `Baixar final.pdf ${formatBytes(204_800)}`,
      `Baixar fontes.zip ${formatBytes(204_800)}`,
    ]);
    expect(latest).toHaveTextContent(formatBytes(204_800));
    expect(within(first!).getByText('Arquivo da entrega:')).toBeInTheDocument();
    expect(within(first!).getByRole('button', { name: /^Baixar rascunho\.png / })).toBeVisible();

    await user.click(within(latest!).getByRole('button', { name: /^Baixar final\.pdf / }));
    await waitFor(() => expect(saveBlob).toHaveBeenCalledWith(blob, 'final.pdf'));
    expect(attachmentBlob).toHaveBeenCalledWith('/api/messaging/attachments/41', 'final.pdf');
  });

  it('arquivo expurgado aparece riscado com o motivo; removido pela moderação, só o aviso', () => {
    render(
      <ToastProvider>
        <DeliveryFiles
          attachments={[
            file({
              messageId: 50,
              name: 'antigo.pdf',
              purgedAt: '2026-10-01T00:00:00.000Z',
              purgedReason: 'retention',
            }),
            file({ messageId: 51, name: '', size: 0, removedAt: '2026-10-02T00:00:00.000Z' }),
          ]}
        />
      </ToastProvider>,
    );
    expect(screen.getByTestId('attachment-purged')).toHaveTextContent(
      'antigo.pdfremovido pela política de retenção',
    );
    expect(screen.getByTestId('delivery-file-removed')).toHaveTextContent(
      'Arquivo removido pela moderação',
    );
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('sem arquivo, a lista de arquivos não aparece', () => {
    const { container } = render(<DeliveryFiles attachments={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('safeHref: só http e https', () => {
    expect(safeHref('https://a.test/x y')).toBe('https://a.test/x%20y');
    expect(safeHref('http://a.test')).toBe('http://a.test/');
    expect(safeHref('data:text/html,oi')).toBeNull();
    expect(safeHref('não é endereço')).toBeNull();
  });
});
