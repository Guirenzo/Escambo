import { describe, expect, it } from 'vitest';
import { categoryPhoto, PAIR_PHOTO, PORTRAITS } from './photos';

/** As fotos próprias por categoria: as do seed têm foto; uma categoria nova cai no desenho. */
describe('categoryPhoto', () => {
  it.each([
    ['tecnologia', 'dev'],
    ['design', 'designer'],
    ['reformas-reparos', 'eletricista'],
    ['aulas-cursos', 'professora'],
    ['servicos-domesticos', 'jardineira'],
    ['marketing', 'social-media'],
    ['fotografia', 'fotografa'],
    ['foto-e-video', 'fotografa'],
  ])('%s → %s, nas duas larguras', (slug, name) => {
    const photo = categoryPhoto(slug)!;
    expect(photo.src).toBe(`/img/pessoas/${name}-400.webp`);
    expect(photo.srcSet).toBe(`/img/pessoas/${name}-400.webp 400w, /img/pessoas/${name}.webp 800w`);
    expect([photo.width, photo.height]).toEqual([800, 1000]);
  });

  it('categoria sem foto própria devolve null', () => {
    expect(categoryPhoto('jardinagem')).toBeNull();
  });

  it('a foto da troca é 3:2 e os retratos, 4:5', () => {
    expect(PAIR_PHOTO.width / PAIR_PHOTO.height).toBeCloseTo(1.49, 1);
    expect(PORTRAITS.fotografa.src).toBe('/img/pessoas/fotografa-400.webp');
  });
});
