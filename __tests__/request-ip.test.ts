import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { getClientIp, UNKNOWN_IP } from "@/lib/request-ip";

function headers(values: Record<string, string>) {
  return new Headers(values);
}

const ORIGINAL = process.env.TRUSTED_PROXY_HOPS;

describe("getClientIp", () => {
  beforeEach(() => {
    delete process.env.TRUSTED_PROXY_HOPS;
  });

  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.TRUSTED_PROXY_HOPS;
    else process.env.TRUSTED_PROXY_HOPS = ORIGINAL;
  });

  it("reads the address the trusted proxy appended, not the first entry", () => {
    // The proxy appends what it saw; everything to its left came from the client.
    const ip = getClientIp(
      headers({ "x-forwarded-for": "1.1.1.1, 203.0.113.7" })
    );
    expect(ip).toBe("203.0.113.7");
  });

  it("ignores a forged x-forwarded-for prefix", () => {
    // This is the attack: pad the header so the real address is not the one read.
    const ip = getClientIp(
      headers({
        "x-forwarded-for": "9.9.9.9, 8.8.8.8, 7.7.7.7, 198.51.100.20",
      })
    );
    expect(ip).toBe("198.51.100.20");
    expect(ip).not.toBe("9.9.9.9");
  });

  it("honours a two-proxy chain", () => {
    process.env.TRUSTED_PROXY_HOPS = "2";
    const ip = getClientIp(
      headers({ "x-forwarded-for": "9.9.9.9, 203.0.113.7, 10.0.0.1" })
    );
    expect(ip).toBe("203.0.113.7");
  });

  it("falls back to x-real-ip when x-forwarded-for is absent", () => {
    expect(getClientIp(headers({ "x-real-ip": "203.0.113.9" }))).toBe(
      "203.0.113.9"
    );
  });

  it("ignores both headers when no proxy is trusted", () => {
    process.env.TRUSTED_PROXY_HOPS = "0";
    const ip = getClientIp(
      headers({ "x-forwarded-for": "9.9.9.9", "x-real-ip": "8.8.8.8" })
    );
    expect(ip).toBe(UNKNOWN_IP);
  });

  it("returns the shared sentinel when there are no proxy headers", () => {
    expect(getClientIp(headers({}))).toBe(UNKNOWN_IP);
  });

  it("falls back to one hop when TRUSTED_PROXY_HOPS is nonsense", () => {
    process.env.TRUSTED_PROXY_HOPS = "not-a-number";
    expect(getClientIp(headers({ "x-forwarded-for": "1.1.1.1, 2.2.2.2" }))).toBe(
      "2.2.2.2"
    );
  });
});
