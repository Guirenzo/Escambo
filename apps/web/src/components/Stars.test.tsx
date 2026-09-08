import { fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { describe, expect, it } from 'vitest';
import { StarInput, Stars } from './Stars';

describe('Stars (nota somente leitura)', () => {
  it('descreve a nota e a quantidade para leitores de tela', () => {
    render(<Stars value={4.3} count={12} />);
    expect(screen.getByRole('img', { name: '4.3 de 5, 12 avaliações' })).toBeInTheDocument();
    expect(screen.getByText('4.3')).toBeInTheDocument();
    expect(screen.getByText('(12)')).toBeInTheDocument();
  });

  it('acende as estrelas arredondando a nota', () => {
    const { container } = render(<Stars value={3.6} showValue={false} />);
    expect(container.querySelectorAll('.star.on')).toHaveLength(4);
    expect(container.querySelectorAll('.star')).toHaveLength(5);
  });

  it('mostra traço quando ainda não há nota', () => {
    render(<Stars value={0} count={0} />);
    expect(screen.getByText('–')).toBeInTheDocument();
  });
});

function Harness() {
  const [v, setV] = useState(0);
  return (
    <>
      <StarInput value={v} onChange={setV} />
      <output>{v}</output>
    </>
  );
}

describe('StarInput (seletor de nota)', () => {
  it('é um grupo de 5 rádios com rótulos', () => {
    render(<Harness />);
    expect(screen.getByRole('radiogroup', { name: 'Nota' })).toBeInTheDocument();
    expect(screen.getAllByRole('radio')).toHaveLength(5);
    expect(screen.getByRole('radio', { name: '5 estrelas' })).toBeInTheDocument();
  });

  it('seleciona a nota ao clicar e reflete no rótulo', () => {
    render(<Harness />);
    fireEvent.click(screen.getByRole('radio', { name: '4 estrelas' }));
    expect(screen.getByRole('radio', { name: '4 estrelas' })).toBeChecked();
    expect(screen.getByText('4 estrelas')).toBeInTheDocument();
    expect(
      screen.getByRole('status', { hidden: true }).textContent ?? screen.getByText('4'),
    ).toBeTruthy();
  });
});
