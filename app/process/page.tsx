"use client";

import { useEffect, useMemo, useState } from "react";
import { useMcpApp } from "@/app/hooks/use-mcp-app";

// ---------------------------------------------------------------------------
// The viewer behind `display_process`
// ---------------------------------------------------------------------------
// Rendered inside the host's iframe. Everything it shows arrives through the
// MCP bridge as the tool's `structuredContent` — the iframe carries no session
// cookie, so it cannot call the app's own authenticated routes.
//
// It prefers a transcribed process to the figure it came from: a Mermaid
// flowchart is legible, selectable and scales, where the crop is a picture of
// one. The crop stays one click away, because a transcription is a claim about
// the diagram and the diagram is the evidence.
//
// Styling is inline and driven by the host's CSS variables rather than by this
// app's Tailwind theme, so the viewer takes on the surrounding conversation's
// colours and fonts. Every variable has a fallback, because a host that sets
// none must still be legible.

interface ProcessDiagram {
  id: string;
  title: string;
  document: string;
  page: number | null;
  mermaid: string;
  mermaidValid: boolean;
  actors: string[];
  imageUrl: string | null;
  sourceUrl: string | null;
}

interface ProcessFigure {
  id: string;
  title: string;
  document: string;
  page: number | null;
  description: string;
  imageUrl: string;
  sourceUrl: string | null;
}

interface ToolResult {
  query?: string;
  document?: string | null;
  processes?: ProcessDiagram[];
  figures?: ProcessFigure[];
}

const surface = "var(--color-background-secondary, #f6f6f5)";
const text = "var(--color-text-primary, #1a1a19)";
const muted = "var(--color-text-secondary, #6b6b68)";
const border = "var(--color-border-primary, #dededc)";
const radius = "var(--border-radius-md, 8px)";
const sans = "var(--font-sans, ui-sans-serif, system-ui, sans-serif)";

export default function ProcessViewer() {
  const { connected, toolResult } = useMcpApp();
  const result = (toolResult ?? {}) as ToolResult;
  // Memoised on the arrays the bridge hands over, not rebuilt per render: the
  // effects below depend on them, and a fresh `[]` each render would re-run
  // those effects every time — which is what once made the zoom toggle appear
  // not to work at all.
  const processes = useMemo(() => result.processes ?? [], [result.processes]);
  const figures = useMemo(() => result.figures ?? [], [result.figures]);

  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Follow the result rather than the selection: a second call replaces
  // everything, and a stale id would leave the viewer blank with no explanation.
  useEffect(() => {
    const ids = [...processes.map((p) => p.id), ...figures.map((f) => f.id)];
    setSelectedId((current) => (current && ids.includes(current) ? current : (ids[0] ?? null)));
  }, [processes, figures]);

  const process =
    processes.find((p) => p.id === selectedId) ?? (figures.length === 0 ? processes[0] : null) ?? null;
  const figure =
    figures.find((f) => f.id === selectedId) ?? (processes.length === 0 ? figures[0] : null) ?? null;

  if (!process && !figure) {
    return (
      <main style={{ fontFamily: sans, color: muted, padding: 24, fontSize: 14 }}>
        {connected
          ? `No process to display${result.query ? ` for “${result.query}”` : ""}.`
          : "This viewer runs inside an MCP host. Call display_process to open it with a process."}
      </main>
    );
  }

  const heading = process ?? figure!;
  const total = processes.length + figures.length;

  return (
    <main style={{ fontFamily: sans, color: text, padding: 16, display: "grid", gap: 12 }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{heading.title}</h1>
        <span style={{ color: muted, fontSize: 13 }}>
          {heading.page !== null ? `p. ${heading.page}` : "page unknown"}
          {total > 1 ? ` · ${total} results` : ""}
        </span>
      </header>

      {process ? <Diagram process={process} /> : <FigureImage figure={figure!} />}

      {total > 1 && (
        <nav style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
          {[...processes, ...figures].map((item) => {
            const active = item.id === selectedId;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setSelectedId(item.id)}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  fontSize: 12,
                  padding: "4px 10px",
                  borderRadius: radius,
                  border: `1px solid ${active ? text : border}`,
                  background: active ? surface : "transparent",
                  color: active ? text : muted,
                  maxWidth: 240,
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
                title={item.title}
              >
                {item.title}
              </button>
            );
          })}
        </nav>
      )}
    </main>
  );
}

