"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";


export default function UploadPage() {
  const [status, setStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [message, setMessage] = useState("");
    const [knowledgeBase, setKnowledgeBase] = useState<any>(null);

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
      setMessage(`Indexed ${data.chunks} chunks from ${data.fileCount} file(s)`);
    } else {
      setStatus("error");
      setMessage(data.error ?? "Upload failed");
    }
  }

  async function fetchKnowledgeBase() {
    try {
      const res = await fetch("/api/returnKnowledgeBase");
      if (!res.ok) {
        throw new Error(`Failed to fetch knowledge base: ${res.status}`);
      }
      const data = await res.json();
      console.log("Knowledge Base:", data);
      return data;
    } catch (error) {
      console.error("Error fetching knowledge base:", error);
      return null;
    }
  }

    useEffect(() => {
      async function fetchData() {
        const knowledgeBase = await fetchKnowledgeBase();
        setKnowledgeBase(knowledgeBase);
      }
      fetchData();
    }, []);


  return (
    <main className="min-h-screen flex items-center justify-center p-6">
      <Card className="w-full max-w-md">
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
              <p className={`text-sm ${status === "success" ? "text-green-600" : "text-red-600"}`}>
                {message}
              </p>
            )}
          </form>
        </CardContent>
      </Card>
      {knowledgeBase && knowledgeBase.items.length > 0 && (
      <Card className="w-full max-w-md mt-6">
        <CardHeader>
          <CardTitle>Knowledge Base</CardTitle>
          <CardDescription>View the current knowledge base records</CardDescription>
        </CardHeader>
        <CardContent>
          {knowledgeBase.items.map((item: any) => {
            const viewUrl = item.blobUrl;
            const downloadUrl = item.blobDownloadUrl;

            return (
              <>
                {viewUrl && (
                  <a
                    key={`${item.id}-view`}
                    href={viewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-blue-600 underline"
                  >
                    {item.name}
                  </a>
                )}
                {downloadUrl && (
                  <a
                    key={`${item.id}-download`}
                    href={downloadUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-blue-600 underline"
                  >
                    {item.name}
                  </a>
                )}
              </>
            );
          })}
        </CardContent>
      </Card>
      )}
    </main>
  );
}