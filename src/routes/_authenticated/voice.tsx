import { createFileRoute } from "@tanstack/react-router";
import { Mic, MicOff, Volume2, User, Bot, Trash2 } from "lucide-react";
import { AppShell } from "@/components/lord/AppShell";
import { HudPanel } from "@/components/lord/HudPanel";
import { HudRings } from "@/components/lord/HudRings";
import { useWakeWord } from "@/components/lord/WakeWordProvider";
import { cn } from "@/lib/utils";

export const Route = createFileRoute("/_authenticated/voice")({
  head: () => ({ meta: [{ title: "LORD — Voice" }] }),
  component: VoicePage,
});

function VoicePage() {
  const { enabled, status, transcript, reply, supported, toggle, messages, clearMessages } =
    useWakeWord();

  const ringState =
    status === "thinking"
      ? "processing"
      : status === "speaking"
        ? "speaking"
        : status === "listening" || status === "heard"
          ? "listening"
          : "idle";

  const statusLabel =
    status === "listening" && !messages.length
      ? "\u25b0 Listening for wake word"
      : status === "listening" && messages.length > 0
        ? "\u25b0 Listening for command"
        : status === "heard"
          ? "\u25b0 Yes, Sir?"
          : status === "thinking"
            ? "\u25b0 Processing"
            : status === "speaking"
              ? "\u25b0 Speaking"
              : status === "off"
                ? "\u25d7 Standby"
                : "\u2715 Unsupported";

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-3xl">
        <div className="mb-6 text-center">
          <h1 className="font-display text-2xl tracking-wide gradient-text text-glow sm:text-3xl md:text-4xl">
            Voice Interface
          </h1>
          <p className="mt-2 text-sm text-muted-foreground">
            Say &ldquo;<span className="text-primary">Hey Lord</span>&rdquo; followed by your
            directive.
          </p>
        </div>

        <div className="flex flex-col items-center gap-5 hud-panel px-3 py-8 sm:gap-6 sm:py-10">
          <div className="w-full max-w-[240px] sm:max-w-[260px]">
            <HudRings size={260} state={ringState} />
          </div>

          <div className="font-mono text-xs uppercase tracking-[0.3em] text-primary text-glow">
            {statusLabel}
          </div>

          <div className="flex items-center gap-3">
            <button
              onClick={toggle}
              disabled={!supported}
              className={cn(
                "inline-flex min-h-12 items-center gap-2 rounded-md border px-6 py-3 text-sm font-semibold transition",
                enabled
                  ? "border-[var(--hud-success)] bg-[var(--hud-success)]/15 text-[var(--hud-success)] shadow-[0_0_24px_var(--hud-success)]"
                  : "border-primary/40 bg-primary/5 text-primary hover:bg-primary/10",
                !supported && "opacity-50",
              )}
            >
              {enabled ? <Mic className="h-4 w-4" /> : <MicOff className="h-4 w-4" />}
              Wake Word {enabled ? "ACTIVE" : "OFF"}
            </button>

            {messages.length > 0 && (
              <button
                onClick={clearMessages}
                className={cn(
                  "inline-flex items-center gap-1.5 rounded-md border border-destructive/30 px-3 py-2 text-xs text-destructive transition hover:bg-destructive/10",
                )}
              >
                <Trash2 className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>

          {!supported && (
            <p className="text-xs text-destructive">
              Speech recognition unsupported in this browser. Try Chrome or Safari.
            </p>
          )}
          <p className="max-w-md text-center text-[11px] text-muted-foreground">
            Web limitation: LORD listens only while this app is open and in the foreground. For
            lock-screen wake like Siri, a native build is required.
          </p>
        </div>

        {messages.length > 0 && (
          <div className="mt-4 space-y-3">
            <HudPanel title="Conversation" subtitle="Voice session">
              <div className="space-y-3">
                {messages.map((msg) => (
                  <div
                    key={msg.id}
                    className={cn(
                      "flex gap-3 rounded-lg border p-3 text-sm",
                      msg.role === "user"
                        ? "border-cyan-500/20 bg-cyan-500/5"
                        : "border-primary/20 bg-primary/5",
                    )}
                  >
                    <div
                      className={cn(
                        "mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-full",
                        msg.role === "user"
                          ? "bg-cyan-500/20 text-cyan-200"
                          : "bg-primary/20 text-primary",
                      )}
                    >
                      {msg.role === "user" ? (
                        <User className="h-3.5 w-3.5" />
                      ) : (
                        <Bot className="h-3.5 w-3.5" />
                      )}
                    </div>
                    <div className="flex-1 whitespace-pre-wrap leading-relaxed">{msg.text}</div>
                  </div>
                ))}
              </div>
            </HudPanel>
          </div>
        )}

        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <HudPanel title="Live Transcript" subtitle="What LORD hears">
            <div className="min-h-[120px] text-sm whitespace-pre-wrap">
              {transcript || <span className="text-muted-foreground">Waiting for input\u2026</span>}
            </div>
          </HudPanel>
          <HudPanel
            title="Response"
            subtitle="LORD reply"
            action={reply && !messages.length && <Volume2 className="h-4 w-4 text-primary" />}
          >
            <div className="min-h-[120px] text-sm whitespace-pre-wrap">
              {reply || <span className="text-muted-foreground">Waiting for response\u2026</span>}
            </div>
          </HudPanel>
        </div>
      </div>
    </AppShell>
  );
}