/**
 * The transcribed process, rendered.
 *
 * `mermaid.parse` before `mermaid.render` so a diagram that cannot be drawn
 * says so and shows the original crop instead. Without that the failure is an
 * empty frame with nothing explaining it, which is the worst outcome available
 * here — the reader cannot tell a broken transcription from a missing one.
 */
function Diagram({ process }: { process: ProcessDiagram }) {
  const [svg, setSvg] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setSvg(null);
    setFailed(false);

    (async () => {
      try {
        // Dynamic so mermaid's weight lands on this route and nowhere else,
        // and so it is never pulled into a server render.
        const mermaid = (await import("mermaid")).default;
        mermaid.initialize({
          startOnLoad: false,
          theme: "neutral",
          // The diagram is model output transcribed from someone's PDF, so it
          // is not trusted input: strict makes mermaid sanitise labels rather
          // than pass HTML through.
          securityLevel: "strict",
        });
        await mermaid.parse(process.mermaid);
        const id = `mmd-${process.id.replace(/[^a-zA-Z0-9]/g, "-")}`;
        const rendered = await mermaid.render(id, process.mermaid);
        if (!cancelled) setSvg(rendered.svg);
      } catch (error) {
        console.warn("[process] mermaid render failed:", error);
        if (!cancelled) setFailed(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [process]);

  return (
    <>
      {process.actors.length > 0 && (
        <p style={{ margin: 0, fontSize: 13, color: muted }}>{process.actors.join(" · ")}</p>
      )}

      <div
        style={{
          background: surface,
          border: `1px solid ${border}`,
          borderRadius: radius,
          padding: 12,
          overflow: "auto",
        }}
      >
        {svg ? (
          // mermaid's own output, already sanitised by securityLevel: "strict".
          <div dangerouslySetInnerHTML={{ __html: svg }} />
        ) : failed ? (
          <div style={{ display: "grid", gap: 8 }}>
            <p style={{ margin: 0, fontSize: 13, color: muted }}>
              This process could not be drawn, so here is the original figure.
            </p>
            {process.imageUrl && (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={process.imageUrl}
                alt={process.title}
                style={{ width: "100%", height: "auto" }}
              />
            )}
          </div>
        ) : (
          <p style={{ margin: 0, fontSize: 13, color: muted }}>Drawing…</p>
        )}
      </div>

      <p style={{ margin: 0, fontSize: 13, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <button
          type="button"
          onClick={() => setShowSource((v) => !v)}
          style={{ all: "unset", cursor: "pointer", textDecoration: "underline" }}
        >
          {showSource ? "Hide Mermaid" : "Show Mermaid"}
        </button>
        {process.imageUrl && (
          <a href={process.imageUrl} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
            Original figure
          </a>
        )}
        {process.sourceUrl && (
          <a href={process.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
            {process.page !== null ? `Source page ${process.page}` : "Source document"}
          </a>
        )}
      </p>

      {showSource && (
        <pre
          style={{
            margin: 0,
            padding: 12,
            background: surface,
            border: `1px solid ${border}`,
            borderRadius: radius,
            fontSize: 12,
            overflow: "auto",
            whiteSpace: "pre",
          }}
        >
          {process.mermaid}
        </pre>
      )}
    </>
  );
}

/** A figure with no transcribed process — what this viewer showed before. */
function FigureImage({ figure }: { figure: ProcessFigure }) {
  const [zoomed, setZoomed] = useState(false);
  useEffect(() => setZoomed(false), [figure]);

  return (
    <>
      <button
        type="button"
        onClick={() => setZoomed((z) => !z)}
        title={zoomed ? "Fit to view" : "Zoom to full resolution"}
        style={{
          all: "unset",
          cursor: zoomed ? "zoom-out" : "zoom-in",
          display: "block",
          background: surface,
          border: `1px solid ${border}`,
          borderRadius: radius,
          padding: 8,
          overflow: "auto",
          maxHeight: zoomed ? "none" : "60vh",
        }}
      >
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img
          src={figure.imageUrl}
          alt={figure.description.slice(0, 200) || figure.title}
          style={{
            display: "block",
            width: zoomed ? "auto" : "100%",
            maxWidth: zoomed ? "none" : "100%",
            height: "auto",
          }}
        />
      </button>

      {figure.description && (
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: muted }}>{figure.description}</p>
      )}

      <p style={{ margin: 0, fontSize: 13, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <a href={figure.imageUrl} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
          Open figure
        </a>
        {figure.sourceUrl && (
          <a href={figure.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
            {figure.page !== null ? `Source page ${figure.page}` : "Source document"}
          </a>
        )}
      </p>
    </>
  );
}
