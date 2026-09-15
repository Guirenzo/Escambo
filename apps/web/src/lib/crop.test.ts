import { describe, expect, it } from 'vitest';
import { clampCrop, cropRect, initialCrop, moveCrop, zoomCrop } from './crop';

const VIEW = 280;
const landscape = { width: 1200, height: 800 };
const portrait = { width: 600, height: 900 };

function expectRect(
  actual: { sx: number; sy: number; size: number },
  expected: { sx: number; sy: number; size: number },
): void {
  expect(actual.sx).toBeCloseTo(expected.sx, 6);
  expect(actual.sy).toBeCloseTo(expected.sy, 6);
  expect(actual.size).toBeCloseTo(expected.size, 6);
}

describe('recorte quadrado do avatar (ADR 38)', () => {
  it('começa centralizado, com o menor lado da foto ocupando a janela', () => {
    const s = initialCrop(landscape, VIEW);
    expect(s.zoom).toBe(1);
    expect(s.y).toBeCloseTo(0, 6);
    expectRect(cropRect(landscape, VIEW, s), { sx: 200, sy: 0, size: 800 });
    expectRect(cropRect(portrait, VIEW, initialCrop(portrait, VIEW)), {
      sx: 0,
      sy: 150,
      size: 600,
    });
  });

  it('não deixa arrastar para fora da foto nem sair da faixa de zoom', () => {
    const s = clampCrop(landscape, VIEW, { zoom: 9, x: 50, y: -99_999 });
    expect(s.zoom).toBe(4);
    expect(s.x).toBe(0);
    // zoom 4: a foto fica com 1120 px de altura na tela, então y vai no máximo até 280 - 1120.
    expect(s.y).toBeCloseTo(-840, 6);
    expect(clampCrop(landscape, VIEW, { zoom: 0.2, x: 0, y: 0 }).zoom).toBe(1);
    const dragged = moveCrop(landscape, VIEW, initialCrop(landscape, VIEW), -1000, 30);
    expectRect(cropRect(landscape, VIEW, dragged), { sx: 400, sy: 0, size: 800 });
  });

  it('o zoom mantém parado o ponto da foto que está no centro da janela', () => {
    const zoomed = zoomCrop(landscape, VIEW, initialCrop(landscape, VIEW), 2);
    const r = cropRect(landscape, VIEW, zoomed);
    expect(r.sx + r.size / 2).toBeCloseTo(600, 6);
    expect(r.sy + r.size / 2).toBeCloseTo(400, 6);
    expect(r.size).toBeCloseTo(400, 6);
  });
});
