import { describe, expect, it } from "vitest";
import {
  buildCommentList,
  DEFAULT_HOURS,
  DEFAULT_POSTS,
  mapWithConcurrency,
  MAX_HOURS,
  MAX_POSTS,
  parseCommentsQuery,
} from "@/lib/instagram-comments";
import type { InstagramComment } from "@/lib/meta/client";

const ACCOUNT = "17841400000000001";

function comment(
  id: string,
  timestamp: string,
  overrides: Partial<InstagramComment> = {}
): InstagramComment {
  return {
    id,
    text: `comment ${id}`,
    timestamp,
    from: { id: `user_${id}`, username: `user${id}` },
    ...overrides,
  };
}

describe("parseCommentsQuery", () => {
  it("uses the defaults when nothing is passed", () => {
    expect(parseCommentsQuery(new URLSearchParams())).toEqual({
      posts: DEFAULT_POSTS,
      hours: DEFAULT_HOURS,
      unanswered: false,
    });
  });

  it("reads valid values", () => {
    expect(
      parseCommentsQuery(
        new URLSearchParams("posts=5&hours=24&unanswered=true")
      )
    ).toEqual({ posts: 5, hours: 24, unanswered: true });
  });

  it("clamps out-of-range values and ignores junk", () => {
    expect(
      parseCommentsQuery(new URLSearchParams("posts=999&hours=0"))
    ).toMatchObject({ posts: MAX_POSTS, hours: 1 });
    expect(
      parseCommentsQuery(new URLSearchParams("posts=abc&hours=100000"))
    ).toMatchObject({ posts: DEFAULT_POSTS, hours: MAX_HOURS });
  });

  it("only treats true or 1 as unanswered", () => {
    expect(
      parseCommentsQuery(new URLSearchParams("unanswered=1")).unanswered
    ).toBe(true);
    expect(
      parseCommentsQuery(new URLSearchParams("unanswered=yes")).unanswered
    ).toBe(false);
  });
});

describe("buildCommentList", () => {
  it("marks a comment answered only when the account replied", () => {
    const list = buildCommentList(
      ACCOUNT,
      [
        {
          postId: "p1",
          comments: [
            comment("1", "2026-11-17T10:00:00+0000", {
              replies: {
                data: [
                  {
                    id: "r1",
                    text: "thanks!",
                    timestamp: "2026-11-17T10:05:00+0000",
                    from: { id: ACCOUNT, username: "brand" },
                  },
                ],
              },
            }),
            comment("2", "2026-11-17T09:00:00+0000", {
              replies: {
                data: [
                  {
                    id: "r2",
                    text: "me too",
                    from: { id: "someone_else", username: "other" },
                  },
                ],
              },
            }),
          ],
        },
      ],
      { unanswered: false }
    );

    expect(list.map((c) => [c.id, c.answered])).toEqual([
      ["1", true],
      ["2", false],
    ]);
    expect(list[0].replies[0]).toMatchObject({ text: "thanks!", fromMe: true });
    expect(list[1].replies[0]).toMatchObject({
      username: "other",
      fromMe: false,
    });
  });

  it("drops answered comments when only unanswered are wanted", () => {
    const list = buildCommentList(
      ACCOUNT,
      [
        {
          postId: "p1",
          comments: [
            comment("1", "2026-11-17T10:00:00+0000", {
              replies: { data: [{ id: "r1", from: { id: ACCOUNT } }] },
            }),
            comment("2", "2026-11-17T09:00:00+0000"),
          ],
        },
      ],
      { unanswered: true }
    );

    expect(list.map((c) => c.id)).toEqual(["2"]);
  });

  it("leaves out the account's own comments and ones with no author", () => {
    const list = buildCommentList(
      ACCOUNT,
      [
        {
          postId: "p1",
          comments: [
            comment("1", "2026-11-17T10:00:00+0000", {
              from: { id: ACCOUNT, username: "brand" },
            }),
            comment("2", "2026-11-17T09:00:00+0000", { from: undefined }),
            comment("3", "2026-11-17T08:00:00+0000"),
          ],
        },
      ],
      { unanswered: false }
    );

    expect(list.map((c) => c.id)).toEqual(["3"]);
  });

  it("merges posts newest first and keeps replies in reading order", () => {
    const list = buildCommentList(
      ACCOUNT,
      [
        {
          postId: "p1",
          comments: [
            comment("old", "2026-11-16T10:00:00+0000", {
              replies: {
                data: [
                  { id: "b", text: "second", timestamp: "2026-11-16T12:00:00+0000" },
                  { id: "a", text: "first", timestamp: "2026-11-16T11:00:00+0000" },
                ],
              },
            }),
          ],
        },
        {
          postId: "p2",
          comments: [comment("new", "2026-11-17T10:00:00+0000")],
        },
      ],
      { unanswered: false }
    );

    expect(list.map((c) => [c.id, c.postId])).toEqual([
      ["new", "p2"],
      ["old", "p1"],
    ]);
    expect(list[1].replies.map((r) => r.id)).toEqual(["a", "b"]);
  });
});

describe("mapWithConcurrency", () => {
  it("keeps input order and never exceeds the limit", async () => {
    let inFlight = 0;
    let peak = 0;

    const result = await mapWithConcurrency([30, 10, 20, 5, 15], 2, async (ms) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((resolve) => setTimeout(resolve, ms));
      inFlight -= 1;
      return ms * 2;
    });

    expect(result).toEqual([60, 20, 40, 10, 30]);
    expect(peak).toBe(2);
  });

  it("handles an empty list", async () => {
    await expect(mapWithConcurrency([], 3, async () => 1)).resolves.toEqual([]);
  });
});
