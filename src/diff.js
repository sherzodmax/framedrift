// Pixel diff + hotspot detection.
import pixelmatch from 'pixelmatch';
import pngjs from 'pngjs';

const { PNG } = pngjs;

export const readPng = (buf) => PNG.sync.read(buf);
export const writePng = (png) => PNG.sync.write(png);

/** Copy `src` into a new w×h canvas; uncovered area is filled with `fill` (RGBA). */
export function padTo(src, w, h, fill = [255, 0, 255, 255]) {
    const out = new PNG({ width: w, height: h });
    for (let i = 0; i < w * h; i++) out.data.set(fill, i * 4);
    const cw = Math.min(w, src.width);
    const ch = Math.min(h, src.height);
    for (let y = 0; y < ch; y++) src.data.copy(out.data, y * w * 4, y * src.width * 4, y * src.width * 4 + cw * 4);
    return out;
}

/** Flatten transparency onto white (Figma renders of frames without fill are transparent). */
export function flattenOnWhite(png) {
    const d = png.data;
    for (let i = 0; i < d.length; i += 4) {
        const a = d[i + 3] / 255;
        if (a < 1) { d[i] = Math.round(d[i] * a + 255 * (1 - a)); d[i + 1] = Math.round(d[i + 1] * a + 255 * (1 - a)); d[i + 2] = Math.round(d[i + 2] * a + 255 * (1 - a)); d[i + 3] = 255; }
    }
    return png;
}

/**
 * Group differing pixels into rectangles ("hotspots").
 * Works on a coarse grid (cell px) and merges touching cells with a flood fill.
 */
export function findHotspots(mask, width, height, { cell = 8, minPixels = 4, mergeGap = 2, max = 25 } = {}) {
    const gw = Math.ceil(width / cell);
    const gh = Math.ceil(height / cell);
    const counts = new Uint32Array(gw * gh);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if (mask[y * width + x]) counts[Math.floor(y / cell) * gw + Math.floor(x / cell)]++;
    const seen = new Uint8Array(gw * gh);
    const boxes = [];
    for (let i = 0; i < counts.length; i++) {
        if (!counts[i] || seen[i]) continue;
        let minX = Infinity; let minY = Infinity; let maxX = -1; let maxY = -1; let pixels = 0;
        const stack = [i];
        seen[i] = 1;
        while (stack.length) {
            const c = stack.pop();
            const cx = c % gw; const cy = Math.floor(c / gw);
            pixels += counts[c];
            minX = Math.min(minX, cx); maxX = Math.max(maxX, cx); minY = Math.min(minY, cy); maxY = Math.max(maxY, cy);
            for (let dy = -mergeGap; dy <= mergeGap; dy++) {
                for (let dx = -mergeGap; dx <= mergeGap; dx++) {
                    const nx = cx + dx; const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= gw || ny >= gh) continue;
                    const n = ny * gw + nx;
                    if (counts[n] && !seen[n]) { seen[n] = 1; stack.push(n); }
                }
            }
        }
        if (pixels < minPixels) continue;
        boxes.push({ x: minX * cell, y: minY * cell, width: Math.min(width, (maxX + 1) * cell) - minX * cell, height: Math.min(height, (maxY + 1) * cell) - minY * cell, pixels });
    }
    boxes.sort((a, b) => b.pixels - a.pixels);
    return boxes.slice(0, max);
}

/**
 * Compare design vs actual PNG buffers.
 * Returns diff PNG, an overlay-friendly aligned actual image, mismatch stats and hotspots.
 * Sizes may differ: both are placed top-left on a canvas of the design size (page area beyond the
 * design is ignored; missing page area counts as different and is reported as a size mismatch).
 */
export function compareImages(designBuf, actualBuf, { threshold = 0.1, includeAA = false } = {}) {
    const design = flattenOnWhite(readPng(designBuf));
    const actualRaw = flattenOnWhite(readPng(actualBuf));
    const w = design.width;
    const h = design.height;
    const actual = actualRaw.width === w && actualRaw.height === h ? actualRaw : padTo(actualRaw, w, h);
    const diff = new PNG({ width: w, height: h });
    const mismatched = pixelmatch(design.data, actual.data, diff.data, w, h, { threshold, includeAA, alpha: 0.2, diffColor: [255, 0, 80], aaColor: [255, 200, 0] });
    // Rebuild a boolean mask from the diff image (diffColor pixels).
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++) { const o = i * 4; if (diff.data[o] === 255 && diff.data[o + 1] === 0 && diff.data[o + 2] === 80) mask[i] = 1; }
    const hotspots = findHotspots(mask, w, h);
    return {
        width: w,
        height: h,
        designSize: { width: design.width, height: design.height },
        actualSize: { width: actualRaw.width, height: actualRaw.height },
        sizeMismatch: actualRaw.width !== w || actualRaw.height < h,
        mismatchedPixels: mismatched,
        mismatchPercent: Math.round((mismatched / (w * h)) * 10000) / 100,
        hotspots,
        diffPng: writePng(diff),
        actualAlignedPng: writePng(actual),
        designPng: writePng(design),
    };
}
