import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { AppShell } from "@/components/lord/AppShell";
import { HudPanel } from "@/components/lord/HudPanel";
import { Loader2, LockKeyhole, Send, ShieldAlert, Wifi, WifiOff } from "lucide-react";

export type PrivateChatMessage = {
  id: string;
  sender_id: string;
  receiver_id: string;
  message: string;
  created_at: string;
  read_at: string | null;
  seen_at: string | null;
  edited_at: string | null;
  deleted_at: string | null;
};

type Session = { userId: string; peerId: string; peerEmail: string };

type Props = { onLogout: () => void };

export function SecretChatPage({ onLogout }: Props) {
  const [session, setSession] = useState<Session | null>(null);
  const [messages, setMessages] = useState<PrivateChatMessage[]>([]);
  const [pin, setPin] = useState("");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);
  const [accessDenied, setAccessDenied] = useState(false);
  const [typing, setTyping] = useState(false);
  const [peerOnline, setPeerOnline] = useState(false);
  const bottomRef = useRef<HTMLDivElement>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  useEffect(() => {
    void fetch("/api/private-chat/session", { credentials: "same-origin" })
      .then(async (response) => {
        if (response.status === 403) {
          setAccessDenied(true);
          return null;
        }
        if (!response.ok) return null;
        return (await response.json()) as {
          authorized?: boolean;
          pinVerified?: boolean;
        } & Partial<Session>;
      })
      .then((data) => {
        if (data?.authorized === false) {
          setAccessDenied(true);
          return;
        }
        if (data?.pinVerified && data.userId && data.peerId && data.peerEmail) {
          setSession({ userId: data.userId, peerId: data.peerId, peerEmail: data.peerEmail });
        }
      })
      .catch(() => undefined)
      .finally(() => setBusy(false));
  }, []);

  useEffect(() => {
    if (!session) return;
    let active = true;
    const load = async () => {
      const response = await fetch("/api/private-chat/messages", { credentials: "same-origin" });
      if (!response.ok) throw new Error("Connection lost. Retrying...");
      const data = (await response.json()) as { messages: PrivateChatMessage[] };
      if (active) setMessages(data.messages);
    };
    void load().catch((reason: unknown) => active && setError(reason instanceof Error ? reason.message : "Connection lost. Retrying..."));

    const channel = supabase
      .channel(`private-chat:${session.userId}`, { config: { presence: { key: session.userId } } })
      .on("postgres_changes", { event: "*", schema: "public", table: "secret_messages" }, (payload) => {
        const row = payload.new as PrivateChatMessage;
        const belongs = [row.sender_id, row.receiver_id].includes(session.userId) && [row.sender_id, row.receiver_id].includes(session.peerId);
        if (!belongs) return;
        if (payload.eventType === "INSERT") {
          setMessages((current) => current.some((item) => item.id === row.id) ? current : [...current, row]);
        } else {
          setMessages((current) => current.map((item) => item.id === row.id ? row : item));
        }
      })
      .on("broadcast", { event: "typing" }, ({ payload }) => {
        if (payload?.userId === session.peerId) setTyping(Boolean(payload.typing));
      })
      .on("presence", { event: "sync" }, () => {
        const state = channel.presenceState<{ userId: string }>();
        setPeerOnline(Boolean(state[session.peerId]?.length));
      })
      .on("presence", { event: "join" }, ({ key }) => key === session.peerId && setPeerOnline(true))
      .on("presence", { event: "leave" }, ({ key }) => key === session.peerId && setPeerOnline(false));

    void channel.subscribe(async (status) => {
      if (status === "SUBSCRIBED") await channel.track({ userId: session.userId, onlineAt: new Date().toISOString() });
    });
    channelRef.current = channel;
    return () => {
      active = false;
      channelRef.current = null;
      void supabase.removeChannel(channel);
    };
  }, [session]);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
    if (!session) return;
    const unread = messages.filter((item) => item.receiver_id === session.userId && !item.seen_at).map((item) => item.id);
    if (unread.length) {
      void fetch("/api/private-chat/seen", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ messageIds: unread }) });
    }
  }, [messages, session]);

  const ordered = useMemo(() => [...messages].sort((a, b) => a.created_at.localeCompare(b.created_at)), [messages]);

  async function unlock(event: React.FormEvent) {
    event.preventDefault();
    setPinError(null);
    const response = await fetch("/api/private-chat/pin", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ pin }) });
    if (!response.ok) {
      setPinError("Invalid PIN");
      return;
    }
    const data = await fetch("/api/private-chat/session", { credentials: "same-origin" }).then((result) => result.json()) as Session & { unlocked: boolean };
    setSession({ userId: data.userId, peerId: data.peerId, peerEmail: data.peerEmail });
  }

  async function send(event: React.FormEvent) {
    event.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    const response = await fetch("/api/private-chat/messages", { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ message: text }) });
    const data = (await response.json().catch(() => ({}))) as { message?: PrivateChatMessage; error?: string };
    if (!response.ok) setError(data.error ?? "Connection lost. Retrying...");
    else if (data.message) {
      setMessages((current) => current.some((item) => item.id === data.message!.id) ? current : [...current, data.message!]);
      setDraft("");
    }
    setSending(false);
  }

  function updateDraft(value: string) {
    setDraft(value);
    if (!session) return;
    const channel = channelRef.current;
    if (!channel) return;
    void channel.send({ type: "broadcast", event: "typing", payload: { userId: session.userId, typing: true } });
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => { void channel.send({ type: "broadcast", event: "typing", payload: { userId: session.userId, typing: false } }); }, 2000);
  }

  if (busy) return <AppShell><div className="flex min-h-[60vh] items-center justify-center"><Loader2 className="h-6 w-6 animate-spin text-primary" /></div></AppShell>;
  if (accessDenied) return <AccessDenied />;
  if (!session) return <PinGate pin={pin} setPin={setPin} error={pinError} onSubmit={unlock} />;

  return <AppShell><div className="mx-auto w-full max-w-3xl px-2 py-4"><HudPanel title="Private Workspace" subtitle={session.peerEmail}>
    <div className="mb-3 flex items-center justify-between text-xs text-muted-foreground"><span className="flex items-center gap-2">{peerOnline ? <Wifi className="h-3.5 w-3.5 text-cyan-300" /> : <WifiOff className="h-3.5 w-3.5" />}{peerOnline ? "Online" : "Last active unavailable"}</span><button onClick={onLogout} className="text-primary hover:underline">Lock</button></div>
    <div className="flex h-[min(68vh,620px)] flex-col rounded-xl border border-primary/20 bg-background/30">
      <div className="flex-1 space-y-3 overflow-y-auto p-4">{ordered.map((message) => { const own = message.sender_id === session.userId; return <div key={message.id} className={`flex ${own ? "justify-end" : "justify-start"}`}><div className={`max-w-[82%] rounded-2xl px-3 py-2 shadow-lg ${own ? "rounded-br-sm bg-primary/80 text-primary-foreground" : "rounded-bl-sm border border-border/60 bg-card/70"}`}><p className="whitespace-pre-wrap break-words text-sm">{message.message}</p><p className={`mt-1 text-[10px] ${own ? "text-primary-foreground/70" : "text-muted-foreground"}`}>{new Date(message.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}{own && `  ${message.seen_at ? "✓✓" : message.read_at ? "✓✓" : "✓"}`}</p></div></div>; })}{typing && <p className="text-xs italic text-muted-foreground">Typing...</p>}<div ref={bottomRef} /></div>
      {error && <div className="border-t border-destructive/30 px-3 py-2 text-xs text-destructive">{error}</div>}
      <form onSubmit={send} className="border-t border-primary/15 p-3"><div className="flex items-end gap-2"><textarea value={draft} onChange={(event) => updateDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey) { event.preventDefault(); void send(event); } }} rows={1} maxLength={4000} placeholder="Write a private message..." className="min-h-11 flex-1 resize-none rounded-xl border border-border/60 bg-background/60 px-3 py-2.5 text-sm outline-none focus:border-primary" /><button type="submit" disabled={sending || !draft.trim()} className="inline-flex h-11 w-11 items-center justify-center rounded-xl bg-primary text-primary-foreground disabled:opacity-50" aria-label="Send message"><Send className="h-4 w-4" /></button></div></form>
    </div>
  </HudPanel></div></AppShell>;
}

