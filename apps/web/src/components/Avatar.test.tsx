import { fireEvent, render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Avatar } from './Avatar';

/**
 * Avatar (ADR 38): foto enviada ao Escambo vem da miniatura de 128 px; se a miniatura falhar,
 * tenta o original e só então cai na inicial. É decorativo (aria-hidden), então a imagem não tem
 * papel acessível: a consulta é pela tag.
 */

const MEDIA = '/api/media/2026/09/01ARZ3NDEKTSV4RRFFQ69G5FAV.webp';
const EXTERNAL = 'https://fotos.example/ana.jpg';

const img = (c: HTMLElement): HTMLImageElement | null => c.querySelector('img');

describe('Avatar', () => {
  it('sem foto mostra a inicial do nome em maiúscula, ignorando espaços', () => {
    const { container } = render(<Avatar name="  bruna Lima" />);
    expect(img(container)).toBeNull();
    expect(container).toHaveTextContent(/^B$/);
  });

  it('sem foto e sem nome mostra "?"', () => {
    const { container } = render(<Avatar name="   " url={null} />);
    expect(container).toHaveTextContent(/^\?$/);
  });

  it('é decorativo: fica fora da árvore de acessibilidade e a imagem não tem texto alternativo', () => {
    const { container } = render(<Avatar name="Ana" url={EXTERNAL} />);
    expect(container.firstElementChild).toHaveAttribute('aria-hidden', 'true');
    expect(img(container)).toHaveAttribute('alt', '');
    expect(img(container)).toHaveAttribute('referrerpolicy', 'no-referrer');
  });

  it('o tamanho pedido vai na classe do avatar, que é médio por padrão', () => {
    const { container, rerender } = render(<Avatar name="Ana" />);
    expect(container.firstElementChild).toHaveAttribute('class', 'avatar md');
    rerender(<Avatar name="Ana" size="lg" />);
    expect(container.firstElementChild).toHaveAttribute('class', 'avatar lg');
  });

  it('foto enviada ao Escambo vem da miniatura de 128 px', () => {
    const { container } = render(<Avatar name="Ana" url={MEDIA} />);
    expect(img(container)).toHaveAttribute('src', `${MEDIA}?w=128`);
    expect(container).not.toHaveTextContent('A');
  });

  it('miniatura que falha tenta o original; original que falha cai na inicial', () => {
    const { container } = render(<Avatar name="Ana" url={MEDIA} />);
    fireEvent.error(img(container)!);
    expect(img(container)).toHaveAttribute('src', MEDIA);
    fireEvent.error(img(container)!);
    expect(img(container)).toBeNull();
    expect(container).toHaveTextContent(/^A$/);
  });

  it('link externo não tem miniatura: a primeira falha já cai na inicial', () => {
    const { container } = render(<Avatar name="Ana" url={EXTERNAL} />);
    expect(img(container)).toHaveAttribute('src', EXTERNAL);
    fireEvent.error(img(container)!);
    expect(img(container)).toBeNull();
    expect(container).toHaveTextContent(/^A$/);
  });

  it('a falha fica presa à URL: trocar a foto volta a tentar a imagem', () => {
    const { container, rerender } = render(<Avatar name="Ana" url={EXTERNAL} />);
    fireEvent.error(img(container)!);
    expect(img(container)).toBeNull();
    rerender(<Avatar name="Ana" url="https://fotos.example/nova.jpg" />);
    expect(img(container)).toHaveAttribute('src', 'https://fotos.example/nova.jpg');
  });
});
