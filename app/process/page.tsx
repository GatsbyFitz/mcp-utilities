"use client";

import { useEffect, useState } from "react";
import { useMcpApp } from "@/app/hooks/use-mcp-app";

// ---------------------------------------------------------------------------
// The viewer behind `display_process`
// ---------------------------------------------------------------------------
// Rendered inside the host's iframe. Everything it shows arrives through the
// MCP bridge as the tool's `structuredContent` — the iframe carries no session
// cookie, so it cannot call the app's own authenticated routes, and the only
// thing it loads over the network is the figure images themselves.
//
// Styling is inline and driven by the host's CSS variables rather than by this
// app's Tailwind theme, so the viewer takes on the surrounding conversation's
// colours and fonts instead of looking like a pasted-in web page. Every
// variable has a fallback, because a host that sets none must still be legible.

interface ProcessFigure {
  id: string;
  title: string;
  document: string;
  page: number | null;
  description: string;
  imageUrl: string;
  sourceUrl: string | null;
  score: number;
}

interface ToolResult {
  query?: string;
  document?: string | null;
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
  const figures = result.figures ?? [];

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [zoomed, setZoomed] = useState(false);

  // Follow the result rather than the selection: a second call replaces the
  // figures, and a stale id would leave the viewer blank with no explanation.
  useEffect(() => {
    setSelectedId((current) =>
      current && figures.some((f) => f.id === current) ? current : (figures[0]?.id ?? null)
    );
    setZoomed(false);
  }, [figures]);

  const selected = figures.find((f) => f.id === selectedId) ?? figures[0] ?? null;

  if (!selected) {
    return (
      <main style={{ fontFamily: sans, color: muted, padding: 24, fontSize: 14 }}>
        {connected
          ? `No figures to display${result.query ? ` for “${result.query}”` : ""}.`
          : "This viewer runs inside an MCP host. Call display_process to open it with a process diagram."}
      </main>
    );
  }

  return (
    <main style={{ fontFamily: sans, color: text, padding: 16, display: "grid", gap: 12 }}>
      <header style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "baseline" }}>
        <h1 style={{ margin: 0, fontSize: 15, fontWeight: 600 }}>{selected.title}</h1>
        <span style={{ color: muted, fontSize: 13 }}>
          {selected.page !== null ? `p. ${selected.page}` : "page unknown"}
          {figures.length > 1 ? ` · ${figures.indexOf(selected) + 1} of ${figures.length}` : ""}
        </span>
      </header>

      {/* The figure. Click to toggle between fitting the pane and rendering at
          full width, which is the whole reason a viewer beats an inline image:
          the stored crop is up to 2048px and a dense flowchart is unreadable
          scaled down to a message column. */}
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
          src={selected.imageUrl}
          alt={selected.description.slice(0, 200) || selected.title}
          style={{
            display: "block",
            width: zoomed ? "auto" : "100%",
            maxWidth: zoomed ? "none" : "100%",
            height: "auto",
          }}
        />
      </button>

      {selected.description && (
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.5, color: muted }}>
          {selected.description}
        </p>
      )}

      <p style={{ margin: 0, fontSize: 13, display: "flex", gap: 12, flexWrap: "wrap" }}>
        <a href={selected.imageUrl} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
          Open figure
        </a>
        {selected.sourceUrl && (
          <a href={selected.sourceUrl} target="_blank" rel="noreferrer" style={{ color: "inherit" }}>
            {selected.page !== null ? `Source page ${selected.page}` : "Source document"}
          </a>
        )}
      </p>

      {/* Thumbnails only when there is a choice to make. */}
      {figures.length > 1 && (
        <nav style={{ display: "flex", gap: 8, overflowX: "auto", paddingBottom: 4 }}>
          {figures.map((figure) => {
            const active = figure.id === selected.id;
            return (
              <button
                key={figure.id}
                type="button"
                onClick={() => {
                  setSelectedId(figure.id);
                  setZoomed(false);
                }}
                title={`${figure.title}${figure.page !== null ? ` — p. ${figure.page}` : ""}`}
                style={{
                  all: "unset",
                  cursor: "pointer",
                  flex: "0 0 auto",
                  borderRadius: radius,
                  border: `2px solid ${active ? text : border}`,
                  opacity: active ? 1 : 0.65,
                  background: surface,
                  padding: 2,
                }}
              >
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={figure.imageUrl}
                  alt=""
                  style={{ display: "block", width: 96, height: 64, objectFit: "cover", borderRadius: 4 }}
                />
              </button>
            );
          })}
        </nav>
      )}
    </main>
  );
}
