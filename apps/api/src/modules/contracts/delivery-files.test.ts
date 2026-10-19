import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../config/db', async () => (await import('../../test-support/fake-db')).dbModule);

import { fakeDb } from '../../test-support/fake-db';
import {
  attachmentsOf,
  deliveryFilesRepository,
  toDeliveryAttachment,
  type DeliveryFileRow,
} from './delivery-files';

/**
 * Arquivos da entrega (RF-035): cada um vira uma mensagem de anexo do chat do par, ligada à
 * entrega única ou ao marco, dentro da transação de quem chama; a Sala lê todos de uma vez.
 */

const stored = (key: string, kind: 'image' | 'file' = 'file') => ({
  key,
  kind,
  name: `${key}.pdf`,
  mime: kind === 'image' ? 'image/png' : 'application/pdf',
  size: 1234,
});

const row = (
  o: Partial<Omit<DeliveryFileRow, 'constructor'>> & { message_id: number },
): DeliveryFileRow =>
  ({
    delivery_id: 3,
    milestone_id: null,
    file_name: 'final.pdf',
    file_mime: 'application/pdf',
    file_size_bytes: '2048',
    file_purged_at: null,
    file_purged_reason: null,
    removed_at: null,
    created_at: new Date('2026-10-04T18:30:00Z'),
    ...o,
  }) as unknown as DeliveryFileRow;

beforeEach(() => fakeDb.reset());

describe('deliveryFilesRepository.attach', () => {
  it('grava uma mensagem por arquivo na conversa do par e liga todas à entrega única', async () => {
    fakeDb.reply({ insertId: 40 }, { insertId: 41 }, {}, {});
    const ids = await deliveryFilesRepository.attach(
      fakeDb.conn as never,
      { contractId: 9, deliveryId: 3 },
      { conversationId: 5, senderId: 2, files: [stored('a', 'image'), stored('b')] },
    );

    expect(ids).toEqual([40, 41]);
    expect(fakeDb.calls.map((c) => c.sql.slice(0, 32))).toEqual([
      'INSERT INTO messages (conversati',
      'INSERT INTO messages (conversati',
      'UPDATE conversations SET last_me',
      'INSERT INTO delivery_files (mess',
    ]);
    expect(fakeDb.calls[0]!.params).toEqual({
      conversationId: 5,
      senderId: 2,
      type: 'image',
      fileKey: 'a',
      fileName: 'a.pdf',
      fileMime: 'image/png',
      fileSize: 1234,
    });
    // Sem legenda: a mensagem do arquivo não tem texto.
    expect(fakeDb.calls[0]!.sql).toContain(':type, NULL, :fileKey');
    expect(fakeDb.calls[2]!.params).toEqual({ conversationId: 5 });
    expect(fakeDb.calls[3]!.sql).toBe(
      'INSERT INTO delivery_files (message_id, contract_id, delivery_id, milestone_id) VALUES (:m0, :contractId, :deliveryId, :milestoneId), (:m1, :contractId, :deliveryId, :milestoneId)',
    );
    expect(fakeDb.calls[3]!.params).toEqual({
      contractId: 9,
      deliveryId: 3,
      milestoneId: null,
      m0: 40,
      m1: 41,
    });
    // Tudo na conexão da transação da entrega, nada pelo pool.
    expect(fakeDb.pool.getConnection).not.toHaveBeenCalled();
  });

  it('no marco, a ligação vai pelo milestone_id; sem arquivo, nada é gravado', async () => {
    fakeDb.reply({ insertId: 50 });
    await deliveryFilesRepository.attach(
      fakeDb.conn as never,
      { contractId: 9, milestoneId: 7 },
      { conversationId: 5, senderId: 2, files: [stored('c')] },
    );
    expect(fakeDb.calls.at(-1)!.params).toEqual({
      contractId: 9,
      deliveryId: null,
      milestoneId: 7,
      m0: 50,
    });

    fakeDb.reset();
    expect(
      await deliveryFilesRepository.attach(
        fakeDb.conn as never,
        { contractId: 9, deliveryId: 3 },
        { conversationId: 5, senderId: 2, files: [] },
      ),
    ).toEqual([]);
    expect(fakeDb.calls).toEqual([]);
  });
});

