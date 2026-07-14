/**
 * Deterministic procedural frame for the compat spike: a rotating gradient plus a
 * spinning square and the frame index. Motion + a per-frame number make seek and
 * playback visually verifiable; determinism keeps it reproducible across engines.
 */
export function drawSpinner(
  canvas: OffscreenCanvas | HTMLCanvasElement,
  index: number,
  total: number,
): void {
  const ctx = canvas.getContext('2d') as
    | OffscreenCanvasRenderingContext2D
    | CanvasRenderingContext2D
    | null;
  if (!ctx) throw new Error('2D context unavailable');

  const w = canvas.width;
  const h = canvas.height;
  const t = total > 0 ? index / total : 0;
  const angle = t * Math.PI * 2;

  // Rotating linear gradient background.
  const cx = w / 2;
  const cy = h / 2;
  const gx = Math.cos(angle) * w;
  const gy = Math.sin(angle) * h;
  const grad = ctx.createLinearGradient(cx - gx / 2, cy - gy / 2, cx + gx / 2, cy + gy / 2);
  grad.addColorStop(0, `hsl(${(t * 360) % 360}, 70%, 55%)`);
  grad.addColorStop(1, `hsl(${(t * 360 + 180) % 360}, 70%, 35%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  // Spinning square in the middle.
  const side = Math.min(w, h) * 0.32;
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle * 2);
  ctx.fillStyle = 'rgba(255,255,255,0.9)';
  ctx.fillRect(-side / 2, -side / 2, side, side);
  ctx.restore();

  // Frame index, so a human (or a seek check) can tell frames apart.
  ctx.fillStyle = '#111';
  ctx.font = `${Math.round(Math.min(w, h) * 0.12)}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(index), cx, cy);
}
