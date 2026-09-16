import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createWakeEngine, type WakeEngine } from "@/lib/voice";
import { monitoring } from "@/lib/monitoring-service";
import type { LordMode } from "@/lib/modes";
import { VoicePipeline } from "@/lib/voice/voice-pipeline";
import type { VoiceMessage, VoicePipelineStatus } from "@/lib/voice/voice-pipeline";

type WakeStatus = "off" | "listening" | "heard" | "thinking" | "speaking" | "unsupported";

interface WakeWordContextValue {
  enabled: boolean;
  status: WakeStatus;
  transcript: string;
  reply: string;
  supported: boolean;
  toggle: () => void;
  messages: VoiceMessage[];
  clearMessages: () => void;
}

const WakeWordContext = createContext<WakeWordContextValue | undefined>(undefined);

export function WakeWordProvider({
  children,
  mode = "balanced",
  autoSpeak = true,
  voiceRate = 1,
}: {
  children: ReactNode;
  mode?: LordMode;
  autoSpeak?: boolean;
  voiceRate?: number;
}) {
  const [mounted, setMounted] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [status, setStatus] = useState<WakeStatus>("off");
  const [transcript, setTranscript] = useState("");
  const [reply, setReply] = useState("");
  const [messages, setMessages] = useState<VoiceMessage[]>([]);
  const engineRef = useRef<WakeEngine | null>(null);
  const pipelineRef = useRef<VoicePipeline | null>(null);
  const supported = mounted && Boolean(navigator.mediaDevices?.getUserMedia);

  const handlePipelineStatus = useCallback((pipelineStatus: VoicePipelineStatus) => {
    switch (pipelineStatus) {
      case "listening":
        setStatus("listening");
        setTranscript("");
        setReply("");
        break;
      case "processing":
        setStatus("thinking");
        break;
      case "speaking":
        setStatus("speaking");
        break;
      case "error":
        setStatus("off");
        setReply("Voice pipeline encountered an error. Please try again.");
        break;
      case "idle":
      default:
        setStatus("listening");
        break;
    }
  }, []);

  const handlePipelineTranscript = useCallback((text: string) => {
    setTranscript(text);
  }, []);

  const handlePipelineResponse = useCallback((text: string) => {
    setReply(text);
  }, []);

  const handlePipelineError = useCallback((error: string) => {
    monitoring.logEvent({ type: "error", category: "voice", message: error });
    setReply(error);
    setStatus("off");
  }, []);

  const handlePipelineMessages = useCallback((msgs: VoiceMessage[]) => {
    setMessages(msgs);
  }, []);

  const stop = useCallback(async () => {
    await engineRef.current?.stop();
    engineRef.current = null;
    pipelineRef.current?.stop();
    pipelineRef.current = null;
    setEnabled(false);
    setStatus(supported ? "off" : "unsupported");
    setTranscript("");
    setReply("");
    setMessages([]);
  }, [supported]);

  const start = useCallback(async () => {
    if (!supported) {
      setStatus("unsupported");
      return;
    }

    pipelineRef.current = new VoicePipeline();
    pipelineRef.current.onStatusChange = handlePipelineStatus;
    pipelineRef.current.onTranscript = handlePipelineTranscript;
    pipelineRef.current.onResponse = handlePipelineResponse;
    pipelineRef.current.onError = handlePipelineError;
    pipelineRef.current.onMessagesChange = handlePipelineMessages;
    await pipelineRef.current.initialize(mode, autoSpeak, voiceRate);

    try {
      setStatus("thinking");
      engineRef.current = await createWakeEngine(() => {
        setStatus("heard");
        setTranscript("Wake word detected: \u201cHey Lord\u201d");
        setReply("Listening for your command\u2026");
        window.setTimeout(() => {
          pipelineRef.current?.startListening();
        }, 900);
      });
      setEnabled(true);
      setStatus("listening");
    } catch (error) {
      const message = error instanceof Error ? error.message : "Microphone initialization failed";
      monitoring.logEvent({ type: "error", category: "voice", message });
      setReply(
        message.includes("denied")
          ? "Microphone access was denied. Enable it in browser settings."
          : "Voice activation could not start on this device.",
      );
      setStatus("unsupported");
    }
  }, [
    supported,
    mode,
    autoSpeak,
    voiceRate,
    handlePipelineStatus,
    handlePipelineTranscript,
    handlePipelineResponse,
    handlePipelineError,
    handlePipelineMessages,
  ]);

  const toggle = useCallback(() => {
    void (enabled ? stop() : start());
  }, [enabled, start, stop]);

  const clearMessages = useCallback(() => {
    pipelineRef.current?.clearMessages();
  }, []);

  useEffect(() => {
    setMounted(true);
    return () => {
      void engineRef.current?.stop();
      pipelineRef.current?.stop();
    };
  }, []);

  return (
    <WakeWordContext.Provider
      value={{ enabled, status, transcript, reply, supported, toggle, messages, clearMessages }}
    >
      {children}
    </WakeWordContext.Provider>
  );
}

export function useWakeWord() {
  const context = useContext(WakeWordContext);
  if (!context) {
    throw new Error("useWakeWord must be used within WakeWordProvider");
  }
  return context;
}
