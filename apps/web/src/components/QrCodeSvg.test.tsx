import { render, screen } from '@testing-library/react';
import QRCode from 'qrcode';
import { describe, expect, it } from 'vitest';
import { QrCodeSvg, qrPath } from './QrCodeSvg';

/**
 * QR da 2FA desenhado no navegador como SVG inline (o segredo não vai a serviço nenhum e a CSP
 * fica como está): o desenho cobre exatamente os módulos escuros do QR, com a zona de silêncio.
 */

const URL = 'otpauth://totp/Escambo:ana%40escambo.test?secret=JBSWY3DPEHPK3PXP&issuer=Escambo';

/** Módulos escuros que o caminho desenha (cada "M x y hN" pinta N módulos da linha y). */
function paintedModules(d: string): Set<string> {
  const painted = new Set<string>();
  for (const [, x, y, w] of d.matchAll(/M(\d+) (\d+)h(\d+)v1h-\d+z/g)) {
    for (let i = 0; i < Number(w); i++) painted.add(`${Number(x) + i},${Number(y)}`);
  }
  return painted;
}

describe('qrPath', () => {
  it('pinta cada módulo escuro do QR, e só eles, deslocado pela zona de silêncio de 4', () => {
    const { modules } = QRCode.create(URL, { errorCorrectionLevel: 'M' });
    const { size, d } = qrPath(URL);
    expect(size).toBe(modules.size + 8);
    const expected = new Set<string>();
    for (let y = 0; y < modules.size; y++) {
      for (let x = 0; x < modules.size; x++) {
        if (modules.get(y, x)) expected.add(`${x + 4},${y + 4}`);
      }
    }
    expect(paintedModules(d)).toEqual(expected);
  });

  it('textos diferentes dão desenhos diferentes', () => {
    expect(qrPath(URL).d).not.toBe(qrPath(`${URL}&digits=6`).d);
  });
});

describe('QrCodeSvg', () => {
  it('é uma imagem com nome acessível, escura sobre branco e no tamanho pedido', () => {
    render(<QrCodeSvg value={URL} label="QR code para o app autenticador" size={160} />);
    const img = screen.getByRole('img', { name: 'QR code para o app autenticador' });
    expect(img.tagName.toLowerCase()).toBe('svg');
    expect(img).toHaveAttribute('width', '160');
    expect(img).toHaveAttribute('height', '160');
    const { size, d } = qrPath(URL);
    expect(img).toHaveAttribute('viewBox', `0 0 ${size} ${size}`);
    expect(img.querySelector('rect')).toHaveAttribute('fill', '#ffffff');
    expect(img.querySelector('path')).toHaveAttribute('d', d);
    expect(img.querySelector('path')).toHaveAttribute('fill', '#0f1a14');
  });

  it('sem tamanho, usa 176 px', () => {
    render(<QrCodeSvg value={URL} label="QR" />);
    expect(screen.getByRole('img', { name: 'QR' })).toHaveAttribute('width', '176');
  });
});
