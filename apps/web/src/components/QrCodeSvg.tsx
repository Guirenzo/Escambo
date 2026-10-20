import QRCode from 'qrcode';
import { useMemo } from 'react';

/** Zona de silêncio do QR: 4 módulos claros em volta, o que os leitores esperam. */
const QUIET = 4;

/**
 * Desenho do QR como um único caminho SVG: cada trecho seguido de módulos escuros de uma linha
 * vira um retângulo. Gerado no navegador (o conteúdo, como o segredo da 2FA, não sai daqui) e
 * desenhado como elemento do DOM: nada de imagem por URL, então a CSP fica como está.
 */
export function qrPath(text: string): { size: number; d: string } {
  const { modules } = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = modules.size;
  const parts: string[] = [];
  for (let y = 0; y < n; y++) {
    let x = 0;
    while (x < n) {
      if (!modules.get(y, x)) {
        x += 1;
        continue;
      }
      const start = x;
      while (x < n && modules.get(y, x)) x += 1;
      parts.push(`M${start + QUIET} ${y + QUIET}h${x - start}v1h-${x - start}z`);
    }
  }
  return { size: n + QUIET * 2, d: parts.join('') };
}

/**
 * QR Code em SVG inline. Escuro sobre branco em qualquer tema (é o que a câmera lê melhor); o nome
 * acessível diz o que é, e quem não lê QR tem o mesmo conteúdo em texto ao lado.
 */
export function QrCodeSvg({
  value,
  label,
  size = 176,
}: {
  value: string;
  label: string;
  size?: number;
}) {
  const { size: modules, d } = useMemo(() => qrPath(value), [value]);
  return (
    <svg
      className="qr-svg"
      role="img"
      aria-label={label}
      viewBox={`0 0 ${modules} ${modules}`}
      width={size}
      height={size}
      shapeRendering="crispEdges"
      xmlns="http://www.w3.org/2000/svg"
    >
      <rect width={modules} height={modules} fill="#ffffff" />
      <path d={d} fill="#0f1a14" />
    </svg>
  );
}
