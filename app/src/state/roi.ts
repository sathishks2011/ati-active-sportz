/**
 * Court ROI utilities — math shared between Setup, overlays, and the
 * persistence layer. Worklet code inlines this math (worklets can't
 * import JS functions), but the JS sides import from here so the
 * polygon contract is defined in one place.
 *
 * Coordinate convention: corners are normalized 0..1, ordered
 * top-left → top-right → bottom-right → bottom-left (clockwise from the
 * top of the screen).
 */

import type { Roi, RoiCorner } from './sessionMachine';

export const ROI_CORNER_LABELS = [
  'top-left',
  'top-right',
  'bottom-right',
  'bottom-left',
] as const;

/**
 * Axis-aligned bounding box of the polygon in the same normalized
 * coordinate space as the corners. Useful for the worklet's outer
 * sampling loop and for the Dimmer's bbox-approximation.
 */
export function quadBoundingBox(roi: Roi): {
  x: number;
  y: number;
  w: number;
  h: number;
} {
  const xs = roi.corners.map(c => c[0]);
  const ys = roi.corners.map(c => c[1]);
  const minX = Math.min(...xs);
  const minY = Math.min(...ys);
  const maxX = Math.max(...xs);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

/**
 * Convexity test: all four cross-products of consecutive edges share a
 * sign. A real volleyball court from any camera angle is convex; Setup
 * uses this to reject pathological four-corner taps (crossed edges,
 * concave shapes) before committing.
 */
export function isConvexQuad(corners: readonly RoiCorner[]): boolean {
  if (corners.length !== 4) return false;
  let sign = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[(i + 1) % 4];
    const [cx, cy] = corners[(i + 2) % 4];
    const cross = (bx - ax) * (cy - by) - (by - ay) * (cx - bx);
    if (cross !== 0) {
      if (sign === 0) sign = cross > 0 ? 1 : -1;
      else if ((cross > 0 ? 1 : -1) !== sign) return false;
    }
  }
  return true;
}

/**
 * Inside-quad test by the four-cross-products method. Caller must
 * guarantee the polygon is convex (Setup enforces this). Mirrors the
 * inlined worklet math at `motionFrameProcessor.ts` — keep the two
 * in sync.
 */
export function pointInQuad(
  px: number,
  py: number,
  corners: readonly RoiCorner[],
): boolean {
  if (corners.length !== 4) return false;
  let positive = 0;
  let negative = 0;
  for (let i = 0; i < 4; i++) {
    const [ax, ay] = corners[i];
    const [bx, by] = corners[(i + 1) % 4];
    const cross = (bx - ax) * (py - ay) - (by - ay) * (px - ax);
    if (cross > 0) positive++;
    else if (cross < 0) negative++;
  }
  return positive === 0 || negative === 0;
}

/**
 * Translate a legacy rectangle ROI (pre-ADR-0010 persistence) into a
 * quadrilateral. Used by the DB migration in `persistence/db.ts` and
 * nowhere else in the live code path.
 */
export function rectToQuad(rect: {
  x: number;
  y: number;
  w: number;
  h: number;
}): Roi {
  const { x, y, w, h } = rect;
  return {
    corners: [
      [x, y],
      [x + w, y],
      [x + w, y + h],
      [x, y + h],
    ] as const,
  };
}
