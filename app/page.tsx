"use client";

import { useState, useEffect, useCallback } from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
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

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const files = (e.currentTarget.elements.namedItem("file") as HTMLInputElement).files;
    if (!files || files.length === 0) return;

    setStatus("loading");
    setMessage("");

    const formData = new FormData();
    for (const file of Array.from(files)) {
      formData.append("files", file);
    }

    const res = await fetch("/api/upload", { method: "POST", body: formData });
    const data = await res.json();

    if (res.ok) {
      setStatus("success");
      setMessage(`Queued ${data.fileCount} file(s) for processing`);
      refreshKnowledgeBase();
    } else {
      setStatus("error");
      setMessage(data.error ?? "Upload failed");
    }
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

      {/* Top-aligned two-column layout: upload 1/3, table 2/3 and grows */}
      <div className="relative z-10 mx-auto flex w-full max-w-7xl flex-col gap-6 lg:flex-row lg:items-start">
        <Card className="w-full lg:w-1/3 lg:shrink-0">
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
            </form>
          </CardContent>
        </Card>

        <Card className="w-full min-w-0 lg:flex-1">
          <CardHeader>
            <CardTitle>Knowledge Base</CardTitle>
            <CardDescription>View the current knowledge base records</CardDescription>
            <CardAction>
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
                          {item.blobUrl && (
                            <Button
                              variant="outline"
                              size="sm"
                              render={<a href={item.blobUrl} target="_blank" rel="noopener noreferrer" />}
                            >
                              View
                            </Button>
                          )}
                          {item.blobDownloadUrl && (
                            <Button variant="outline" size="sm" render={<a href={item.blobDownloadUrl} />}>
                              Download
                            </Button>
                          )}
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