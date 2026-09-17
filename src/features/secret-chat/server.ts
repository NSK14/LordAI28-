import { createHmac, timingSafeEqual } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import type { Database } from "@/integrations/supabase/types";

export const SECRET_SESSION_COOKIE = "lord_secret_chat";
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 7;

type AuthContext = {
  userId: string;
  claims: unknown;
};

type SecretIdentity = AuthContext & { email: string };

export type SecretMessage = Database["public"]["Tables"]["secret_messages"]["Row"];

function normalizeSecretEmail(value: string): string {
  return value.trim().toLowerCase();
}

function isGoogleEmail(value: string): boolean {
  return /^[^@\s]+@(?:gmail\.com|googlemail\.com)$/i.test(value.trim());
}

function hasGoogleProvider(claims: unknown): boolean {
  if (!claims || typeof claims !== "object") return false;

  const appMetadata = Reflect.get(claims, "app_metadata");
  const appProvider = appMetadata && typeof appMetadata === "object"
    ? Reflect.get(appMetadata, "provider")
    : undefined;
  if (typeof appProvider === "string" && appProvider.toLowerCase() === "google") {
    return true;
  }

  const identities = Reflect.get(claims, "identities");
  if (Array.isArray(identities)) {
    return identities.some((identity) => {
      if (!identity || typeof identity !== "object") return false;
      const provider = Reflect.get(identity, "provider");
      return typeof provider === "string" && provider.toLowerCase() === "google";
    });
  }

  return false;
}

export function getAllowedSecretEmails(): string[] {
  return [...new Set(
    [process.env.SECRET_CHAT_EMAIL_1, process.env.SECRET_CHAT_EMAIL_2]
      .filter((value): value is string => Boolean(value))
      .map((value) => normalizeSecretEmail(value)),
  )];
}

export function getSecretIdentity(context: AuthContext | undefined): SecretIdentity | null {
  if (!context?.userId || !context.claims || typeof context.claims !== "object") return null;
  const email = Reflect.get(context.claims, "email");
  if (typeof email !== "string" || !isAllowedEmail(email) || !hasGoogleProvider(context.claims)) {
    return null;
  }
  return { ...context, email: normalizeSecretEmail(email) };
}

export function hasSecretAccess(context: AuthContext | undefined): boolean {
  if (!context?.claims || typeof context.claims !== "object") return false;
  const email = Reflect.get(context.claims, "email");
  return typeof email === "string" && isAllowedEmail(email) && hasGoogleProvider(context.claims);
}

export function isAllowedEmail(email: string): boolean {
  const allowed = getAllowedSecretEmails();
  const normalized = normalizeSecretEmail(email);
  return allowed.length === 2 && isGoogleEmail(normalized) && allowed.includes(normalized);
}

export function getSecretPeerEmail(email: string): string | null {
  const allowed = getAllowedSecretEmails();
  if (allowed.length !== 2) return null;
  const normalized = email.trim().toLowerCase();
  if (normalized === allowed[0]) return allowed[1];
  if (normalized === allowed[1]) return allowed[0];
  return null;
}

export function isValidPin(pin: unknown): pin is string {
  const configured = process.env.SECRET_CHAT_PIN;
  if (!configured || !/^\d{4}$/.test(configured) || typeof pin !== "string") return false;
  if (!/^\d{4}$/.test(pin)) return false;
  return timingSafeEqual(Buffer.from(pin), Buffer.from(configured));
}

function getSessionSecret(): string | null {
  return process.env.SECRET_CHAT_SESSION_SECRET?.trim() || null;
}

function sign(value: string): string {
  const secret = getSessionSecret();
  if (!secret) throw new Error("Secret chat session secret is missing.");
  return createHmac("sha256", secret).update(value).digest("base64url");
}

export function createSecretSession(userId: string): string {
  const payload = `${userId}.${Date.now() + SESSION_TTL_SECONDS * 1000}`;
  return `${payload}.${sign(payload)}`;
}

export function verifySecretSession(request: Request, userId: string): boolean {
  const raw = request.headers.get("cookie")?.match(
    new RegExp(`(?:^|;\\s*)${SECRET_SESSION_COOKIE}=([^;]+)`),
  )?.[1];
  if (!raw) return false;

  const [sessionUserId, expiresAt, signature] = raw.split(".");
  if (!sessionUserId || !expiresAt || !signature || sessionUserId !== userId) return false;
  if (!Number.isFinite(Number(expiresAt)) || Number(expiresAt) < Date.now()) return false;

  const expected = sign(`${sessionUserId}.${expiresAt}`);
  const actualBuffer = Buffer.from(signature);
  const expectedBuffer = Buffer.from(expected);
  return (
    actualBuffer.length === expectedBuffer.length && timingSafeEqual(actualBuffer, expectedBuffer)
  );
}

export function sessionCookie(value: string, maxAge = SESSION_TTL_SECONDS): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SECRET_SESSION_COOKIE}=${value}; Max-Age=${maxAge}; Path=/; HttpOnly; SameSite=Lax${secure}`;
}

export function getSecretServiceClient() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error("Secret chat service configuration is missing.");
  return createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

export async function resolveSecretPeer(identity: SecretIdentity): Promise<{
  userId: string;
  email: string;
  peerId: string;
  peerEmail: string;
}> {
  const peerEmail = getSecretPeerEmail(identity.email);
  if (!peerEmail) throw new Error("Secret chat participant is not configured.");

  const admin = getSecretServiceClient();
  const { data, error } = await admin.auth.admin.listUsers({ page: 1, perPage: 1000 });
  if (error) throw error;
  const peer = data.users.find((user) => user.email?.toLowerCase() === peerEmail);
  if (!peer) throw new Error("Secret chat participant is not configured.");

  return { userId: identity.userId, email: identity.email, peerId: peer.id, peerEmail };
}

export function notFoundResponse(): Response {
  return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });
}

export function invalidSecretResponse(): Response {
  return Response.json({ error: "Invalid PIN" }, { status: 403 });
}

export function accessDeniedResponse(): Response {
  return Response.json({ error: "Access Denied" }, { status: 403 });
}
