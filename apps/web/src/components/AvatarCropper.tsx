import { Minus, Plus } from 'lucide-react';
import { useEffect, useRef, useState, type KeyboardEvent, type PointerEvent } from 'react';
import {
  CROP_MAX_ZOOM,
  CROP_MIN_ZOOM,
  cropRect,
  cropScale,
  initialCrop,
  moveCrop,
  zoomCrop,
  type CropState,
} from '../lib/crop';
import { IMAGE_MAX_SIDE } from '../lib/image';
import { Button, Modal } from './ui';

/** Lado da janela de recorte em px de tela (o mesmo do CSS .crop-view). */
const VIEW = 280;
/** Prévias no tamanho grande (perfil público) e pequeno (menu, cards) do avatar. */
const PREVIEWS = [64, 32] as const;
const STEP_PX = 12;
const ZOOM_STEP = 0.25;

const MOVES: Readonly<Record<string, readonly [number, number]>> = {
  ArrowLeft: [-STEP_PX, 0],
  ArrowRight: [STEP_PX, 0],
  ArrowUp: [0, -STEP_PX],
  ArrowDown: [0, STEP_PX],
};

/**
 * Recorte quadrado da foto de perfil (ADR 38). Enquadra arrastando (mouse, toque ou setas) e com
 * zoom (controle deslizante, botões, roda do mouse ou + e −), com a prévia do avatar redondo nos
 * dois tamanhos em que ele aparece. A foto chega já orientada (createImageBitmap com a orientação
 * da câmera) e sai como quadrado de até 512 px, sem EXIF. Se o navegador não abrir a imagem, dá
 * para enviar sem recortar: a API recorta no centro.
 */
