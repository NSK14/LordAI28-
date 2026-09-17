import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  getAllowedSecretEmails,
  getSecretPeerEmail,
  isAllowedEmail,
  isValidPin,
  sessionCookie,
  verifySecretSession,
  createSecretSession,
} from "./server";

describe("secret chat configuration", () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  it("requires exactly two configured Google whitelist emails and resolves the peer", () => {
    vi.stubEnv("SECRET_CHAT_EMAIL_1", "alice@gmail.com");
    vi.stubEnv("SECRET_CHAT_EMAIL_2", "bob@gmail.com");

    expect(getAllowedSecretEmails()).toEqual(["alice@gmail.com", "bob@gmail.com"]);
    expect(isAllowedEmail("alice@gmail.com")).toBe(true);
    expect(isAllowedEmail("BOB@GMAIL.com")).toBe(true);
    expect(isAllowedEmail("carol@example.com")).toBe(false);
    expect(isAllowedEmail("dave@outlook.com")).toBe(false);
    expect(getSecretPeerEmail("alice@gmail.com")).toBe("bob@gmail.com");
    expect(getSecretPeerEmail("bob@gmail.com")).toBe("alice@gmail.com");
  });

  it("accepts only a matching 4-digit PIN", () => {
    vi.stubEnv("SECRET_CHAT_PIN", "4321");

    expect(isValidPin("4321")).toBe(true);
    expect(isValidPin("1234")).toBe(false);
    expect(isValidPin("43210")).toBe(false);
    expect(isValidPin("abcd")).toBe(false);
  });

  it("keeps the secret session cookie usable in local dev and validates generated sessions", () => {
    vi.stubEnv("SECRET_CHAT_SESSION_SECRET", "a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6");
    const userId = "user-123";
    const cookieValue = createSecretSession(userId);
    const cookieHeader = sessionCookie(cookieValue, 60);

    expect(cookieHeader).toContain("lord_secret_chat=");
    expect(cookieHeader).not.toContain("Secure");

    const request = new Request("https://example.com/auth/chat", {
      headers: { cookie: cookieHeader },
    });

    expect(verifySecretSession(request, userId)).toBe(true);
    expect(verifySecretSession(new Request("https://example.com/auth/chat"), userId)).toBe(false);
  });
});
