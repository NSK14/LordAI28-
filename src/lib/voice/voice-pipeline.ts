import { authenticatedFetch } from "@/lib/authenticated-fetch";
import { getApiBaseUrl } from "@/lib/api-config";
import { streamTextLines } from "@/lib/stream-text-lines";
import type { LordMode } from "@/lib/modes";

export type VoicePipelineStatus = "idle" | "listening" | "processing" | "speaking" | "error";

export interface VoiceMessage {
  id: string;
  role: "user" | "assistant";
  text: string;
}

interface SpeechRecognitionLike {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  start: () => void;
  stop: () => void;
  abort: () => void;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }>;
      }) => void)
    | null;
  onend: (() => void) | null;
  onerror: ((event: { error?: string }) => void) | null;
}

function getRecognitionCtor(): (new () => SpeechRecognitionLike) | null {
  if (typeof window === "undefined") return null;
  const w = window as unknown as {
    SpeechRecognition?: new () => SpeechRecognitionLike;
    webkitSpeechRecognition?: new () => SpeechRecognitionLike;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export class VoicePipeline {
  private recognition: SpeechRecognitionLike | null = null;
  private abortController: AbortController | null = null;
  private speaking = false;
  private processing = false;

  onStatusChange: (status: VoicePipelineStatus) => void = () => {};
  onTranscript: (text: string) => void = () => {};
  onResponse: (text: string) => void = () => {};
  onError: (error: string) => void = () => {};
  onMessagesChange: (messages: VoiceMessage[]) => void = () => {};

  private messages: VoiceMessage[] = [];
  private mode: LordMode = "balanced";
  private autoSpeak = true;
  private voiceRate = 1;
  private currentTranscript = "";

  async initialize(mode: LordMode, autoSpeak: boolean, voiceRate: number) {
    this.mode = mode;
    this.autoSpeak = autoSpeak;
    this.voiceRate = voiceRate;
  }

  startListening() {
    if (this.processing) return;
    this.stopListening();
    this.currentTranscript = "";

    const Ctor = getRecognitionCtor();
    if (!Ctor) {
      this.onError("Speech recognition not supported in this browser.");
      this.onStatusChange("error");
      return;
    }

    const rec = new Ctor();
    rec.lang = "en-US";
    rec.continuous = false;
    rec.interimResults = true;

    rec.onresult = (event) => {
      let interimTranscript = "";
      let finalTranscript = "";
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const transcript = result[0].transcript;
        if (result.isFinal) {
          finalTranscript += transcript;
        } else {
          interimTranscript += transcript;
        }
      }

      const displayText = finalTranscript || interimTranscript;
      if (displayText) {
        this.currentTranscript = displayText;
        this.onTranscript(displayText);
      }

      if (finalTranscript) {
        this.stopListening();
        this.processSpeech(finalTranscript.trim());
      }
    };

    rec.onend = () => {
      if (this.currentTranscript && !this.processing) {
        this.processSpeech(this.currentTranscript.trim());
      }
    };

    rec.onerror = (event) => {
      const error = event.error;
      if (error === "no-speech") {
        this.onTranscript("No speech detected. Please try again.");
      } else if (error !== "aborted") {
        this.onError(`Speech recognition error: ${error}`);
        this.onStatusChange("error");
      }
    };

    this.recognition = rec;
    try {
      rec.start();
      this.onStatusChange("listening");
    } catch {
      this.onError("Failed to start speech recognition.");
      this.onStatusChange("error");
    }
  }

  private async processSpeech(text: string) {
    if (!text) return;
    this.processing = true;
    this.onStatusChange("processing");

    const userMsg: VoiceMessage = {
      id: crypto.randomUUID(),
      role: "user",
      text,
    };
    this.messages.push(userMsg);
    this.onMessagesChange([...this.messages]);

    const assistantText = await this.sendToChat(text);
    if (assistantText === null) return;

    const assistantMsg: VoiceMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      text: assistantText,
    };
    this.messages.push(assistantMsg);
    this.onMessagesChange([...this.messages]);

    this.processing = false;

    if (this.autoSpeak && assistantText) {
      this.onStatusChange("speaking");
      await this.speak(assistantText);
    } else {
      this.onStatusChange("idle");
    }
  }

  private async sendToChat(text: string): Promise<string | null> {
    this.abortController = new AbortController();

    try {
      const apiBase = getApiBaseUrl();
      const url = `${apiBase}/api/chat`;

      const body = {
        messages: [
          {
            role: "user" as const,
            parts: [{ type: "text", text }],
          },
        ],
        mode: this.mode,
      };

      const res = await authenticatedFetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: this.abortController.signal,
      });

      if (!res.ok) {
        const errorText = await res.text();
        let errorMessage = `API error: ${res.status}`;
        try {
          const errorJson = JSON.parse(errorText);
          errorMessage = errorJson.message || errorMessage;
        } catch {
          errorMessage = errorText || errorMessage;
        }
        this.onError(errorMessage);
        this.onStatusChange("error");
        return null;
      }

      let fullText = "";
      await streamTextLines(res, (delta) => {
        fullText = delta;
        this.onResponse(fullText);
      });

      return fullText;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") return null;
      const message = err instanceof Error ? err.message : "Failed to send message";
      this.onError(message);
      this.onStatusChange("error");
      return null;
    } finally {
      this.abortController = null;
    }
  }

  private speak(text: string): Promise<void> {
    return new Promise((resolve) => {
      if (typeof window === "undefined" || !("speechSynthesis" in window)) {
        resolve();
        return;
      }

      window.speechSynthesis.cancel();

      const utterance = new SpeechSynthesisUtterance(text);
      utterance.rate = this.voiceRate;
      utterance.pitch = 1;
      utterance.volume = 1;

      utterance.onend = () => {
        this.speaking = false;
        this.onStatusChange("idle");
        resolve();
      };

      utterance.onerror = () => {
        this.speaking = false;
        this.onStatusChange("idle");
        resolve();
      };

      this.speaking = true;
      window.speechSynthesis.speak(utterance);
    });
  }

  stopListening() {
    if (this.recognition) {
      try {
        this.recognition.abort();
      } catch {
        /* noop */
      }
      this.recognition = null;
    }
  }

  stopSpeaking() {
    if ("speechSynthesis" in window) {
      window.speechSynthesis.cancel();
    }
    this.speaking = false;
  }

  stop() {
    this.stopListening();
    this.stopSpeaking();
    if (this.abortController) {
      this.abortController.abort();
      this.abortController = null;
    }
    this.processing = false;
    this.currentTranscript = "";
  }

  getMessages(): VoiceMessage[] {
    return [...this.messages];
  }

  clearMessages() {
    this.messages = [];
    this.onMessagesChange([]);
  }

  isProcessing(): boolean {
    return this.processing || this.speaking;
  }
}
