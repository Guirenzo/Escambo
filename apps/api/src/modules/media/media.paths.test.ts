import { describe, expect, it } from 'vitest';
import {
  MEDIA_FILE_RE,
  MEDIA_URL_RE,
  mediaIdOf,
  mediaKeyFromParts,
  mediaKeyFromUrl,
  mediaUrl,
  mediaVariantKey,
  parseMediaWidth,
} from './media.paths';

const ID = '01J8ZQ4K7M3VX5R2T9W6Y1B0CD';

describe('endereços de mídia (ADR 36 e 38)', () => {
  it('aceita só /api/media/AAAA/MM/<ULID>.<jpg|png|gif|webp>', () => {
    expect(MEDIA_URL_RE.test(`/api/media/2026/09/${ID}.webp`)).toBe(true);
    expect(MEDIA_URL_RE.test(`/api/media/2026/12/${ID}.jpg`)).toBe(true);
    for (const bad of [
      `/api/media/2026/13/${ID}.png`, // mês inválido
      `/api/media/2026/9/${ID}.png`,
      `/api/media/2026/09/${ID.toLowerCase()}.png`,
      `/api/media/2026/09/${ID}.svg`,
      `/api/media/2026/09/../../etc/passwd`,
      `https://cdn.exemplo.com/api/media/2026/09/${ID}.png`,
      `/api/media/2026/09/${ID}.png?x=1`,
      `/api/media/2026/09/${ID}.w128.webp`, // miniatura não é URL gravável no perfil
      `/api/messaging/attachments/1`,
    ]) {
      expect(MEDIA_URL_RE.test(bad), bad).toBe(false);
    }
    expect(MEDIA_FILE_RE.test(`${ID}.gif`)).toBe(true);
    expect(MEDIA_FILE_RE.test(`${ID}.gif.html`)).toBe(false);
  });

  it('converte entre URL pública e chave em disco', () => {
    const key = `2026/09/${ID}.png`;
    expect(mediaUrl(key)).toBe(`/api/media/${key}`);
    expect(mediaKeyFromUrl(`/api/media/${key}`)).toBe(key);
    expect(mediaKeyFromUrl('https://i.pravatar.cc/150')).toBeNull();
    expect(mediaKeyFromUrl(null)).toBeNull();
    expect(mediaKeyFromParts('2026', '09', `${ID}.png`)).toBe(key);
    expect(mediaKeyFromParts('2026', '09', '..%2F..%2Fsegredo')).toBeNull();
  });

  it('?w= só com as larguras da lista, na grafia exata', () => {
    expect(parseMediaWidth(undefined)).toBeUndefined();
    expect(parseMediaWidth('128')).toBe(128);
    expect(parseMediaWidth('480')).toBe(480);
    expect(parseMediaWidth('960')).toBe(960);
    for (const bad of ['100', '0128', '128px', '', ' 128', ['128', '480'], '1600']) {
      expect(parseMediaWidth(bad), JSON.stringify(bad)).toBeNull();
    }
  });

  it('miniatura fica na pasta do original e tem a mesma identidade', () => {
    expect(mediaVariantKey(`2026/09/${ID}.png`, 128)).toBe(`2026/09/${ID}.w128.webp`);
    expect(mediaVariantKey(`2026/09/${ID}.webp`, 480)).toBe(`2026/09/${ID}.w480.webp`);
    expect(mediaIdOf(`2026/09/${ID}.png`)).toEqual({ id: `2026/09/${ID}`, variant: false });
    expect(mediaIdOf(`2026/09/${ID}.w480.webp`)).toEqual({ id: `2026/09/${ID}`, variant: true });
    expect(mediaIdOf(`2026/09/${ID}.w480.webp.3f9a0c.tmp`)).toBeNull();
    expect(mediaIdOf('2026/09/leia-me.txt')).toBeNull();
  });
});
