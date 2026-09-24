import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { saveBlob } from './download';

/** O download por âncora temporária, o mesmo para anexo, ledger, série da moderação e cópia LGPD. */
describe('saveBlob', () => {
  const create = vi.fn(() => 'blob:escambo/1');
  const revoke = vi.fn();
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('URL', { ...URL, createObjectURL: create, revokeObjectURL: revoke });
    create.mockClear();
    revoke.mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('cria a âncora com o nome, clica, remove e revoga a URL depois de 10 s', () => {
    const clicked: HTMLAnchorElement[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
    saveBlob(new Blob(['a;b']), 'escambo-moderacao.csv');

    expect(create).toHaveBeenCalledOnce();
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toBe('escambo-moderacao.csv');
    expect(clicked[0]!.href).toBe('blob:escambo/1');
    expect(clicked[0]!.rel).toBe('noopener');
    expect(document.body.contains(clicked[0]!)).toBe(false);
    expect(revoke).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(revoke).toHaveBeenCalledWith('blob:escambo/1');
    click.mockRestore();
  });
});
