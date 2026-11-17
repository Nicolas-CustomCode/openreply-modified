import { describe, expect, it, vi, beforeEach } from "vitest";
import {
  createOAuthState,
  decryptToken,
  encryptToken,
  getAuthorizationUrl,
  verifyOAuthState,
} from "../lib/meta/oauth";

beforeEach(() => {
  vi.stubEnv("NEXTAUTH_SECRET", "test-secret-with-enough-length");
  vi.stubEnv(
    "ENCRYPTION_KEY",
    "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
  );
});

describe("OAuth state and token encryption", () => {
  it("round-trips encrypted tokens", () => {
    const encrypted = encryptToken("long-lived-token");
    expect(encrypted).not.toBe("long-lived-token");
    expect(decryptToken(encrypted)).toBe("long-lived-token");
  });

  it("signs and verifies Instagram OAuth state", () => {
    const state = createOAuthState("workspace_123");
    expect(verifyOAuthState(state)?.workspaceId).toBe("workspace_123");
  });

  it("rejects tampered OAuth state", () => {
    const state = createOAuthState("workspace_123");
    expect(verifyOAuthState(`${state}tampered`)).toBeNull();
  });
});

describe("Instagram authorization URL", () => {
  beforeEach(() => {
    vi.stubEnv("INSTAGRAM_APP_ID", "1234567890");
  });

  // Business Login is served from www.instagram.com. Sending the user to
  // api.instagram.com instead — the host that handles the token exchange, and
  // the one it is natural to reuse — returns Instagram's ordinary 404 page
  // rather than an OAuth error, so the mistake looks like a broken link and
  // survives every other check.
  it("points the consent step at www.instagram.com", () => {
    const url = new URL(
      getAuthorizationUrl("https://example.com/api/instagram/callback", "state")
    );

    expect(url.origin).toBe("https://www.instagram.com");
    expect(url.pathname).toBe("/oauth/authorize");
  });

  it("carries the redirect URI and state through unescaped", () => {
    const redirectUri = "https://example.com/api/instagram/callback";
    const url = new URL(getAuthorizationUrl(redirectUri, "signed-state"));

    expect(url.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(url.searchParams.get("state")).toBe("signed-state");
    expect(url.searchParams.get("response_type")).toBe("code");
  });
});
