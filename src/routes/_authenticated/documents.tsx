import { createFileRoute } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import type { FC } from "react";
import {
  Upload,
  Loader2,
  FileText,
  Copy,
  Download,
  Sparkles,
  Wand2,
  ScanText,
  BookOpen,
  BrainCircuit,
  Table2,
  ImageIcon,
  FileType2,
} from "lucide-react";
import { AppShell } from "@/components/lord/AppShell";
import { HudPanel } from "@/components/lord/HudPanel";
import { getApiBaseUrl } from "@/lib/api-config";
import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { streamTextLines } from "@/lib/stream-text-lines";
import {
  startResearchSession,
  addDocumentToSession,
  completeResearchSession,
} from "@/lib/research-store";

export const Route = createFileRoute("/_authenticated/documents")({
  head: () => ({ meta: [{ title: "LORD — Document Intelligence" }] }),
  component: DocsPage,
});

type TaskId =
  | "summary"
  | "explain"
  | "rewrite"
  | "translate"
  | "notes"
  | "qa"
  | "key-points"
  | "extract-tables"
  | "extract-images"
  | "markdown"
  | "ocr"
  | "flashcards"
  | "quiz"
  | "study-notes";

const TASKS: Array<{ id: TaskId; label: string; icon: FC<{ className?: string }> }> = [
  { id: "summary", label: "Summary", icon: Sparkles },
  { id: "explain", label: "Explain", icon: BookOpen },
  { id: "rewrite", label: "Rewrite", icon: Wand2 },
  { id: "translate", label: "Translate", icon: ScanText },
  { id: "notes", label: "Notes", icon: FileText },
  { id: "qa", label: "Q&A", icon: BrainCircuit },
  { id: "key-points", label: "Key Points", icon: Sparkles },
  { id: "extract-tables", label: "Extract Tables", icon: Table2 },
  { id: "extract-images", label: "Extract Images", icon: ImageIcon },
  { id: "markdown", label: "Convert to Markdown", icon: FileType2 },
  { id: "ocr", label: "OCR", icon: ScanText },
  { id: "flashcards", label: "Generate Flashcards", icon: Sparkles },
  { id: "quiz", label: "Generate Quiz", icon: BrainCircuit },
  { id: "study-notes", label: "Generate Study Notes", icon: BookOpen },
];

