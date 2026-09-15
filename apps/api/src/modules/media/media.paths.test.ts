import { describe, expect, it } from 'vitest';
import {
  MEDIA_FILE_RE,
  MEDIA_URL_RE,
  mediaKeyFromParts,
  mediaKeyFromUrl,
  mediaUrl,
} from './media.paths';

const ID = '01J8ZQ4K7M3VX5R2T9W6Y1B0CD';

describe('endereços de mídia (ADR 36)', () => {
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
});
