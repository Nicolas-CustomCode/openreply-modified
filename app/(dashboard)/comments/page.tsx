"use client";

/**
 * Comments
 *
 * Recent comments on the selected account's latest posts, answered by hand one
 * at a time with a public reply. Owners and admins can reply; members can read.
 *
 * Unlike the inbox this page does not poll: one load reads the comments of
 * every listed post, on the same token the automation sends with, so it only
 * refreshes when asked to.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import AccountSelect, { type AccountOption } from "@/components/account-select";
import { readCache, writeCache } from "@/lib/client-cache";
import type { CommentsResponse } from "@/app/api/instagram/comments/route";
import type { CommentListItem } from "@/lib/instagram-comments";

const CACHE_MAX_AGE_MS = 60_000;
const HOUR_OPTIONS = [
  { value: 24, label: "Last 24 hours" },
  { value: 48, label: "Last 48 hours" },
  { value: 168, label: "Last 7 days" },
];

const cacheKey = (accountId: string, hours: number, unanswered: boolean) =>
  `comments:${accountId}:${hours}:${unanswered ? "open" : "all"}`;

function formatTime(iso: string | null): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const sameDay = d.toDateString() === new Date().toDateString();
  return sameDay
    ? d.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        hour: "numeric",
        minute: "2-digit",
      });
}

function truncate(text: string | null, max: number): string {
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export default function CommentsPage() {
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [selectedAccountId, setSelectedAccountId] = useState("");
  const [hours, setHours] = useState(48);
  const [unansweredOnly, setUnansweredOnly] = useState(true);
  const [postFilter, setPostFilter] = useState("all");

  const [data, setData] = useState<CommentsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/instagram/accounts")
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.success) {
          setLoading(false);
          return;
        }
        const next: AccountOption[] = payload.data.instagramAccounts ?? [];
        setAccounts(next);
        const first = payload.data.selectedInstagramAccountId || next[0]?.id;
        if (first) {
          setSelectedAccountId(first);
        } else {
          setLoading(false);
        }
      })
      .catch(() => {
        setAccounts([]);
        setLoading(false);
      });
  }, []);

  const load = useCallback(
    async (silent: boolean) => {
      if (!selectedAccountId) return;
      if (!silent) setLoading(true);
      try {
        // The window covers posts too: every post published inside it is read
        // (the API keeps the latest few from before it as well), so an account
        // that posts many times a day still gets its whole day.
        const since = new Date(Date.now() - hours * 60 * 60 * 1000);
        const qs = new URLSearchParams({
          instagramAccountId: selectedAccountId,
          hours: String(hours),
          since: since.toISOString(),
          unanswered: String(unansweredOnly),
        });
        const res = await fetch(`/api/instagram/comments?${qs}`, {
          cache: "no-store",
        });
        const payload = await res.json();
        if (payload.success) {
          setData(payload.data);
          writeCache(
            cacheKey(selectedAccountId, hours, unansweredOnly),
            payload.data
          );
          setError(null);
        } else {
          setError(payload.error ?? "Failed to load comments");
        }
      } catch {
        setError("Failed to load comments");
      } finally {
        setLoading(false);
      }
    },
    [selectedAccountId, hours, unansweredOnly]
  );

  // Paint a cached copy instantly, then fetch a fresh one.
  useEffect(() => {
    if (!selectedAccountId) return;
    const cached = readCache<CommentsResponse>(
      cacheKey(selectedAccountId, hours, unansweredOnly),
      CACHE_MAX_AGE_MS
    );
    // Intentional reset when the account or filters change.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setData(cached.data);
    setReplyingTo(null);
    void load(Boolean(cached.data));
  }, [selectedAccountId, hours, unansweredOnly, load]);

  const postsById = useMemo(
    () => new Map((data?.posts ?? []).map((p) => [p.id, p])),
    [data]
  );

  const visible = useMemo(
    () =>
      (data?.comments ?? []).filter(
        (c) => postFilter === "all" || c.postId === postFilter
      ),
    [data, postFilter]
  );

  function openReply(comment: CommentListItem) {
    setReplyingTo(comment.id);
    setDraft("");
    setSendError(null);
  }

  async function handleReply(comment: CommentListItem) {
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setSendError(null);

    try {
      const res = await fetch("/api/instagram/comments", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          instagramAccountId: selectedAccountId,
          commentId: comment.id,
          text,
        }),
      });
      const payload = await res.json();
      if (!payload.success) {
        setSendError(payload.error ?? "Failed to post the reply");
        return;
      }

      // Show the reply in place and keep the comment on screen, marked
      // answered, so the result is visible. The next load drops it from the
      // unanswered view.
      setData((prev) =>
        prev
          ? {
              ...prev,
              verificationPending: Math.max(
                0,
                (prev.verificationPending ?? 0) - (comment.verifying ? 1 : 0)
              ),
              comments: prev.comments.map((c) =>
                c.id === comment.id
                  ? {
                      ...c,
                      answered: true,
                      verifying: false,
                      replies: [
                        ...c.replies,
                        {
                          id: payload.data.id,
                          text,
                          username: prev.account.username,
                          fromMe: true,
                          timestamp: new Date().toISOString(),
                        },
                      ],
                    }
                  : c
              ),
            }
          : prev
      );
      setReplyingTo(null);
      setDraft("");
    } catch {
      setSendError("Failed to post the reply");
    } finally {
      setSending(false);
    }
  }

  function handleKeyDown(
    e: React.KeyboardEvent<HTMLTextAreaElement>,
    comment: CommentListItem
  ) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleReply(comment);
    }
  }

  const selectClass =
    "rounded border border-border bg-surface px-3 py-2 text-sm text-foreground focus:border-accent/40 focus:outline-none";

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-4">
        <h1 className="text-lg font-semibold text-foreground">Comments</h1>
        {accounts.length > 1 && (
          <AccountSelect
            accounts={accounts}
            value={selectedAccountId}
            onChange={(id) => {
              // Post ids belong to one account; a stale filter would hide
              // everything on the next one.
              setPostFilter("all");
              setSelectedAccountId(id);
            }}
            includeAll={false}
          />
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <select
          value={hours}
          onChange={(e) => setHours(Number(e.target.value))}
          className={selectClass}
          aria-label="Time window"
        >
          {HOUR_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <select
          value={postFilter}
          onChange={(e) => setPostFilter(e.target.value)}
          className={`${selectClass} max-w-full sm:max-w-xs`}
          aria-label="Post"
        >
          <option value="all">All recent posts</option>
          {(data?.posts ?? []).map((p) => (
            <option key={p.id} value={p.id}>
              {truncate(p.caption, 40) || formatTime(p.timestamp)}
            </option>
          ))}
        </select>
        <label className="flex items-center gap-2 text-sm text-foreground">
          <input
            type="checkbox"
            checked={unansweredOnly}
            onChange={(e) => setUnansweredOnly(e.target.checked)}
          />
          Unanswered only
        </label>
        <button
          type="button"
          onClick={() => void load(false)}
          disabled={loading || !selectedAccountId}
          className="rounded border border-border px-3 py-2 text-sm text-foreground hover:bg-surface-hover disabled:opacity-50"
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </div>

      {data && !data.canReply && (
        <p className="text-xs text-muted">
          Only workspace owners and admins can reply to comments.
        </p>
      )}

      {data && data.verificationPending > 0 && (
        <p className="text-xs text-muted">
          Still checking who replied on {data.verificationPending} comment
          {data.verificationPending === 1 ? "" : "s"}. Instagram only names a
          reply&apos;s author one reply at a time, so this settles over the next
          few refreshes.
        </p>
      )}

      {data?.postsTruncated && (
        <p className="text-xs text-warning">
          More posts were published in this window than can be read at once;
          showing comments on the latest {data.posts.length}.
        </p>
      )}

      {data && data.errors.length > 0 && (
        <p className="text-xs text-error">
          Could not read comments on {data.errors.length} post
          {data.errors.length === 1 ? "" : "s"}: {data.errors[0].message}
        </p>
      )}

      <div className="overflow-hidden rounded border border-border">
        {loading && !data ? (
          <p className="px-4 py-6 text-sm text-muted">Loading…</p>
        ) : error && !data ? (
          <p className="px-4 py-6 text-sm text-error">{error}</p>
        ) : !selectedAccountId ? (
          <p className="px-4 py-6 text-sm text-muted">
            Connect an Instagram account to see its comments.
          </p>
        ) : visible.length === 0 ? (
          <p className="px-4 py-6 text-sm text-muted">
            {unansweredOnly
              ? "No unanswered comments in this window."
              : "No comments in this window."}
          </p>
        ) : (
          visible.map((comment) => {
            const post = postsById.get(comment.postId);
            const isReplying = replyingTo === comment.id;
            return (
              <div
                key={comment.id}
                className="border-b border-border px-4 py-3 last:border-b-0"
              >
                <div className="flex gap-3">
                  {post?.thumbnailUrl ? (
                    // Instagram CDN URLs are signed and short-lived, so they
                    // bypass next/image optimization.
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={post.thumbnailUrl}
                      alt=""
                      className="h-10 w-10 shrink-0 rounded object-cover"
                    />
                  ) : (
                    <div className="h-10 w-10 shrink-0 rounded bg-surface" />
                  )}
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="text-sm font-medium text-foreground">
                        @{comment.username ?? "unknown"}
                      </span>
                      <span className="text-[11px] text-zinc-500">
                        {formatTime(comment.timestamp)}
                      </span>
                      {comment.answered && (
                        <span className="text-[11px] font-medium text-accent">
                          Answered
                        </span>
                      )}
                      {comment.verifying && (
                        <span className="text-[11px] font-medium text-muted">
                          Checking…
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 whitespace-pre-wrap break-words text-sm text-foreground">
                      {comment.text || "(no text)"}
                    </p>
                    {post && (
                      <p className="mt-0.5 truncate text-xs text-muted">
                        on{" "}
                        {post.permalink ? (
                          <a
                            href={post.permalink}
                            target="_blank"
                            rel="noreferrer"
                            className="underline hover:text-foreground"
                          >
                            {truncate(post.caption, 60) || "this post"}
                          </a>
                        ) : (
                          truncate(post.caption, 60) || "this post"
                        )}
                      </p>
                    )}

                    {comment.replies.length > 0 && (
                      <div className="mt-2 space-y-1 border-l border-border pl-3">
                        {comment.replies.map((reply) => (
                          <p
                            key={reply.id}
                            className="whitespace-pre-wrap break-words text-xs text-foreground"
                          >
                            <span
                              className={`font-medium ${
                                reply.fromMe ? "text-accent" : ""
                              }`}
                            >
                              {/* Meta sends replies without authors, so most
                                  have no username to show. */}
                              {reply.fromMe
                                ? "You"
                                : reply.username
                                  ? `@${reply.username}`
                                  : "Reply"}
                            </span>{" "}
                            {reply.text}
                          </p>
                        ))}
                      </div>
                    )}

                    {data?.canReply && !isReplying && (
                      <button
                        type="button"
                        onClick={() => openReply(comment)}
                        className="mt-2 text-xs font-medium text-accent hover:underline"
                      >
                        Reply
                      </button>
                    )}

                    {data?.canReply && isReplying && (
                      <div className="mt-2">
                        {sendError && (
                          <p className="mb-2 text-xs text-error">{sendError}</p>
                        )}
                        <div className="flex items-end gap-2">
                          <textarea
                            value={draft}
                            onChange={(e) => setDraft(e.target.value)}
                            onKeyDown={(e) => handleKeyDown(e, comment)}
                            rows={2}
                            autoFocus
                            placeholder={`Reply to @${comment.username ?? "unknown"} publicly…`}
                            className="max-h-32 min-h-[40px] flex-1 resize-none rounded-lg border border-border bg-surface px-3 py-2 text-sm text-foreground placeholder:text-zinc-500 focus:border-accent/40 focus:outline-none"
                          />
                          <div className="flex flex-col gap-1">
                            <button
                              type="button"
                              onClick={() => void handleReply(comment)}
                              disabled={sending || !draft.trim()}
                              className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50"
                            >
                              {sending ? "Posting…" : "Post"}
                            </button>
                            <button
                              type="button"
                              onClick={() => setReplyingTo(null)}
                              disabled={sending}
                              className="text-xs text-muted hover:text-foreground"
                            >
                              Cancel
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