function DocsPage() {
  const [text, setText] = useState("");
  const [filename, setFilename] = useState("");
  const [task, setTask] = useState<TaskId>("summary");
  const [question, setQuestion] = useState("");
  const [output, setOutput] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);

  const detectedType = useMemo(() => {
    if (!filename) return "Text";
    const lower = filename.toLowerCase();
    if (lower.endsWith(".pdf")) return "PDF";
    if (lower.endsWith(".docx") || lower.endsWith(".doc")) return "DOC";
    if (lower.endsWith(".txt")) return "TXT";
    if (lower.endsWith(".md")) return "Markdown";
    if (lower.endsWith(".html") || lower.endsWith(".htm")) return "HTML";
    if (lower.endsWith(".csv")) return "CSV";
    if (lower.endsWith(".json")) return "JSON";
    if (lower.endsWith(".xml")) return "XML";
    return "File";
  }, [filename]);

  const onFile = async (f: File | null) => {
    if (!f) return;
    setFilename(f.name);
    const lower = f.name.toLowerCase();
    if (f.type.startsWith("text/") || /\.(txt|md|json|csv|xml|html|htm)$/i.test(lower)) {
      setText(await f.text());
    } else if (lower.endsWith(".pdf") || lower.endsWith(".doc") || lower.endsWith(".docx")) {
      setText(
        `[File "${f.name}" attached — document content will be analyzed after upload. Paste extracted text here if needed.]`,
      );
    } else {
      setText(`[File "${f.name}" attached — paste extracted text for analysis.]`);
    }
  };

  const run = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setOutput("");

    const taskPrompt = (() => {
      switch (task) {
        case "summary":
          return `Summarize the following document with: 1) 3-line TL;DR, 2) key points, 3) entities, 4) action items.\n\n---\n${text}`;
        case "explain":
          return `Explain the following document in clear, accessible language.\n\n---\n${text}`;
        case "rewrite":
          return `Rewrite the following content for clarity, readability, and tone. Preserve meaning.\n\n---\n${text}`;
        case "translate":
          return `Translate the following content into clear English. Preserve meaning and formatting.\n\n---\n${text}`;
        case "notes":
          return `Extract detailed structured notes (headings, bullets, definitions, examples) from:\n\n---\n${text}`;
        case "qa":
          return `Answer this question using ONLY the document below. If unknown, say so.\n\nQuestion: ${question}\n\n---\n${text}`;
        case "key-points":
          return `Extract the most important key points from the document.\n\n---\n${text}`;
        case "extract-tables":
          return `Extract any tables from the document and present them clearly in markdown table format.\n\n---\n${text}`;
        case "extract-images":
          return `Describe any images or visual elements present in the document.\n\n---\n${text}`;
        case "markdown":
          return `Convert the document content into polished Markdown.\n\n---\n${text}`;
        case "ocr":
          return `Perform OCR-style transcription and return the extracted text faithfully.\n\n---\n${text}`;
        case "flashcards":
          return `Generate concise flashcards from the document in Q/A format.\n\n---\n${text}`;
        case "quiz":
          return `Generate a short quiz from the document with answers.\n\n---\n${text}`;
        case "study-notes":
          return `Create study notes from the document with sections, bullets, and recall cues.\n\n---\n${text}`;
        default:
          return text;
      }
    })();

    try {
      const res = await authenticatedFetch(`${getApiBaseUrl()}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          mode: "reasoning",
          messages: [{ id: "u", role: "user", parts: [{ type: "text", text: taskPrompt }] }],
        }),
      });
      await streamTextLines(res, (acc) => setOutput(acc));
    } catch {
      setOutput("Connection error.");
    } finally {
      setBusy(false);
    }
  };

  const copyOutput = async () => {
    if (!output) return;
    await navigator.clipboard.writeText(output);
  };

  const saveResearch = () => {
    if (!output) return;
    const session = startResearchSession(filename || "Document analysis");
    addDocumentToSession(session.id);
    completeResearchSession(session.id);
  };

  const downloadOutput = () => {
    if (!output) return;
    const blob = new Blob([output], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${filename || "document"}-analysis.txt`;
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <AppShell>
      <h1 className="mb-1 font-display text-2xl tracking-wide gradient-text text-glow sm:text-3xl">
        Document Intelligence
      </h1>
      <p className="mb-6 text-sm text-muted-foreground">
        Upload, drag, paste, and transform documents with LORD AI.
      </p>

      <div className="grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
        <HudPanel title="Source Workspace">
          <label
            className={`flex min-h-32 cursor-pointer flex-col items-center justify-center gap-2 rounded-md border border-dashed px-4 py-6 text-center text-sm transition ${dragActive ? "border-primary bg-primary/10" : "border-primary/40 bg-primary/5 hover:bg-primary/10"}`}
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              void onFile(e.dataTransfer.files?.[0] ?? null);
            }}
          >
            <Upload className="h-5 w-5 text-primary" />
            <span>Upload or drop a document</span>
            <span className="text-xs text-muted-foreground">
              PDF • DOCX • DOC • TXT • Markdown • HTML • CSV • JSON • XML
            </span>
            <input
              type="file"
              className="hidden"
              accept=".pdf,.doc,.docx,.txt,.md,.markdown,.html,.htm,.csv,.json,.xml,text/*"
              onChange={(e) => void onFile(e.target.files?.[0] ?? null)}
            />
          </label>
          {filename && (
            <p className="mt-2 flex items-center gap-1 text-xs text-primary">
              <FileText className="h-3.5 w-3.5" /> {filename} • {detectedType}
            </p>
          )}
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={14}
            placeholder="Paste text or drop a document here"
            className="mt-3 w-full rounded-md border border-border/60 bg-background/40 px-3 py-2 font-mono text-base outline-none focus:border-primary sm:text-sm"
          />
        </HudPanel>

        <HudPanel title="AI Actions">
          <div className="flex flex-wrap gap-2">
            {TASKS.map((item) => {
              const Icon = item.icon;
              const active = task === item.id;
              return (
                <button
                  key={item.id}
                  onClick={() => setTask(item.id)}
                  className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs uppercase tracking-wider transition ${active ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground hover:text-primary"}`}
                >
                  <Icon className="h-3.5 w-3.5" />
                  {item.label}
                </button>
              );
            })}
          </div>
          {task === "qa" && (
            <input
              value={question}
              onChange={(e) => setQuestion(e.target.value)}
              placeholder="Ask a question about the document…"
              className="mt-3 min-h-11 w-full rounded-md border border-border/60 bg-background/40 px-3 py-2 text-base outline-none focus:border-primary sm:text-sm"
            />
          )}
          <button
            onClick={() => void run()}
            disabled={busy || !text.trim()}
            className="mt-3 inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-primary px-5 py-2 text-sm font-semibold text-primary-foreground shadow-[0_0_18px_var(--hud)] disabled:opacity-40"
          >
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : "Process Document"}
          </button>
          <div className="mt-4 flex items-center gap-2">
            <button
              onClick={copyOutput}
              disabled={!output}
              className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2 text-sm text-muted-foreground disabled:opacity-40"
            >
              <Copy className="h-4 w-4" /> Copy
            </button>
            <button
              onClick={downloadOutput}
              disabled={!output}
              className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2 text-sm text-muted-foreground disabled:opacity-40"
            >
              <Download className="h-4 w-4" /> Download
            </button>
            <button
              onClick={saveResearch}
              disabled={!output}
              className="inline-flex items-center gap-2 rounded-md border border-border/60 bg-background/40 px-3 py-2 text-sm text-primary disabled:opacity-40"
            >
              <BookOpen className="h-4 w-4" /> Save to Research
            </button>
          </div>
          <div className="mt-4 min-h-[320px] whitespace-pre-wrap rounded-md border border-border/40 bg-background/30 p-3 text-sm">
            {busy ? (
              <div className="flex h-full items-center justify-center gap-2 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Processing document…
              </div>
            ) : output ? (
              output
            ) : (
              <span className="text-muted-foreground">Output appears here.</span>
            )}
          </div>
        </HudPanel>
      </div>
    </AppShell>
  );
}
