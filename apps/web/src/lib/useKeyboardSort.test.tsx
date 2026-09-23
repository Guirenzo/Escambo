import { act, renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useKeyboardSort } from './useKeyboardSort';

/**
 * As bordas do ADR 53 que não cabem no cartão: a lista mudando por baixo da pega. O item sai da
 * lista (removido em outra aba) ou a lista some da tela (a consulta virou erro) — nos dois casos a
 * pega precisa ser abandonada na hora, dizendo por quê, em vez de continuar segurando um fantasma.
 */

const lista = [
  { id: 1, title: 'Logo' },
  { id: 2, title: 'Site' },
  { id: 3, title: 'Cardápio' },
];

function montar(items = lista, listOnScreen = true) {
  const onAnnounce = vi.fn();
  const onCommit = vi.fn();
  const listRef = createRef<HTMLUListElement>();
  const rescueRef = createRef<HTMLHeadingElement>();
  const hook = renderHook(
    (props: { items: typeof lista; listOnScreen: boolean }) =>
      useKeyboardSort({
        items: props.items,
        listRef,
        listOnScreen: props.listOnScreen,
        blocked: false,
        rescueRef,
        onCommit,
        onAnnounce,
      }),
    { initialProps: { items, listOnScreen } },
  );
  return { hook, onAnnounce, onCommit };
}

/** Pega um item sem DOM: o keydown do espaço na alça daquele item. */
function pegar(hook: ReturnType<typeof montar>['hook'], id: number, title: string): void {
  const props = hook.result.current.handleProps({ id, title });
  act(() => {
    props.onKeyDown({
      key: ' ',
      repeat: false,
      preventDefault: vi.fn(),
    } as unknown as Parameters<typeof props.onKeyDown>[0]);
  });
}

describe('pega abandonada quando a lista muda por baixo (ADR 53)', () => {
  it('item removido em outra aba: solta o fantasma e diz o que houve', () => {
    const { hook, onAnnounce, onCommit } = montar();
    pegar(hook, 2, 'Site');
    expect(hook.result.current.grabbedId).toBe(2);

    act(() => {
      hook.rerender({ items: lista.filter((i) => i.id !== 2), listOnScreen: true });
    });
    expect(hook.result.current.grabbedId).toBeNull();
    expect(hook.result.current.busy).toBe(false);
    expect(onAnnounce).toHaveBeenLastCalledWith('A lista mudou. Nada foi movido.');
    expect(onCommit).not.toHaveBeenCalled();
  });

  it('a lista sai da tela (consulta com erro): a pega não fica presa esperando', () => {
    const { hook, onAnnounce } = montar();
    pegar(hook, 1, 'Logo');
    expect(hook.result.current.busy).toBe(true);

    act(() => {
      hook.rerender({ items: lista, listOnScreen: false });
    });
    expect(hook.result.current.grabbedId).toBeNull();
    expect(hook.result.current.busy).toBe(false);
    expect(onAnnounce).toHaveBeenLastCalledWith('A lista mudou. Nada foi movido.');
  });

  it('sobrando um item só não há ordem para segurar', () => {
    const { hook } = montar();
    pegar(hook, 3, 'Cardápio');
    act(() => {
      hook.rerender({ items: [{ id: 3, title: 'Cardápio' }], listOnScreen: true });
    });
    expect(hook.result.current.grabbedId).toBeNull();
    expect(hook.result.current.order).toHaveLength(1);
  });
});