export function AvatarCropper({
  file,
  onCancel,
  onConfirm,
}: {
  file: File;
  onCancel: () => void;
  onConfirm: (image: Blob) => void;
}) {
  const [bitmap, setBitmap] = useState<ImageBitmap | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [crop, setCrop] = useState<CropState>({ zoom: 1, x: 0, y: 0 });
  const [failed, setFailed] = useState(false);
  const [saving, setSaving] = useState(false);
  const view = useRef<HTMLDivElement | null>(null);
  const drag = useRef<{ id: number; x: number; y: number } | null>(null);

  useEffect(() => {
    let alive = true;
    const url = URL.createObjectURL(file);
    createImageBitmap(file, { imageOrientation: 'from-image' })
      .then((bmp) => {
        if (!alive) return bmp.close();
        setBitmap(bmp);
        setSrc(url);
        setCrop(initialCrop(bmp, VIEW));
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
      URL.revokeObjectURL(url);
    };
  }, [file]);

  useEffect(() => () => bitmap?.close(), [bitmap]);

  // Roda do mouse dá zoom sem rolar a página (o listener precisa ser não passivo).
  useEffect(() => {
    const el = view.current;
    if (!el || !bitmap) return;
    const onWheel = (e: WheelEvent): void => {
      e.preventDefault();
      setCrop((c) => zoomCrop(bitmap, VIEW, c, c.zoom * (e.deltaY < 0 ? 1.1 : 1 / 1.1)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [bitmap]);

  const zoomTo = (zoom: number): void => {
    if (bitmap) setCrop((c) => zoomCrop(bitmap, VIEW, c, zoom));
  };

  function onPointerDown(e: PointerEvent<HTMLDivElement>): void {
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY };
  }

  function onPointerMove(e: PointerEvent<HTMLDivElement>): void {
    const d = drag.current;
    if (!d || d.id !== e.pointerId || !bitmap) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    drag.current = { id: d.id, x: e.clientX, y: e.clientY };
    setCrop((c) => moveCrop(bitmap, VIEW, c, dx, dy));
  }

  function onPointerUp(e: PointerEvent<HTMLDivElement>): void {
    if (drag.current?.id === e.pointerId) drag.current = null;
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>): void {
    if (!bitmap) return;
    const move = MOVES[e.key];
    if (move) {
      e.preventDefault();
      setCrop((c) => moveCrop(bitmap, VIEW, c, move[0], move[1]));
    } else if (e.key === '+' || e.key === '=') {
      e.preventDefault();
      setCrop((c) => zoomCrop(bitmap, VIEW, c, c.zoom + ZOOM_STEP));
    } else if (e.key === '-' || e.key === '_') {
      e.preventDefault();
      setCrop((c) => zoomCrop(bitmap, VIEW, c, c.zoom - ZOOM_STEP));
    }
  }

  async function confirm(): Promise<void> {
    if (!bitmap) return;
    setSaving(true);
    const r = cropRect(bitmap, VIEW, crop);
    const side = Math.max(1, Math.round(Math.min(IMAGE_MAX_SIDE.avatar, r.size)));
    const canvas = document.createElement('canvas');
    canvas.width = side;
    canvas.height = side;
    const ctx = canvas.getContext('2d');
    let image: Blob | null = null;
    if (ctx) {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, r.sx, r.sy, r.size, r.size, 0, 0, side, side);
      const encode = (type: string): Promise<Blob | null> =>
        new Promise((resolve) => canvas.toBlob(resolve, type, 0.9));
      const webp = await encode('image/webp');
      image = webp && webp.type === 'image/webp' ? webp : await encode('image/jpeg');
    }
    setSaving(false);
    if (image) onConfirm(image);
    else setFailed(true);
  }

  const scale = bitmap ? cropScale(bitmap, VIEW, crop.zoom) : 1;
  const place = (size: number) =>
    bitmap
      ? {
          width: (bitmap.width * scale * size) / VIEW,
          height: (bitmap.height * scale * size) / VIEW,
          transform: `translate(${(crop.x * size) / VIEW}px, ${(crop.y * size) / VIEW}px)`,
        }
      : undefined;

  return (
    <Modal title="Ajustar foto" onClose={onCancel}>
      {failed ? (
        <div className="stack">
          <p>Não deu para abrir esta imagem para recortar neste navegador.</p>
          <p className="muted tiny">Você pode enviar assim mesmo: o Escambo recorta pelo centro.</p>
          <div className="crop-actions">
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancelar
            </Button>
            <Button type="button" onClick={() => onConfirm(file)}>
              Enviar sem recortar
            </Button>
          </div>
        </div>
      ) : (
        <div className="stack cropper">
          <p className="muted tiny" id="crop-hint">
            Arraste a foto para enquadrar e ajuste o zoom. Pelo teclado: setas movem, + e − dão
            zoom.
          </p>
          <div className="cropper-body">
            <div
              ref={view}
              className="crop-view"
              role="group"
              aria-label="Enquadramento da foto"
              aria-describedby="crop-hint"
              tabIndex={0}
              onPointerDown={onPointerDown}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
              onKeyDown={onKeyDown}
            >
              {src && (
                <img
                  className="crop-photo"
                  src={src}
                  alt=""
                  draggable={false}
                  style={place(VIEW)}
                />
              )}
              <span className="crop-mask" aria-hidden="true" />
            </div>
            <div className="crop-previews" aria-hidden="true">
              {PREVIEWS.map((size) => (
                <span key={size} className="crop-preview" style={{ width: size, height: size }}>
                  {src && <img src={src} alt="" draggable={false} style={place(size)} />}
                </span>
              ))}
            </div>
          </div>
          <div className="crop-zoom">
            <button
              type="button"
              className="icon-btn"
              aria-label="Afastar"
              disabled={!bitmap || crop.zoom <= CROP_MIN_ZOOM}
              onClick={() => zoomTo(crop.zoom - ZOOM_STEP)}
            >
              <Minus size={16} />
            </button>
            <input
              type="range"
              aria-label="Zoom"
              min={CROP_MIN_ZOOM}
              max={CROP_MAX_ZOOM}
              step={0.01}
              value={crop.zoom}
              disabled={!bitmap}
              onChange={(e) => zoomTo(Number(e.target.value))}
            />
            <button
              type="button"
              className="icon-btn"
              aria-label="Aproximar"
              disabled={!bitmap || crop.zoom >= CROP_MAX_ZOOM}
              onClick={() => zoomTo(crop.zoom + ZOOM_STEP)}
            >
              <Plus size={16} />
            </button>
          </div>
          <div className="crop-actions">
            <Button type="button" variant="secondary" onClick={onCancel}>
              Cancelar
            </Button>
            <Button type="button" onClick={() => void confirm()} disabled={!bitmap || saving}>
              {saving ? 'Preparando…' : 'Usar foto'}
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
