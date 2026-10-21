/**
 * Fotos próprias da página inicial (public/img/pessoas): pessoas fictícias geradas para o Escambo,
 * usadas só como imagem de categoria e de seção. Nunca com nome, nota ou depoimento, como se fossem
 * usuários reais; e sempre decorativas (`alt=""`), porque o texto ao lado já diz do que se trata.
 * Cada foto tem duas larguras (400 e 800 px), em retrato 4:5.
 */

export interface Photo {
  src: string;
  srcSet: string;
  width: number;
  height: number;
}

const BASE = '/img/pessoas';

const portrait = (name: string): Photo => ({
  src: `${BASE}/${name}-400.webp`,
  srcSet: `${BASE}/${name}-400.webp 400w, ${BASE}/${name}.webp 800w`,
  width: 800,
  height: 1000,
});

/** Por categoria raiz do seed de referência; Fotografia e Vídeo, se aparecer, fica com a fotógrafa. */
const BY_SLUG: Record<string, string> = {
  tecnologia: 'dev',
  design: 'designer',
  'reformas-reparos': 'eletricista',
  'aulas-cursos': 'professora',
  'servicos-domesticos': 'jardineira',
  marketing: 'social-media',
};

/** A foto da categoria; categoria nova sem foto própria devolve null (o bloco usa o tom e o ícone). */
export function categoryPhoto(slug: string): Photo | null {
  const name = BY_SLUG[slug] ?? (/foto|video|vídeo/.test(slug) ? 'fotografa' : null);
  return name ? portrait(name) : null;
}

export const PORTRAITS = {
  dev: portrait('dev'),
  designer: portrait('designer'),
  eletricista: portrait('eletricista'),
  professora: portrait('professora'),
  jardineira: portrait('jardineira'),
  socialMedia: portrait('social-media'),
  fotografa: portrait('fotografa'),
} as const;

/** Dois profissionais trabalhando juntos (3:2): a foto da troca. */
export const PAIR_PHOTO: Photo = {
  src: `${BASE}/dupla-troca-400.webp`,
  srcSet: `${BASE}/dupla-troca-400.webp 400w, ${BASE}/dupla-troca.webp 800w`,
  width: 800,
  height: 538,
};
