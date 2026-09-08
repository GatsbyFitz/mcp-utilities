"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, Loader2, Maximize2, RefreshCw, Search, X } from "lucide-react";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import {
  ALPHA_MIN,
  boundsOf,
  createLayout,
  type Layout,
  type LayoutNode,
} from "@/lib/forceLayout";

type GraphNode = { name: string; type: string | null; degree: number };
type GraphEdge = {
  source: string;
  target: string;
  type: string;
  description: string;
  sourceDoc: string;
};
type GraphData = {
  success: boolean;
  nodes: GraphNode[];
  edges: GraphEdge[];
  documents: string[];
  stats: {
    entityCount: number;
    relationshipCount: number;
    returnedNodes: number;
    returnedEdges: number;
    truncated: boolean;
    limit: number;
  };
};

// Distinguishable at small sizes on both the light and the dark background.
const TYPE_COLOURS = [
  "#3b82f6",
  "#f97316",
  "#10b981",
  "#a855f7",
  "#ef4444",
  "#14b8a6",
  "#eab308",
  "#ec4899",
  "#6366f1",
];
const UNTYPED_COLOUR = "#94a3b8";

function radiusOf(degree: number): number {
  return Math.min(3 + Math.sqrt(degree) * 1.7, 16);
}

export default function GraphPage() {
  const [data, setData] = useState<GraphData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [laidOut, setLaidOut] = useState(false);

  const [search, setSearch] = useState("");
  const [activeDocs, setActiveDocs] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const layoutRef = useRef<Layout | null>(null);
  const viewRef = useRef({ scale: 1, x: 0, y: 0 });
  const dirtyRef = useRef(true);
  // Whether the layout has come to rest, and whether the user has pushed the
  // view around since. Together they decide if the settle re-fit is welcome or
  // would yank the canvas out from under someone who is reading it.
  const settledRef = useRef(false);
  const movedRef = useRef(false);
  const dragRef = useRef<
    | { kind: "node"; node: LayoutNode }
    | { kind: "pan"; startX: number; startY: number; originX: number; originY: number }
    | null
  >(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/graph", { cache: "no-store" });
      const body = (await res.json()) as GraphData & { error?: string };
      if (!res.ok || !body.success) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      setData(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not load the graph");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // The graph actually drawn: every edge, or only those from the selected
  // documents. Degrees are recomputed from the filtered edges, so a node's
  // size reflects the view rather than the whole corpus.
  const view = useMemo(() => {
    if (!data) return null;
    const edges =
      activeDocs.size === 0
        ? data.edges
        : data.edges.filter((edge) => activeDocs.has(edge.sourceDoc));

    const degree = new Map<string, number>();
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
    }

    const types = new Map(data.nodes.map((n) => [n.name, n.type]));
    const nodes: GraphNode[] = [...degree.entries()].map(([name, count]) => ({
      name,
      type: types.get(name) ?? null,
      degree: count,
    }));

    const neighbours = new Map<string, Set<string>>();
    for (const edge of edges) {
      if (!neighbours.has(edge.source)) neighbours.set(edge.source, new Set());
      if (!neighbours.has(edge.target)) neighbours.set(edge.target, new Set());
      neighbours.get(edge.source)!.add(edge.target);
      neighbours.get(edge.target)!.add(edge.source);
    }

    return { nodes, edges, neighbours };
  }, [data, activeDocs]);

  // Entity types ranked by how many nodes carry them; the top few get a colour
  // and a legend entry, the long tail shares one neutral colour.
  const colourOf = useMemo(() => {
    const counts = new Map<string, number>();
    for (const node of view?.nodes ?? []) {
      if (node.type) counts.set(node.type, (counts.get(node.type) ?? 0) + 1);
    }
    const ranked = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, TYPE_COLOURS.length);
    const assigned = new Map(ranked.map(([type], i) => [type, TYPE_COLOURS[i]]));
    return {
      legend: ranked.map(([type, count], i) => ({
        type,
        count,
        colour: TYPE_COLOURS[i],
      })),
      of: (type: string | null) => (type && assigned.get(type)) || UNTYPED_COLOUR,
    };
  }, [view]);

  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term || !view) return null;
    return new Set(
      view.nodes.filter((n) => n.name.toLowerCase().includes(term)).map((n) => n.name)
    );
  }, [search, view]);

  const fitToView = useCallback(() => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!canvas || !layout || layout.nodes.length === 0) return;
    const { minX, minY, maxX, maxY } = boundsOf(layout.nodes);
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const padding = 60;
    const scale = Math.min(
      (width - padding * 2) / Math.max(maxX - minX, 1),
      (height - padding * 2) / Math.max(maxY - minY, 1),
      2.5
    );
    viewRef.current = {
      scale,
      x: width / 2 - ((minX + maxX) / 2) * scale,
      y: height / 2 - ((minY + maxY) / 2) * scale,
    };
    dirtyRef.current = true;
  }, []);

  const fitAndRelease = useCallback(() => {
    movedRef.current = false;
    fitToView();
  }, [fitToView]);

  // Build a layout whenever the filtered graph changes, and warm it up before
  // the first paint: animating out of the seed spiral reads as a glitch, and
  // fitting the view to that spiral zooms onto a dot.
  //
  // The warmup is budgeted in milliseconds, not ticks. A tick costs ~2ms at
  // 400 nodes and ~30ms at 2,500, so a fixed 120 ticks is a 240ms pause on a
  // small graph and a 3.7s frozen tab on a large one. Whatever the budget
  // buys is enough to fit sensibly; the rest settles in the animation loop,
  // which re-fits once it comes to rest.
  useEffect(() => {
    if (!view) return;
    setLaidOut(false);
    const layout = createLayout(
      view.nodes.map((n) => ({ name: n.name, degree: n.degree })),
      view.edges
    );
    const deadline = performance.now() + 300;
    for (let i = 0; i < 120 && performance.now() < deadline; i++) layout.tick();
    layoutRef.current = layout;
    settledRef.current = false;
    movedRef.current = false;
    fitToView();
    setLaidOut(true);
    dirtyRef.current = true;
  }, [view, fitToView]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!canvas || !layout || !view) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    if (canvas.width !== width * dpr || canvas.height !== height * dpr) {
      canvas.width = width * dpr;
      canvas.height = height * dpr;
    }

    const textColour = getComputedStyle(canvas).color;
    const { scale, x: panX, y: panY } = viewRef.current;

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    ctx.save();
    ctx.translate(panX, panY);
    ctx.scale(scale, scale);

    const focus = hovered ?? selected;
    const near = focus ? view.neighbours.get(focus) : null;
    const isLit = (name: string) => {
      if (focus) return name === focus || Boolean(near?.has(name));
      if (matches) return matches.has(name);
      return true;
    };

    const positions = new Map(layout.nodes.map((n) => [n.name, n]));

    ctx.lineWidth = 1 / scale;
    for (const edge of view.edges) {
      const a = positions.get(edge.source);
      const b = positions.get(edge.target);
      if (!a || !b) continue;
      const lit = isLit(edge.source) && isLit(edge.target);
      const incident = focus
        ? edge.source === focus || edge.target === focus
        : lit;
      ctx.globalAlpha = incident ? 0.55 : lit ? 0.18 : 0.04;
      ctx.strokeStyle = incident ? colourOf.of(null) : textColour;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }

    const typeOf = new Map(view.nodes.map((n) => [n.name, n.type]));
    for (const node of layout.nodes) {
      const lit = isLit(node.name);
      ctx.globalAlpha = lit ? 1 : 0.12;
      ctx.fillStyle = colourOf.of(typeOf.get(node.name) ?? null);
      ctx.beginPath();
      ctx.arc(node.x, node.y, radiusOf(node.degree), 0, Math.PI * 2);
      ctx.fill();
      if (node.name === selected) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = textColour;
        ctx.lineWidth = 2 / scale;
        ctx.stroke();
        ctx.lineWidth = 1 / scale;
      }
    }

    // Labels are the thing that turns a hairball into something readable, and
    // also the thing that makes it unreadable if every node gets one. Only the
    // hubs get a permanent label; zooming in lowers the bar.
    const labelFloor = scale > 1.6 ? 2 : scale > 0.9 ? 5 : 10;
    ctx.font = `${12 / scale}px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const node of layout.nodes) {
      const lit = isLit(node.name);
      const named = node.name === focus || (matches?.has(node.name) ?? false);
      if (!named && (node.degree < labelFloor || !lit)) continue;
      ctx.globalAlpha = lit ? 0.95 : 0.15;
      ctx.fillStyle = textColour;
      ctx.fillText(node.name, node.x, node.y + radiusOf(node.degree) + 3 / scale);
    }

    ctx.restore();
    ctx.globalAlpha = 1;
  }, [view, colourOf, hovered, selected, matches]);

  // One rAF loop for the page's lifetime. It ticks only while the layout is
  // still moving and redraws only when something changed, so a settled graph
  // costs a comparison per frame.
  useEffect(() => {
    let frame = 0;
    const loop = () => {
      const layout = layoutRef.current;
      if (layout && layout.alpha > ALPHA_MIN) {
        layout.tick();
        dirtyRef.current = true;
      } else if (layout && !settledRef.current) {
        // First time it comes to rest. The warmup fit was made against a
        // half-arranged graph, so re-fit now that the extent is final —
        // unless the user has already framed it themselves.
        settledRef.current = true;
        if (!movedRef.current) fitToView();
      }
      if (dirtyRef.current) {
        draw();
        dirtyRef.current = false;
      }
      frame = requestAnimationFrame(loop);
    };
    frame = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(frame);
  }, [draw, fitToView]);

  useEffect(() => {
    dirtyRef.current = true;
  }, [hovered, selected, matches]);

  useEffect(() => {
    const onResize = () => {
      dirtyRef.current = true;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  const nodeAt = useCallback((clientX: number, clientY: number): LayoutNode | null => {
    const canvas = canvasRef.current;
    const layout = layoutRef.current;
    if (!canvas || !layout) return null;
    const rect = canvas.getBoundingClientRect();
    const { scale, x: panX, y: panY } = viewRef.current;
    const wx = (clientX - rect.left - panX) / scale;
    const wy = (clientY - rect.top - panY) / scale;
    let best: LayoutNode | null = null;
    let bestDistance = Infinity;
    for (const node of layout.nodes) {
      const distance = Math.hypot(node.x - wx, node.y - wy);
      const hit = radiusOf(node.degree) + 4 / scale;
      if (distance < hit && distance < bestDistance) {
        best = node;
        bestDistance = distance;
      }
    }
    return best;
  }, []);

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    const node = nodeAt(e.clientX, e.clientY);
    if (node) {
      node.pinned = true;
      dragRef.current = { kind: "node", node };
      setSelected(node.name);
    } else {
      dragRef.current = {
        kind: "pan",
        startX: e.clientX,
        startY: e.clientY,
        originX: viewRef.current.x,
        originY: viewRef.current.y,
      };
    }
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    const canvas = canvasRef.current;
    if (!canvas) return;

    if (drag?.kind === "node") {
      const rect = canvas.getBoundingClientRect();
      const { scale, x: panX, y: panY } = viewRef.current;
      drag.node.x = (e.clientX - rect.left - panX) / scale;
      drag.node.y = (e.clientY - rect.top - panY) / scale;
      const layout = layoutRef.current;
      // Reheat so the neighbourhood rearranges around where it was dropped.
      if (layout) layout.alpha = Math.max(layout.alpha, 0.3);
      dirtyRef.current = true;
      return;
    }

    if (drag?.kind === "pan") {
      movedRef.current = true;
      viewRef.current.x = drag.originX + (e.clientX - drag.startX);
      viewRef.current.y = drag.originY + (e.clientY - drag.startY);
      dirtyRef.current = true;
      return;
    }

    const node = nodeAt(e.clientX, e.clientY);
    const name = node?.name ?? null;
    setHovered((current) => (current === name ? current : name));
    canvas.style.cursor = node ? "pointer" : "grab";
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    if (drag?.kind === "node") drag.node.pinned = false;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
  };

  // Zoom about the pointer, so the thing under the cursor stays under it.
  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const current = viewRef.current;
    movedRef.current = true;
    const factor = Math.exp(-e.deltaY * 0.0015);
    const scale = Math.min(Math.max(current.scale * factor, 0.05), 8);
    viewRef.current = {
      scale,
      x: px - ((px - current.x) / current.scale) * scale,
      y: py - ((py - current.y) / current.scale) * scale,
    };
    dirtyRef.current = true;
  };

  const toggleDoc = (doc: string) => {
    setActiveDocs((current) => {
      const next = new Set(current);
      if (next.has(doc)) next.delete(doc);
      else next.add(doc);
      return next;
    });
    setSelected(null);
  };

  const selectedEdges = useMemo(() => {
    if (!selected || !view) return [];
    return view.edges.filter(
      (edge) => edge.source === selected || edge.target === selected
    );
  }, [selected, view]);

  return (
    <div className="min-h-screen bg-background p-6">
      <div className="mx-auto flex max-w-[1600px] flex-col gap-4">
        <Card>
          <CardHeader>
            <CardTitle>Knowledge graph</CardTitle>
            <CardDescription>
              {data
                ? `${data.stats.entityCount.toLocaleString()} entities and ` +
                  `${data.stats.relationshipCount.toLocaleString()} relationships ` +
                  `extracted across ${data.documents.length} document(s)` +
                  (data.stats.truncated
                    ? ` — showing the ${data.stats.returnedEdges.toLocaleString()} best-connected`
                    : "")
                : "Every entity and relationship extracted from the corpus"}
            </CardDescription>
            <CardAction>
              <div className="flex gap-2">
                <Link
                  href="/"
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                >
                  <ArrowLeft />
                  Knowledge base
                </Link>
                <Button variant="outline" size="sm" onClick={fitAndRelease} disabled={!laidOut}>
                  <Maximize2 />
                  Fit
                </Button>
                <Button variant="outline" size="sm" onClick={load} disabled={loading}>
                  <RefreshCw className={loading ? "animate-spin" : ""} />
                  Refresh
                </Button>
              </div>
            </CardAction>
          </CardHeader>
        </Card>

        {error && (
          <Card>
            <CardContent className="text-sm text-destructive">{error}</CardContent>
          </Card>
        )}

        <div className="flex flex-col gap-4 lg:flex-row">
          <Card className="flex-1 overflow-hidden p-0">
            <CardContent className="relative h-[70vh] p-0">
              {(loading || !laidOut) && (
                <div className="absolute inset-0 z-10 flex items-center justify-center gap-2 bg-background/70 text-sm text-muted-foreground">
                  <Loader2 className="size-4 animate-spin" />
                  {loading ? "Reading the graph…" : "Laying it out…"}
                </div>
              )}
              <canvas
                ref={canvasRef}
                className="size-full touch-none text-foreground"
                style={{ cursor: "grab" }}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerLeave={() => setHovered(null)}
                onWheel={onWheel}
              />
              {view && view.nodes.length === 0 && !loading && (
                <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
                  No relationships to show for this filter.
                </div>
              )}
              <p className="pointer-events-none absolute bottom-2 left-3 text-xs text-muted-foreground">
                Scroll to zoom · drag the background to pan · drag a node to move it
              </p>
            </CardContent>
          </Card>

          <div className="flex w-full flex-col gap-4 lg:w-80">
            <Card>
              <CardContent className="flex flex-col gap-3">
                <div className="relative">
                  <Search className="pointer-events-none absolute top-1/2 left-2 size-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={search}
                    onChange={(e) => setSearch(e.target.value)}
                    placeholder="Highlight entities…"
                    className="pl-8"
                  />
                </div>
                {matches && (
                  <p className="text-xs text-muted-foreground">
                    {matches.size} match{matches.size === 1 ? "" : "es"}
                  </p>
                )}
                {colourOf.legend.length > 0 && (
                  <div className="flex flex-wrap gap-x-3 gap-y-1">
                    {colourOf.legend.map((entry) => (
                      <span
                        key={entry.type}
                        className="flex items-center gap-1.5 text-xs text-muted-foreground"
                      >
                        <span
                          className="size-2.5 rounded-full"
                          style={{ backgroundColor: entry.colour }}
                        />
                        {entry.type} ({entry.count})
                      </span>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {data && data.documents.length > 1 && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm">Documents</CardTitle>
                  <CardDescription>
                    {activeDocs.size === 0
                      ? "All documents"
                      : `${activeDocs.size} selected`}
                  </CardDescription>
                  {activeDocs.size > 0 && (
                    <CardAction>
                      <Button
                        variant="ghost"
                        size="xs"
                        onClick={() => setActiveDocs(new Set())}
                      >
                        <X />
                        Clear
                      </Button>
                    </CardAction>
                  )}
                </CardHeader>
                <CardContent className="flex max-h-56 flex-col gap-1 overflow-y-auto">
                  {data.documents.map((doc) => (
                    <button
                      key={doc}
                      type="button"
                      onClick={() => toggleDoc(doc)}
                      className={cn(
                        "truncate rounded-md px-2 py-1 text-left text-xs transition-colors",
                        activeDocs.has(doc)
                          ? "bg-primary/10 text-foreground"
                          : "text-muted-foreground hover:bg-muted"
                      )}
                      title={doc}
                    >
                      {doc}
                    </button>
                  ))}
                </CardContent>
              </Card>
            )}

            {selected && (
              <Card>
                <CardHeader>
                  <CardTitle className="text-sm break-words">{selected}</CardTitle>
                  <CardDescription>
                    {selectedEdges.length} relationship
                    {selectedEdges.length === 1 ? "" : "s"}
                  </CardDescription>
                  <CardAction>
                    <Button variant="ghost" size="xs" onClick={() => setSelected(null)}>
                      <X />
                    </Button>
                  </CardAction>
                </CardHeader>
                <CardContent className="flex max-h-80 flex-col gap-3 overflow-y-auto">
                  {selectedEdges.map((edge, i) => {
                    const other = edge.source === selected ? edge.target : edge.source;
                    const outgoing = edge.source === selected;
                    return (
                      <div key={`${edge.source}-${edge.target}-${i}`} className="text-xs">
                        <button
                          type="button"
                          onClick={() => setSelected(other)}
                          className="text-left font-medium hover:underline"
                        >
                          {outgoing ? "→" : "←"} {other}
                        </button>
                        <p className="text-muted-foreground">{edge.type}</p>
                        {edge.description && (
                          <p className="mt-0.5 text-muted-foreground">{edge.description}</p>
                        )}
                        <p className="mt-0.5 truncate text-muted-foreground/70" title={edge.sourceDoc}>
                          {edge.sourceDoc}
                        </p>
                      </div>
                    );
                  })}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
