import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DropoutsSummary } from './DropoutsSummary';

describe('resumo público das desistências', () => {
  it('não afirma reputação quando o payload é antigo ou o número é zero', () => {
    const { rerender, container } = render(<DropoutsSummary />);
    expect(container).toBeEmptyDOMElement();
    rerender(<DropoutsSummary summary={{ count: 0, windowDays: 60, alert: false }} />);
    expect(container).toBeEmptyDOMElement();
  });
  it('mostra só número, definição e janela, sem título ou data privada', () => {
    render(<DropoutsSummary summary={{ count: 1, windowDays: 60, alert: false }} />);
    expect(screen.getByTestId('dropouts')).toHaveTextContent(
      '1 desistência depois do aceite nos últimos 60 dias',
    );
  });
  it('com três oferece a explicação acessível do alerta; ao contratar só o alerta aparece', () => {
    const { rerender, container } = render(
      <DropoutsSummary summary={{ count: 2, windowDays: 60, alert: false }} hiring />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<DropoutsSummary summary={{ count: 3, windowDays: 60, alert: true }} hiring />);
    expect(screen.getByTestId('dropouts-alert')).toHaveTextContent(
      'Alerta: este freelancer desistiu de 3 contratações',
    );
    expect(screen.getByTestId('dropouts-alert')).toHaveAttribute(
      'aria-label',
      expect.stringContaining('garantia'),
    );
  });
});
