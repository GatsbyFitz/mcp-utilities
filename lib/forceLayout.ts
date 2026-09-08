// ---------------------------------------------------------------------------
// A small force-directed layout, written here rather than pulled in.
//
// The alternatives (d3-force, react-force-graph) are a dependency and a bundle
// for roughly sixty lines of physics, and this repo already prefers building
// the small thing — the upload progress bar is plain divs for the same reason.
//
// Repulsion is the only quadratic part, so it is bucketed into a uniform grid
// and evaluated only between nodes in adjoining cells. Beyond REPULSION_RADIUS
// the 1/d falloff contributes almost nothing anyway, so the cutoff costs
// accuracy that is not visible and turns O(n²) into roughly O(n).
// ---------------------------------------------------------------------------

const REPULSION_RADIUS = 170;
const REPULSION_STRENGTH = 1400;
const SPRING_LENGTH = 72;
const SPRING_STRENGTH = 0.035;
const GRAVITY = 0.0016;
const DAMPING = 0.86;
const ALPHA_DECAY = 0.988;

/** Below this the layout has settled and the caller can stop ticking. */
export const ALPHA_MIN = 0.02;

export interface LayoutNode {
  name: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  /** Edge count. Hubs are heavier, so the periphery arranges around them. */
  degree: number;
  /** Set while a node is being dragged: forces accumulate but never move it. */
  pinned: boolean;
}

export interface LayoutEdge {
  /** Indices into `nodes`, resolved once so the tick loop never does lookups. */
  source: number;
  target: number;
}

export interface Layout {
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  alpha: number;
  tick(): number;
}

/**
 * Seeds positions on a phyllotaxis spiral rather than at random. Random seeds
 * routinely start two clusters overlapped and the layout never separates them;
 * the spiral is even, deterministic, and makes a reload reproduce a comparable
 * picture instead of a different one every time.
 */
function seedPosition(i: number): { x: number; y: number } {
  const radius = 12 * Math.sqrt(i);
  const angle = i * 2.399963229728653; // golden angle
  return { x: radius * Math.cos(angle), y: radius * Math.sin(angle) };
}

export function createLayout(
  names: { name: string; degree: number }[],
  links: { source: string; target: string }[]
): Layout {
  const index = new Map<string, number>();
  const nodes: LayoutNode[] = names.map((n, i) => {
    index.set(n.name, i);
    const { x, y } = seedPosition(i);
    return { name: n.name, x, y, vx: 0, vy: 0, degree: n.degree, pinned: false };
  });

  const edges: LayoutEdge[] = [];
  for (const link of links) {
    const source = index.get(link.source);
    const target = index.get(link.target);
    if (source === undefined || target === undefined || source === target) continue;
    edges.push({ source, target });
  }

  const layout: Layout = {
    nodes,
    edges,
    alpha: 1,
    tick() {
      const { alpha } = layout;
      const cell = REPULSION_RADIUS;
      const buckets = new Map<string, number[]>();

      for (let i = 0; i < nodes.length; i++) {
        const key = `${Math.floor(nodes[i].x / cell)},${Math.floor(nodes[i].y / cell)}`;
        const bucket = buckets.get(key);
        if (bucket) bucket.push(i);
        else buckets.set(key, [i]);
      }

      // Repulsion, nearest cells only.
      for (let i = 0; i < nodes.length; i++) {
        const a = nodes[i];
        const cx = Math.floor(a.x / cell);
        const cy = Math.floor(a.y / cell);
        for (let ox = -1; ox <= 1; ox++) {
          for (let oy = -1; oy <= 1; oy++) {
            const bucket = buckets.get(`${cx + ox},${cy + oy}`);
            if (!bucket) continue;
            for (const j of bucket) {
              if (j <= i) continue;
              const b = nodes[j];
              let dx = a.x - b.x;
              let dy = a.y - b.y;
              let distance = Math.hypot(dx, dy);
              if (distance > REPULSION_RADIUS) continue;
              // Two nodes at the same point have no direction to separate
              // along, so give them one instead of dividing by zero.
              if (distance < 0.01) {
                dx = (Math.random() - 0.5) * 0.1;
                dy = (Math.random() - 0.5) * 0.1;
                distance = 0.01;
              }
              const force = (REPULSION_STRENGTH * alpha) / (distance * distance);
              const fx = (dx / distance) * force;
              const fy = (dy / distance) * force;
              a.vx += fx / massOf(a);
              a.vy += fy / massOf(a);
              b.vx -= fx / massOf(b);
              b.vy -= fy / massOf(b);
            }
          }
        }
      }

      // Springs along edges.
      for (const edge of edges) {
        const a = nodes[edge.source];
        const b = nodes[edge.target];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const distance = Math.hypot(dx, dy) || 0.01;
        const force = (distance - SPRING_LENGTH) * SPRING_STRENGTH * alpha;
        const fx = (dx / distance) * force;
        const fy = (dy / distance) * force;
        a.vx += fx / massOf(a);
        a.vy += fy / massOf(a);
        b.vx -= fx / massOf(b);
        b.vy -= fy / massOf(b);
      }

      // Weak pull to the origin, so disconnected components don't drift off.
      for (const node of nodes) {
        node.vx -= node.x * GRAVITY * alpha;
        node.vy -= node.y * GRAVITY * alpha;
      }

      for (const node of nodes) {
        if (node.pinned) {
          node.vx = 0;
          node.vy = 0;
          continue;
        }
        node.vx *= DAMPING;
        node.vy *= DAMPING;
        node.x += node.vx;
        node.y += node.vy;
      }

      layout.alpha = alpha * ALPHA_DECAY;
      return layout.alpha;
    },
  };

  return layout;
}

/** Hubs resist being flung around by their many neighbours. */
function massOf(node: LayoutNode): number {
  return 1 + node.degree * 0.35;
}

/** Bounding box of the settled layout, for a fit-to-view transform. */
export function boundsOf(nodes: LayoutNode[]) {
  if (nodes.length === 0) return { minX: -1, minY: -1, maxX: 1, maxY: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of nodes) {
    if (node.x < minX) minX = node.x;
    if (node.y < minY) minY = node.y;
    if (node.x > maxX) maxX = node.x;
    if (node.y > maxY) maxY = node.y;
  }
  return { minX, minY, maxX, maxY };
}