function AccessDenied() {
  return <AppShell><div className="mx-auto flex min-h-[60vh] w-full max-w-md items-center px-2"><HudPanel title="Learning"><p className="text-center text-sm text-destructive">Access Denied</p></HudPanel></div></AppShell>;
}

function PinGate({ pin, setPin, error, onSubmit }: { pin: string; setPin: (value: string) => void; error: string | null; onSubmit: (event: React.FormEvent) => void }) {
  return <AppShell><div className="mx-auto flex min-h-[60vh] w-full max-w-md items-center px-2"><HudPanel title="Learning"><form onSubmit={onSubmit} className="space-y-5"><div className="flex items-center justify-center text-primary"><LockKeyhole className="h-7 w-7" /></div><label className="block text-center"><span className="mb-3 block text-sm text-muted-foreground">Enter Access PIN</span><input autoFocus inputMode="numeric" maxLength={4} value={pin} onChange={(event) => setPin(event.target.value.replace(/\D/g, ""))} className="w-full rounded-xl border border-primary/30 bg-background/60 px-4 py-3 text-center text-2xl tracking-[0.6em] outline-none focus:border-primary" aria-label="Access PIN" /></label>{error && <p className="flex items-center justify-center gap-2 text-sm text-destructive"><ShieldAlert className="h-4 w-4" />{error}</p>}<button type="submit" disabled={pin.length !== 4} className="w-full rounded-xl bg-primary px-4 py-3 font-semibold text-primary-foreground disabled:opacity-50">Unlock</button></form></HudPanel></div></AppShell>;
}
