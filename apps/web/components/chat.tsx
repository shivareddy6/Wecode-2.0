"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { createClient } from "@/lib/supabase/client";
import { sendMessage, deleteMessage } from "@/app/rooms/actions";
import { MAX_MESSAGE_LENGTH, CHAT_HISTORY_LIMIT } from "@/lib/chat/constants";
import { Avatar } from "@/components/avatar";

export type ChatMessageRow = {
  id: string;
  user_id: string;
  display_name: string | null;
  leetcode_username: string;
  avatar_url: string | null;
  body: string;
  created_at: string;
  kind: "user" | "submission";
  is_out_of_contest: boolean;
  problem_title: string | null;
  problem_difficulty: "easy" | "medium" | "hard" | null;
  is_solved: boolean | null;
};

// Consecutive messages from the same sender within this window drop the
// repeated avatar/name/time header — the standard chat-app grouping
// pattern, here so a quick back-and-forth doesn't repeat the same name
// three times in a row.
const GROUP_WINDOW_MS = 5 * 60 * 1000;

const DIFFICULTY_COLOR: Record<string, string> = {
  easy: "text-success",
  medium: "text-warning",
  hard: "text-danger",
};

function formatTime(iso: string): string {
  return new Date(iso).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Epic 07, Stories 1/2/3/4/5 — room-scoped chat. Same socket pattern as
// LiveLeaderboard/ParticipantList: SSR'd initial history, then a socket
// connection (re-"room:join"ing on every connect, including reconnects)
// replaces/patches state on "chat:message"/"chat:delete" pushes from
// sendMessage/deleteMessage (app/rooms/actions.ts) or, for Story 5, from
// the submission-status route inserting a kind: "submission" row. The
// sender's own message arrives the same way as everyone else's — no optimistic local
// append — since broadcastToRoom's io.to(channel).emit() includes the
// sender's own open socket.
//
// Two message grammars, not one: a typed message is a conversation
// bubble (own messages right-aligned, everyone else's left-aligned with
// an avatar), a submission event is a full-width card — so a glance at
// shape alone tells you which kind of entry you're looking at before
// reading a word of it.
export function Chat({
  roomId,
  initialMessages,
  isHost,
  viewerId,
  listClassName = "max-h-64",
}: {
  roomId: string;
  initialMessages: ChatMessageRow[];
  isHost: boolean;
  viewerId: string;
  // Solve workspace's side panel is height-bounded and wants chat to fill
  // it; the room page isn't, so it keeps the original fixed cap.
  listClassName?: string;
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);
  const hasConnectedBefore = useRef(false);

  useEffect(() => {
    let cancelled = false;
    let socket: ReturnType<typeof io> | undefined;
    hasConnectedBefore.current = false;

    async function connect() {
      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token || cancelled) return;

      socket = io(process.env.NEXT_PUBLIC_REALTIME_SERVER_URL!, {
        auth: { token },
      });

      // Epic 11, Story 5 — a reconnect re-fetches the current history
      // directly (same query/limit as the room page's initial SSR fetch)
      // instead of assuming no "chat:message"/"chat:delete" was missed
      // while disconnected.
      socket.on("connect", () => {
        socket?.emit("room:join", { roomId });

        if (hasConnectedBefore.current) {
          void supabase
            .from("chat_messages")
            .select(
              "id, user_id, body, created_at, kind, is_out_of_contest, problem_title, problem_difficulty, is_solved, users(display_name, leetcode_username, avatar_url)",
            )
            .eq("room_id", roomId)
            .is("deleted_at", null)
            .order("created_at", { ascending: false })
            .limit(CHAT_HISTORY_LIMIT)
            .then(({ data: rows }) => {
              if (cancelled || !rows) return;
              setMessages(
                rows
                  .map((row) => {
                    const user = Array.isArray(row.users) ? row.users[0] : row.users;
                    return {
                      id: row.id,
                      user_id: row.user_id,
                      display_name: user?.display_name ?? null,
                      leetcode_username: user?.leetcode_username ?? "",
                      avatar_url: user?.avatar_url ?? null,
                      body: row.body,
                      created_at: row.created_at,
                      kind: row.kind as "user" | "submission",
                      is_out_of_contest: row.is_out_of_contest,
                      problem_title: row.problem_title,
                      problem_difficulty: row.problem_difficulty as "easy" | "medium" | "hard" | null,
                      is_solved: row.is_solved,
                    };
                  })
                  .reverse(),
              );
            });
        }
        hasConnectedBefore.current = true;
      });

      socket.on("chat:message", (message: ChatMessageRow) => {
        setMessages((current) => [...current, message]);
      });

      socket.on("chat:delete", ({ id }: { id: string }) => {
        setMessages((current) => current.filter((message) => message.id !== id));
      });
    }

    void connect();

    return () => {
      cancelled = true;
      socket?.disconnect();
    };
  }, [roomId]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  async function handleSubmit(formEvent: React.FormEvent<HTMLFormElement>) {
    formEvent.preventDefault();
    setError(null);

    const body = draft.trim();
    if (body.length === 0) return;
    if (body.length > MAX_MESSAGE_LENGTH) {
      setError(`Message is too long (max ${MAX_MESSAGE_LENGTH} characters).`);
      return;
    }

    setDraft("");

    const formData = new FormData();
    formData.set("roomId", roomId);
    formData.set("body", body);

    try {
      await sendMessage(formData);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't send that message.");
    }
  }

  async function handleDelete(messageId: string) {
    const formData = new FormData();
    formData.set("roomId", roomId);
    formData.set("messageId", messageId);
    try {
      await deleteMessage(formData);
    } catch {
      // Swallowed — the message stays visible if the delete failed; the
      // host can just try again, same "no dedicated error UI" posture as
      // this codebase's other mutations.
    }
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      <h2 className="text-sm font-medium">Chat</h2>
      <div className={`flex ${listClassName} flex-col gap-2 overflow-y-auto rounded-md border border-border bg-background/40 p-3`}>
        {messages.length === 0 ? (
          <p className="text-sm text-muted">No messages yet — say hi.</p>
        ) : (
          messages.map((message, index) => {
            const previous = messages[index - 1];
            const isGrouped =
              message.kind === "user" &&
              previous?.kind === "user" &&
              previous.user_id === message.user_id &&
              new Date(message.created_at).getTime() - new Date(previous.created_at).getTime() < GROUP_WINDOW_MS;

            if (message.kind === "submission") {
              return (
                <SubmissionCard key={message.id} message={message} canDelete={isHost} onDelete={() => handleDelete(message.id)} />
              );
            }

            return (
              <MessageBubble
                key={message.id}
                message={message}
                isOwn={message.user_id === viewerId}
                showHeader={!isGrouped}
                canDelete={isHost}
                onDelete={() => handleDelete(message.id)}
              />
            );
          })
        )}
        <div ref={listEndRef} />
      </div>
      <form onSubmit={handleSubmit} className="flex gap-2">
        <input
          type="text"
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          maxLength={MAX_MESSAGE_LENGTH}
          placeholder="Say something…"
          className="flex-1 rounded-full border border-border bg-panel-raised px-3.5 py-2 text-sm outline-none focus:border-accent"
        />
        <button
          type="submit"
          disabled={draft.trim().length === 0}
          className="rounded-full bg-accent px-4 py-2 text-sm font-medium text-accent-foreground hover:bg-accent-hover disabled:opacity-40"
        >
          Send
        </button>
      </form>
      {error ? <p className="text-xs text-danger">{error}</p> : null}
    </div>
  );
}

function MessageBubble({
  message,
  isOwn,
  showHeader,
  canDelete,
  onDelete,
}: {
  message: ChatMessageRow;
  isOwn: boolean;
  showHeader: boolean;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const name = message.display_name || message.leetcode_username;

  return (
    <div className={`group flex items-end gap-2 ${isOwn ? "flex-row-reverse" : ""}`}>
      {!isOwn ? (
        <span className={`mb-0.5 shrink-0 ${showHeader ? "" : "invisible"}`} title={name}>
          <Avatar avatarUrl={message.avatar_url} displayName={message.display_name} username={message.leetcode_username} className="h-6 w-6 text-[10px]" />
        </span>
      ) : null}

      <div className={`flex max-w-[80%] flex-col gap-0.5 ${isOwn ? "items-end" : "items-start"}`}>
        {showHeader ? (
          <div className={`flex items-baseline gap-1.5 px-1 text-xs ${isOwn ? "flex-row-reverse" : ""}`}>
            {!isOwn ? <span className="font-medium text-foreground">{name}</span> : null}
            <span className="text-muted" suppressHydrationWarning>
              {formatTime(message.created_at)}
            </span>
          </div>
        ) : null}

        <div className="flex items-center gap-1.5">
          <p
            className={`rounded-2xl px-3.5 py-2 text-sm leading-snug break-words ${
              isOwn ? "rounded-tr-sm bg-accent/20 text-foreground" : "rounded-tl-sm bg-panel-raised text-foreground"
            }`}
          >
            {message.body}
          </p>
          {canDelete ? (
            <button
              type="button"
              onClick={onDelete}
              title="Delete message"
              className="shrink-0 text-xs text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
            >
              ✕
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SubmissionCard({
  message,
  canDelete,
  onDelete,
}: {
  message: ChatMessageRow;
  canDelete: boolean;
  onDelete: () => void;
}) {
  const name = message.display_name || message.leetcode_username;
  const solved = message.is_solved === true;
  const difficultyColor = message.problem_difficulty ? DIFFICULTY_COLOR[message.problem_difficulty] : "text-muted";
  // A row from before this card existed (chat_submission_cards migration)
  // has no problem_title — body already carries the full plain-text
  // summary from the same request that inserted it, so fall back to that
  // rather than rendering a title-shaped hole.
  const hasStructuredData = message.problem_title !== null;

  return (
    <div
      className={`group flex items-start gap-3 rounded-lg border-l-2 bg-panel-raised/60 px-3 py-2 ${
        solved ? "border-l-success" : "border-l-danger"
      }`}
    >
      <span className={`animate-submission-pop mt-0.5 text-base ${solved ? "" : "opacity-80"}`} aria-hidden>
        {solved ? "🎉" : "✗"}
      </span>

      <div className="min-w-0 flex-1">
        {hasStructuredData ? (
          <>
            <p className="text-sm">
              <span className="font-medium text-foreground">{name}</span>{" "}
              <span className="text-muted">{solved ? "solved" : "attempted"}</span>{" "}
              <span className="font-medium text-foreground">{message.problem_title}</span>
            </p>
            <div className="mt-1 flex flex-wrap items-center gap-1.5">
              {message.problem_difficulty ? (
                <span className={`text-xs capitalize ${difficultyColor}`}>{message.problem_difficulty}</span>
              ) : null}
              {message.is_out_of_contest ? (
                <span className="whitespace-nowrap rounded bg-panel px-1.5 py-0.5 text-xs text-muted">out of contest</span>
              ) : null}
            </div>
          </>
        ) : (
          <p className="text-sm text-muted">{message.body}</p>
        )}
      </div>

      <span className="shrink-0 text-xs text-muted" suppressHydrationWarning>
        {formatTime(message.created_at)}
      </span>

      {canDelete ? (
        <button
          type="button"
          onClick={onDelete}
          title="Delete message"
          className="shrink-0 text-xs text-muted opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
        >
          ✕
        </button>
      ) : null}
    </div>
  );
}
