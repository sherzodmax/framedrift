// One comparison: Figma frame (or local PNG) vs live page.
import fs from 'node:fs';
import path from 'node:path';
import { capturePage } from './capture.js';
import { compareImages, readPng } from './diff.js';
import { flattenLayers, attributeHotspots } from './layers.js';
import { parseFigmaUrl } from './figma.js';

export const slugify = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'frame';

/** Fetch frame metadata + PNG render from Figma. */
export async function fetchFigmaFrame(client, figmaUrl, { scale = 1 } = {}) {
    const { fileKey, nodeId } = parseFigmaUrl(figmaUrl);
    if (!nodeId) throw new Error(`Figma link has no node-id (select the frame in Figma and use "Copy link to selection"): ${figmaUrl}`);
    const nodesRes = await client.getNodes(fileKey, [nodeId]);
    const entry = nodesRes.nodes?.[nodeId];
    if (!entry?.document) throw new Error(`Node ${nodeId} not found in Figma file ${fileKey}`);
    const frame = entry.document;
    const bb = frame.absoluteBoundingBox;
    if (!bb) throw new Error(`Figma node ${nodeId} (${frame.type}) has no bounds; link a FRAME, COMPONENT or SECTION`);
    const images = await client.getImages(fileKey, [nodeId], { format: 'png', scale, useAbsoluteBounds: true });
    if (!images[nodeId]) throw new Error(`Figma could not render node ${nodeId} (it may be invisible or empty)`);
    const { buffer } = await client.download(images[nodeId]);
    const components = {};
    for (const [id, c] of Object.entries(entry.components || {})) {
        const set = c.componentSetId ? entry.componentSets?.[c.componentSetId] : null;
        components[id] = { name: set ? `${set.name} / ${c.name}` : c.name };
    }
    return { fileKey, nodeId, fileName: nodesRes.name, frame, width: bb.width, height: bb.height, png: buffer, components, lastModified: nodesRes.lastModified };
}

/**
 * @param {object} o
 * @param {import('playwright-core').Browser} o.browser
 * @param {string} o.url  page to capture
 * @param {string} [o.figma] Figma frame URL (needs o.client)
 * @param {import('./figma.js').FigmaClient} [o.client]
 * @param {string} [o.design] path to a design PNG instead of Figma
 * @param {string} o.outDir where design.png/actual.png/diff.png are written
 */
export async function compareOne(o) {
    const started = Date.now();
    const scale = o.scale || 1;
    let design;
    let width;
    let height;
    let figmaInfo = null;
    let layers = [];
    let components = {};
    if (o.figma) {
        const f = await fetchFigmaFrame(o.client, o.figma, { scale });
        design = f.png;
        width = f.width;
        height = f.height;
        figmaInfo = { fileKey: f.fileKey, nodeId: f.nodeId, fileName: f.fileName, frameName: f.frame.name, frameType: f.frame.type, lastModified: f.lastModified, url: o.figma };
        layers = flattenLayers(f.frame, { scale });
        components = f.components;
    } else if (o.design) {
        design = fs.readFileSync(o.design);
        const img = readPng(design);
        width = img.width / scale;
        height = img.height / scale;
    } else {
        throw new Error('Either a Figma frame URL or a design PNG is required');
    }
    if (o.viewport) { width = o.viewport.width; height = o.viewport.height ?? height; }
    const viewportHeight = o.viewportHeight && o.viewportHeight < height ? o.viewportHeight : height;
    const shot = await capturePage(o.browser, {
        url: o.url, width, height: viewportHeight, scale, fullPage: viewportHeight < height || o.fullPage,
        selector: o.selector, hide: o.hide, waitFor: o.waitFor, delayMs: o.delayMs, headers: o.headers, colorScheme: o.colorScheme, timeoutMs: o.timeoutMs,
    });
    const cmp = compareImages(design, shot.png, { threshold: o.threshold ?? 0.1 });
    const hotspots = attributeHotspots(cmp.hotspots, layers, components);
    fs.mkdirSync(o.outDir, { recursive: true });
    fs.writeFileSync(path.join(o.outDir, 'design.png'), cmp.designPng);
    fs.writeFileSync(path.join(o.outDir, 'actual.png'), cmp.actualAlignedPng);
    fs.writeFileSync(path.join(o.outDir, 'diff.png'), cmp.diffPng);
    return {
        name: o.name || figmaInfo?.frameName || path.basename(o.design || 'design'),
        url: o.url,
        finalUrl: shot.finalUrl,
        httpStatus: shot.status,
        figma: figmaInfo,
        design: o.design || null,
        scale,
        viewport: { width, height: viewportHeight },
        designSize: cmp.designSize,
        actualSize: cmp.actualSize,
        pageHeightCss: shot.pageHeight,
        sizeMismatch: cmp.sizeMismatch,
        mismatchedPixels: cmp.mismatchedPixels,
        mismatchPercent: cmp.mismatchPercent,
        threshold: o.threshold ?? 0.1,
        hotspots,
        files: { design: path.join(o.outDir, 'design.png'), actual: path.join(o.outDir, 'actual.png'), diff: path.join(o.outDir, 'diff.png') },
        durationMs: Date.now() - started,
    };
}
