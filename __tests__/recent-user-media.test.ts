import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRecentUserMedia } from "@/lib/meta/client";

const NOW = Date.parse("2026-11-17T12:00:00Z");
const SINCE = NOW - 24 * 60 * 60 * 1000;

function post(id: string, hoursAgo: number) {
  return {
    id,
    media_type: "IMAGE",
    timestamp: new Date(NOW - hoursAgo * 60 * 60 * 1000).toISOString(),
  };
}

function page(data: unknown[], next?: string) {
  return new Response(
    JSON.stringify({ data, ...(next ? { paging: { next } } : {}) }),
    { status: 200 }
  );
}

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("getRecentUserMedia", () => {
  it("stops paging once it passes the start of the window", async () => {
    fetchMock.mockResolvedValueOnce(
      page([post("a", 1), post("b", 2), post("old", 30)], "https://next/2")
    );

    const result = await getRecentUserMedia("token", {
      sinceMs: SINCE,
      min: 2,
      max: 100,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.media.map((m) => m.id)).toEqual(["a", "b"]);
    expect(result.truncated).toBe(false);
  });

  it("tops up to the minimum with posts from before the window", async () => {
    fetchMock
      .mockResolvedValueOnce(page([post("x", 30), post("y", 40)], "https://next/2"))
      .mockResolvedValueOnce(page([post("z", 50)], "https://next/3"));

    const result = await getRecentUserMedia("token", {
      sinceMs: SINCE,
      min: 3,
      max: 100,
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("https://next/2");
    expect(result.media.map((m) => m.id)).toEqual(["x", "y", "z"]);
    expect(result.truncated).toBe(false);
  });

  it("reports when the ceiling cuts the window short", async () => {
    fetchMock.mockResolvedValueOnce(
      page([post("a", 1), post("b", 2)], "https://next/2")
    );

    const result = await getRecentUserMedia("token", {
      sinceMs: SINCE,
      min: 1,
      max: 2,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.media).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("is not truncated when the account simply has no older posts", async () => {
    fetchMock.mockResolvedValueOnce(page([post("a", 1)]));

    const result = await getRecentUserMedia("token", {
      sinceMs: SINCE,
      min: 10,
      max: 100,
    });

    expect(result.media.map((m) => m.id)).toEqual(["a"]);
    expect(result.truncated).toBe(false);
  });
});
