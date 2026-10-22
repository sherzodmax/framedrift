// Map diff hotspots back to Figma layers so the report says *what* drifted, not just where.

/**
 * Flatten a Figma node subtree into boxes relative to the root frame, in image pixels.
 * @returns {{id,name,type,depth,path,x,y,width,height,componentId?,characters?}[]}
 */
export function flattenLayers(root, { scale = 1 } = {}) {
    const origin = root.absoluteBoundingBox || { x: 0, y: 0 };
    const out = [];
    const visit = (n, depth, trail) => {
        if (n.visible === false) return;
        const b = n.absoluteBoundingBox;
        const p = [...trail, n.name];
        if (b && depth > 0) {
            out.push({
                id: n.id, name: n.name, type: n.type, depth, path: p.slice(1).join(' / '),
                x: (b.x - origin.x) * scale, y: (b.y - origin.y) * scale, width: b.width * scale, height: b.height * scale,
                ...(n.componentId ? { componentId: n.componentId } : {}),
                ...(n.type === 'TEXT' && n.characters ? { characters: String(n.characters).slice(0, 80) } : {}),
            });
        }
        for (const c of n.children || []) visit(c, depth + 1, p);
    };
    visit(root, 0, []);
    return out;
}

const overlap = (a, b) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));

/**
 * For each hotspot, pick the most specific layer covering it: highest overlap share of the
 * hotspot, ties broken by depth (deeper = more specific) and smaller area.
 */
export function attributeHotspots(hotspots, layers, components = {}) {
    return hotspots.map((h) => {
        const area = h.width * h.height || 1;
        let best = null;
        for (const l of layers) {
            const ov = overlap(h, l);
            if (!ov) continue;
            const share = ov / area;
            const score = share * 10 + l.depth * 0.5 - Math.log10(l.width * l.height + 1) * 0.3;
            if (!best || score > best.score) best = { l, score, share };
        }
        if (!best) return { ...h, layer: null };
        const { l } = best;
        const comp = l.componentId ? components[l.componentId] : null;
        return { ...h, layer: { id: l.id, name: l.name, type: l.type, path: l.path, ...(comp ? { component: comp.name } : {}), ...(l.characters ? { text: l.characters } : {}) } };
    });
}