describe('deliveryFilesRepository.listForContract', () => {
  it('lê os arquivos da contratação com o que a mensagem guarda, na ordem de envio', async () => {
    const rows = [row({ message_id: 40 })];
    fakeDb.reply(rows);
    expect(await deliveryFilesRepository.listForContract(9)).toBe(rows);
    expect(fakeDb.calls[0]!.sql).toBe(
      'SELECT df.message_id, df.delivery_id, df.milestone_id, m.file_name, m.file_mime, m.file_size_bytes, m.file_purged_at, m.file_purged_reason, m.removed_at, m.created_at FROM delivery_files df JOIN messages m ON m.id = df.message_id WHERE df.contract_id = :contractId ORDER BY df.message_id ASC',
    );
    expect(fakeDb.calls[0]!.params).toEqual({ contractId: 9 });
  });
});

describe('formato da API', () => {
  it('o arquivo sai com o download do chat, números de verdade e as datas em ISO', () => {
    expect(toDeliveryAttachment(row({ message_id: 40 }))).toEqual({
      messageId: 40,
      name: 'final.pdf',
      mime: 'application/pdf',
      size: 2048,
      url: '/api/messaging/attachments/40',
      purgedAt: null,
      purgedReason: null,
      removedAt: null,
      sentAt: '2026-10-04T18:30:00.000Z',
    });
  });

  it('expurgado mantém o nome e diz o motivo; removido pela moderação perde nome e tamanho', () => {
    expect(
      toDeliveryAttachment(
        row({
          message_id: 41,
          file_purged_at: new Date('2026-10-10T03:00:00Z'),
          file_purged_reason: 'retention',
        }),
      ),
    ).toMatchObject({
      name: 'final.pdf',
      purgedAt: '2026-10-10T03:00:00.000Z',
      purgedReason: 'retention',
    });
    // Linha marcada sem motivo (legado): o arquivo faltou.
    expect(
      toDeliveryAttachment(
        row({ message_id: 42, file_purged_at: new Date('2026-10-10T03:00:00Z') }),
      ).purgedReason,
    ).toBe('missing');
    expect(
      toDeliveryAttachment(row({ message_id: 43, removed_at: new Date('2026-10-05T12:00:00Z') })),
    ).toMatchObject({ name: '', size: 0, removedAt: '2026-10-05T12:00:00.000Z' });
    // Sem nome nem tipo gravados: os padrões do anexo do chat.
    expect(
      toDeliveryAttachment(row({ message_id: 44, file_name: null, file_mime: null })),
    ).toMatchObject({ name: 'arquivo', mime: 'application/octet-stream' });
  });

  it('attachmentsOf separa os arquivos de cada entrega única e de cada marco', () => {
    const rows = [
      row({ message_id: 40, delivery_id: 3 }),
      row({ message_id: 41, delivery_id: 5 }),
      row({ message_id: 42, delivery_id: null, milestone_id: 7 }),
      row({ message_id: 43, delivery_id: '3' as unknown as number }),
    ];
    expect(attachmentsOf(rows, { deliveryId: 3 }).map((a) => a.messageId)).toEqual([40, 43]);
    expect(attachmentsOf(rows, { deliveryId: 5 }).map((a) => a.messageId)).toEqual([41]);
    expect(attachmentsOf(rows, { milestoneId: 7 }).map((a) => a.messageId)).toEqual([42]);
    expect(attachmentsOf(rows, { milestoneId: 3 })).toEqual([]);
    expect(attachmentsOf([], { deliveryId: 3 })).toEqual([]);
  });
});
