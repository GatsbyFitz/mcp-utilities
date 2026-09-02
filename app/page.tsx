"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw, Sparkles, Trash2, LogOut, CheckCircle2, AlertCircle, Loader2, RotateCw } from "lucide-react";
import { signOut } from "next-auth/react";
import { upload } from "@vercel/blob/client";
import {
  MAX_UPLOAD_BYTES,
  normalizeName,
  uploadPathname,
  type UploadedFile,
} from "@/lib/upload";
import { INGEST_STEPS, isTerminalRunStatus, type IngestRunProgress } from "@/lib/ingestSteps";
import { Button, buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type KnowledgeBaseItem = {
  id: string;
  name: string;
  chunks: number;
  sizeBytes: number;
  uploadedAt: string;
  blobUrl: string | null;
  blobDownloadUrl: string | null;
  blobPath: string | null;
};

type KnowledgeBase = {
  success: boolean;
  items: KnowledgeBaseItem[];
};

// A run the page is following. The file name only exists client-side — the
// status endpoint deals purely in run IDs.
type TrackedRun = {
  runId: string;
  fileName: string;
};

// Run IDs are not persisted server-side, so they survive a reload only as far
// as this tab's sessionStorage does.
const TRACKED_RUNS_KEY = "ingestRuns";
const POLL_INTERVAL_MS = 2000;

function formatBytes(bytes: number): string {
  if (!bytes) return "—";
  const units = ["B", "KB", "MB", "GB"];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? "—"
    : date.toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
}

export default function UploadPage() {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
  const [knowledgeBase, setKnowledgeBase] = useState<KnowledgeBase | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [reembeddingAll, setReembeddingAll] = useState(false);
  const [reembeddingId, setReembeddingId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<{ text: string; error: boolean } | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [trackedRuns, setTrackedRuns] = useState<TrackedRun[]>([]);
  const [runProgress, setRunProgress] = useState<Record<string, IngestRunProgress>>({});
  const [notices, setNotices] = useState<string[]>([]);
  const [uploadProgress, setUploadProgress] = useState<{ fileName: string; percentage: number }[]>([]);
  const [retryingRunId, setRetryingRunId] = useState<string | null>(null);

  const refreshKnowledgeBase = useCallback(async () => {
    setRefreshing(true);
    try {
      const res = await fetch("/api/returnKnowledgeBase", { cache: "no-store" });
      if (!res.ok) {
        throw new Error(`Failed to fetch knowledge base: ${res.status}`);
      }
      setKnowledgeBase(await res.json());
    } catch (error) {
      console.error("Error fetching knowledge base:", error);
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => {
    refreshKnowledgeBase();
  }, [refreshKnowledgeBase]);

  // Recover runs from a reload mid-ingestion. Anything the runtime has since
  // forgotten comes back as "unknown" and simply stops being polled.
  useEffect(() => {
    try {
      const stored = sessionStorage.getItem(TRACKED_RUNS_KEY);
      if (stored) setTrackedRuns(JSON.parse(stored) as TrackedRun[]);
    } catch (error) {
      console.error("Error reading tracked runs:", error);
    }
  }, []);

  // Polls until every tracked run reaches a terminal state, then refreshes the
  // knowledge base once — this is the point at which recordUpload has actually
  // written the rows.
  useEffect(() => {
    if (trackedRuns.length === 0) return;

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function poll() {
      try {
        const params = new URLSearchParams();
        for (const run of trackedRuns) params.append("runId", run.runId);

        const res = await fetch(`/api/uploadStatus?${params.toString()}`, {
          cache: "no-store",
        });
        const data = await res.json();
        if (cancelled) return;

        if (res.ok && data.success) {
          const runs = data.runs as IngestRunProgress[];
          setRunProgress(Object.fromEntries(runs.map((run) => [run.runId, run])));

          if (runs.every((run) => isTerminalRunStatus(run.status))) {
            try {
              sessionStorage.removeItem(TRACKED_RUNS_KEY);
            } catch {
              // Nothing to recover from — the runs are already finished.
            }
            refreshKnowledgeBase();
            return;
          }
        }
      } catch (error) {
        console.error("Error fetching ingestion status:", error);
      }

      // Scheduled only after a response, so polls can never overlap.
      if (!cancelled) timer = setTimeout(poll, POLL_INTERVAL_MS);
    }

    poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [trackedRuns, refreshKnowledgeBase]);

  // Retries a failed ingestion from the Markdown it already persisted. The
  // runtime cannot resume a failed run in place, so the server starts a fresh
  // run; we swap the tracked run ID for the new one, which restarts polling.
  async function handleRetry(runId: string) {
    setRetryingRunId(runId);
    setActionMessage(null);
    try {
      const res = await fetch("/api/retryUpload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ runId }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error ?? `Retry failed: ${res.status}`);
      }

      setTrackedRuns((previous) => {
        const next = previous.map((run) =>
          run.runId === runId ? { ...run, runId: data.runId as string } : run
        );
        try {
          sessionStorage.setItem(TRACKED_RUNS_KEY, JSON.stringify(next));
        } catch {
          // Progress still works in this tab; only reload recovery is lost.
        }
        return next;
      });
      setRunProgress((previous) => {
        const next = { ...previous };
        delete next[runId];
        return next;
      });
    } catch (error) {
      setActionMessage({
        text: error instanceof Error ? error.message : "Retry failed",
        error: true,
      });
    } finally {
      setRetryingRunId(null);
    }
  }

  async function postReembed(id?: string) {
    const res = await fetch("/api/reembed", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(id ? { id } : {}),
    });
    const data = await res.json();
    if (!res.ok || !data.success) {
      throw new Error(data.error ?? `Re-embed request failed: ${res.status}`);
    }
    return data as { queued: number; skipped: number };
  }

  async function handleReembedAll() {
    if (
      !window.confirm(
        "Re-embed every document in the knowledge base? This re-runs parsing, embedding, and graph extraction for each one and may take a while."
      )
    ) {
      return;
    }
    setReembeddingAll(true);
    setActionMessage(null);
    try {
      const { queued, skipped } = await postReembed();
      setActionMessage({
        text: `Queued ${queued} document(s) for re-embedding${skipped ? ` (${skipped} skipped, missing blob)` : ""}.`,
        error: false,
      });
    } catch (error) {
      setActionMessage({
        text: error instanceof Error ? error.message : "Re-embed failed",
        error: true,
      });
    } finally {
      setReembeddingAll(false);
    }
  }

  async function handleReembedRow(id: string, name: string) {
    setReembeddingId(id);
    setActionMessage(null);
    try {
      await postReembed(id);
      setActionMessage({ text: `Queued "${name}" for re-embedding.`, error: false });
    } catch (error) {
      setActionMessage({
        text: error instanceof Error ? error.message : "Re-embed failed",
        error: true,
      });
    } finally {
      setReembeddingId(null);
    }
  }

  async function handleDeleteRow(id: string, name: string) {
    if (
      !window.confirm(
        `Delete "${name}"? This removes the blob, the database record, and all its vectors/graph data. This cannot be undone.`
      )
    ) {
      return;
    }
    setDeletingId(id);
    setActionMessage(null);
    try {
      const res = await fetch("/api/deleteDocument", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.error ?? `Delete failed: ${res.status}`);
      }
      setActionMessage({ text: `Deleted "${name}".`, error: false });
      refreshKnowledgeBase();
    } catch (error) {
      setActionMessage({
        text: error instanceof Error ? error.message : "Delete failed",
        error: true,
      });
    } finally {
      setDeletingId(null);
    }
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const selected = (e.currentTarget.elements.namedItem("file") as HTMLInputElement).files;
    if (!selected || selected.length === 0) return;

    setStatus("loading");
    setMessage("");
    setNotices([]);

    // Drop a name repeated within this selection before paying to upload it
    // twice. The server checks against the knowledge base independently.
    const seen = new Set<string>();
    const selectedOnce = Array.from(selected).filter((file) => {
      const key = normalizeName(file.name);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    // Names already in the table, as last loaded. Advisory only — the token
    // route and /api/upload both re-check authoritatively — but catching a
    // duplicate here is the only way the user learns *which* rule refused the
    // file. @vercel/blob discards the response body of a failed token
    // request, so a 409 naming the duplicate reaches the browser as the same
    // opaque "Failed to retrieve the client token" as any other refusal.
    const known = new Set(
      (knowledgeBase?.items ?? []).map((item) => normalizeName(item.name))
    );

    const notices: string[] = [];
    const files: File[] = [];
    for (const file of selectedOnce) {
      if (known.has(normalizeName(file.name))) {
        notices.push(`"${file.name}" is already in the knowledge base`);
        continue;
      }
      files.push(file);
    }

    if (files.length === 0) {
      setStatus("error");
      setNotices(notices);
      setMessage("Nothing was uploaded");
      return;
    }

    setUploadProgress(files.map((file) => ({ fileName: file.name, percentage: 0 })));

    // Straight to Blob storage, never through a route handler — a Vercel
    // function caps its request body at 4.5 MB. Sequential rather than
    // parallel so one large PDF isn't competing with the next for bandwidth.
    const uploaded: UploadedFile[] = [];

    for (const file of files) {
      try {
        const blob = await upload(uploadPathname(file.name), file, {
          access: "public",
          handleUploadUrl: "/api/upload/token",
          multipart: true,
          clientPayload: JSON.stringify({ fileName: file.name }),
          onUploadProgress: ({ percentage }) =>
            setUploadProgress((previous) =>
              previous.map((entry) =>
                entry.fileName === file.name ? { ...entry, percentage } : entry
              )
            ),
        });

        uploaded.push({
          fileName: file.name,
          sizeBytes: file.size,
          url: blob.url,
          downloadUrl: blob.downloadUrl,
          pathname: blob.pathname,
        });
      } catch (error) {
        // A refused token (duplicate name, wrong type, too large) lands here
        // before any bytes were sent — but the SDK throws away the token
        // route's JSON body, so the reason the server sent is already gone.
        // Name the file and the possible causes rather than repeating the
        // SDK's message, which identifies neither.
        const detail = error instanceof Error ? error.message : "";
        notices.push(
          detail.includes("client token")
            ? `"${file.name}" was refused: it may already be in the knowledge base, not be a PDF, or exceed ${formatBytes(MAX_UPLOAD_BYTES)}`
            : `"${file.name}": ${detail || "upload failed"}`
        );
      }
    }

    setUploadProgress([]);

    if (uploaded.length === 0) {
      setStatus("error");
      setNotices(notices);
      setMessage("Nothing was uploaded");
      return;
    }

    let res: Response;
    let data: Record<string, unknown> = {};
    try {
      res = await fetch("/api/upload", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: uploaded }),
      });
      // Not every failure comes back as JSON, so parse defensively rather
      // than letting res.json() throw before res.ok is checked.
      const body = await res.text();
      try {
        data = body ? JSON.parse(body) : {};
      } catch {
        data = {};
      }
    } catch (error) {
      setStatus("error");
      setNotices(notices);
      setMessage(error instanceof Error ? error.message : "Could not start ingestion");
      return;
    }

    if (!res.ok) {
      setStatus("error");
      setNotices(notices);
      setMessage((data.error as string) ?? `Could not start ingestion (${res.status})`);
      return;
    }

    const skipped = (data.skipped ?? []) as string[];
    if (skipped.length > 0) {
      notices.push(`Already in the knowledge base, skipped: ${skipped.join(", ")}`);
    }

    setStatus("success");
    setNotices(notices);
    setMessage(
      (data.fileCount as number) > 0
        ? `Queued ${data.fileCount} file(s) for processing`
        : "Nothing to ingest — every file is already in the knowledge base"
    );

    // Deliberately no refreshKnowledgeBase() here: recordUpload is the last
    // step, so the rows cannot exist yet. The poll refreshes once the runs
    // actually finish.
    const started = (data.runs ?? []) as TrackedRun[];
    setTrackedRuns((previous) => {
      const known = new Set(previous.map((run) => run.runId));
      const next = [...previous, ...started.filter((run) => !known.has(run.runId))];
      try {
        sessionStorage.setItem(TRACKED_RUNS_KEY, JSON.stringify(next));
      } catch {
        // Progress still works in this tab; only reload recovery is lost.
      }
      return next;
    });
  }

  return (
    <main className="dark relative min-h-screen overflow-hidden bg-black p-6 text-foreground">
      {/* Infinite-depth backdrop */}
      <div className="pointer-events-none absolute inset-0" aria-hidden="true">
        <div
          className="absolute inset-0"
          style={{
            backgroundImage:
              "radial-gradient(circle, rgba(255,255,255,0.14) 1px, transparent 1px)",
            backgroundSize: "28px 28px",
            maskImage:
              "radial-gradient(ellipse 70% 60% at 50% 45%, black 30%, transparent 75%)",
            WebkitMaskImage:
              "radial-gradient(ellipse 70% 60% at 50% 45%, black 30%, transparent 75%)",
          }}
        />
        <div
          className="absolute inset-0"
          style={{
            background:
              "radial-gradient(ellipse 80% 70% at 50% 40%, rgba(255,255,255,0.06), transparent 70%)",
          }}
        />
      </div>

      <div className="relative z-10 mx-auto flex w-full max-w-7xl justify-end">
        <Button variant="outline" size="sm" onClick={() => signOut({ callbackUrl: "/login" })}>
          <LogOut />
          Sign out
        </Button>
      </div>

      {/* Top-aligned two-column layout: upload 1/3, table 2/3 and grows */}
      <div className="relative z-10 mx-auto mt-4 flex w-full max-w-7xl flex-col gap-6 lg:flex-row lg:items-start">
        <div className="flex w-full flex-col gap-6 lg:w-1/3 lg:shrink-0">
          <Card>
            <CardHeader>
              <CardTitle>Upload Documents</CardTitle>
              <CardDescription>Add PDFs to the RAG database</CardDescription>
            </CardHeader>
            <CardContent>
              <form onSubmit={handleSubmit} className="space-y-4">
                <div className="space-y-2">
                  <Label htmlFor="file">Files</Label>
                  <Input id="file" name="file" type="file" accept=".pdf" multiple required />
                </div>
                <Button type="submit" className="w-full" disabled={status === "loading"}>
                  {status === "loading" ? "Uploading..." : "Upload"}
                </Button>
                {message && (
                  <p className={`text-sm ${status === "success" ? "text-green-400" : "text-red-400"}`}>
                    {message}
                  </p>
                )}
                {notices.map((notice) => (
                  <p key={notice} className="text-sm text-amber-400">
                    {notice}
                  </p>
                ))}

                {/* Transfer to Blob storage, before any workflow exists to
                    report on. Ingestion progress picks up from here. */}
                {uploadProgress.map((entry) => (
                  <div key={entry.fileName} className="space-y-1">
                    <div className="flex items-baseline justify-between gap-2 text-xs text-muted-foreground">
                      <span className="min-w-0 truncate" title={entry.fileName}>
                        {entry.fileName}
                      </span>
                      <span className="shrink-0 tabular-nums">{Math.round(entry.percentage)}%</span>
                    </div>
                    <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/15">
                      <div
                        className="h-full rounded-full bg-white transition-[width] duration-200"
                        style={{ width: `${entry.percentage}%` }}
                      />
                    </div>
                  </div>
                ))}
              </form>
            </CardContent>
          </Card>

          {trackedRuns.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Ingestion Progress</CardTitle>
                <CardDescription>
                  Live status of each file moving through the pipeline
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-5">
                {trackedRuns.map((run) => (
                  <IngestProgress
                    key={run.runId}
                    fileName={run.fileName}
                    progress={runProgress[run.runId]}
                    retrying={retryingRunId === run.runId}
                    onRetry={() => handleRetry(run.runId)}
                  />
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        <Card className="w-full min-w-0 lg:flex-1">
          <CardHeader>
            <CardTitle>Knowledge Base</CardTitle>
            <CardDescription>View the current knowledge base records</CardDescription>
            <CardAction className="flex gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={handleReembedAll}
                disabled={reembeddingAll || !knowledgeBase?.items.length}
              >
                <Sparkles className={reembeddingAll ? "animate-spin" : ""} />
                {reembeddingAll ? "Queuing..." : "Re-embed all"}
              </Button>
              <Button
                variant="outline"
                size="sm"
                onClick={refreshKnowledgeBase}
                disabled={refreshing}
              >
                <RefreshCw className={refreshing ? "animate-spin" : ""} />
                {refreshing ? "Refreshing..." : "Refresh"}
              </Button>
            </CardAction>
          </CardHeader>
          <CardContent>
            {actionMessage && (
              <p className={`mb-3 text-sm ${actionMessage.error ? "text-red-400" : "text-green-400"}`}>
                {actionMessage.text}
              </p>
            )}
            {knowledgeBase && knowledgeBase.items.length > 0 ? (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead className="text-right">Chunks</TableHead>
                    <TableHead className="text-right">Size</TableHead>
                    <TableHead>Uploaded</TableHead>
                    <TableHead className="text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {knowledgeBase.items.map((item) => (
                    <TableRow key={item.id}>
                      <TableCell className="font-medium">
                        {item.blobUrl ? (
                          <a
                            href={item.blobUrl}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="hover:underline"
                          >
                            {item.name}
                          </a>
                        ) : (
                          item.name
                        )}
                      </TableCell>
                      <TableCell className="text-right">{item.chunks}</TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        {formatBytes(item.sizeBytes)}
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        {formatDate(item.uploadedAt)}
                      </TableCell>
                      <TableCell className="text-right">
                        <div className="flex justify-end gap-2">
                          {/* Plain anchors, not <Button render={<a/>}>. These
                              are links, and Base UI's non-native mode stamps
                              role="button" on them and routes the click
                              through its own handlers — semantics a link
                              should not have, and a layer between the user
                              and a navigation that has already broken once. */}
                          {item.blobUrl && (
                            <a
                              href={item.blobUrl}
                              target="_blank"
                              rel="noopener noreferrer"
                              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                            >
                              View
                            </a>
                          )}
                          {item.blobDownloadUrl && (
                            <a
                              href={item.blobDownloadUrl}
                              className={cn(buttonVariants({ variant: "outline", size: "sm" }))}
                            >
                              Download
                            </a>
                          )}
                          <Button
                            variant="outline"
                            size="sm"
                            onClick={() => handleReembedRow(item.id, item.name)}
                            disabled={reembeddingId === item.id || reembeddingAll || deletingId === item.id}
                          >
                            <Sparkles className={reembeddingId === item.id ? "animate-spin" : ""} />
                            {reembeddingId === item.id ? "Queuing..." : "Re-embed"}
                          </Button>
                          <Button
                            variant="destructive"
                            size="sm"
                            onClick={() => handleDeleteRow(item.id, item.name)}
                            disabled={deletingId === item.id || reembeddingId === item.id}
                          >
                            <Trash2 className={deletingId === item.id ? "animate-spin" : ""} />
                            {deletingId === item.id ? "Deleting..." : "Delete"}
                          </Button>
                        </div>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            ) : (
              <p className="py-8 text-center text-sm text-muted-foreground">
                No documents yet — upload a PDF to get started.
              </p>
            )}
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

// One file's journey through the ingestion workflow. `progress` is undefined
// until the first poll lands, which is the "Queued" state.
function IngestProgress({
  fileName,
  progress,
  retrying,
  onRetry,
}: {
  fileName: string;
  progress: IngestRunProgress | undefined;
  retrying: boolean;
  onRetry: () => void;
}) {
  const failed = progress?.status === "failed" || progress?.status === "cancelled";
  const done = progress?.status === "completed";
  // The runtime no longer knows this run — it expired, or the deployment moved on.
  const unknown = progress?.status === "unknown";
  const retryingStep = progress?.steps.find(
    (step) => (step.status === "running" || step.status === "failed") && step.attempt > 1
  );

  let detail: string;
  if (!progress) {
    detail = "Queued";
  } else if (done) {
    detail = "Complete";
  } else if (failed) {
    detail = progress.failedStepLabel
      ? `Failed during ${progress.failedStepLabel.toLowerCase()}`
      : "Failed";
  } else if (unknown) {
    detail = "Status no longer available";
  } else if (progress.currentStepLabel) {
    detail = `Step ${progress.completedCount + 1} of ${progress.totalCount} · ${progress.currentStepLabel}`;
  } else {
    detail = "Starting";
  }

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium" title={fileName}>
          {fileName}
        </span>
        {done ? (
          <CheckCircle2 className="size-4 shrink-0 text-green-400" />
        ) : failed || unknown ? (
          <AlertCircle className="size-4 shrink-0 text-red-400" />
        ) : (
          <Loader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
        )}
      </div>

      <div className="flex gap-1" aria-hidden="true">
        {(progress?.steps ??
          INGEST_STEPS.map((step) => ({ ...step, status: "pending" as const, attempt: 1 }))
        ).map((step) => (
          <div
            key={step.name}
            className={`h-1.5 flex-1 rounded-full ${
              step.status === "completed"
                ? "bg-green-400"
                : step.status === "running"
                  ? "animate-pulse bg-white"
                  : step.status === "failed" || step.status === "cancelled"
                    ? "bg-red-400"
                    : "bg-white/15"
            }`}
            title={`${step.label}: ${step.status}`}
          />
        ))}
      </div>

      <p
        className={`text-xs ${
          failed || unknown ? "text-red-400" : done ? "text-green-400" : "text-muted-foreground"
        }`}
      >
        {detail}
        {retryingStep && ` · retry ${retryingStep.attempt}`}
      </p>

      {/* The runtime's own message for the failing step — the actual reason,
          rather than just which step it was. */}
      {progress?.error && (
        <p className="rounded border border-red-400/30 bg-red-400/10 px-2 py-1 font-mono text-[11px] leading-snug break-words text-red-300">
          {progress.error.code ? `${progress.error.code}: ` : ""}
          {progress.error.message}
        </p>
      )}

      {progress?.resumable && (
        <div className="space-y-1">
          <Button variant="outline" size="sm" onClick={onRetry} disabled={retrying}>
            <RotateCw className={retrying ? "animate-spin" : ""} />
            {retrying ? "Retrying..." : "Retry from saved Markdown"}
          </Button>
          <p className="text-[11px] text-muted-foreground">
            Skips the upload and the PDF→Markdown conversion.
          </p>
        </div>
      )}

      {/* Failed with no resume point: the run died before the Markdown was
          saved, so there is nothing cheaper to restart from. */}
      {failed && !progress?.resumable && (
        <p className="text-[11px] text-muted-foreground">
          Failed before the Markdown was saved — upload the file again to retry.
        </p>
      )}
    </div>
  );
}
