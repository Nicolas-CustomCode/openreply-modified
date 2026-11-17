import { describe, expect, it } from "vitest";
import { safeCallbackUrl } from "@/lib/safe-redirect";

describe("safeCallbackUrl", () => {
  it("allows a same-site path", () => {
    expect(safeCallbackUrl("/dashboard")).toBe("/dashboard");
    expect(safeCallbackUrl("/campaigns/new?template=fitness-plan")).toBe(
      "/campaigns/new?template=fitness-plan"
    );
  });

  it("rejects an absolute URL to another origin", () => {
    expect(safeCallbackUrl("https://evil.example")).toBeNull();
    expect(safeCallbackUrl("http://evil.example/login")).toBeNull();
  });

  it("rejects protocol-relative targets that look like paths", () => {
    // The subtle ones: a browser reads both of these as another origin, even
    // though a "starts with /" check would wave them through.
    expect(safeCallbackUrl("//evil.example")).toBeNull();
    expect(safeCallbackUrl("/\\evil.example")).toBeNull();
  });

  it("rejects other schemes", () => {
    expect(safeCallbackUrl("javascript:alert(1)")).toBeNull();
    expect(safeCallbackUrl("data:text/html,<script>")).toBeNull();
  });

  it("returns null for an absent value", () => {
    expect(safeCallbackUrl(undefined)).toBeNull();
    expect(safeCallbackUrl(null)).toBeNull();
    expect(safeCallbackUrl("")).toBeNull();
  });
});
