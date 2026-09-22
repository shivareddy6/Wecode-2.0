"use client";

import { useEffect, useRef, useState } from "react";
import { io } from "socket.io-client";
import { createClient } from "@/lib/supabase/client";
import { sendMessage, deleteMessage } from "@/app/rooms/actions";
import { MAX_MESSAGE_LENGTH } from "@/lib/chat/constants";

export type ChatMessageRow = {
  id: string;
  user_id: string;
  display_name: string | null;
  avatar_url: string | null;
  body: string;
  created_at: string;
  kind: "user" | "submission";
  is_out_of_contest: boolean;
};

// Epic 07, Stories 1/2/3/4/5 — room-scoped chat. Same socket pattern as
// LiveLeaderboard/ParticipantList: SSR'd initial history, then a socket
// connection (re-"room:join"ing on every connect, including reconnects)
// replaces/patches state on "chat:message"/"chat:delete" pushes from
// sendMessage/deleteMessage (app/rooms/actions.ts) or, for Story 5, from
// the submission-status route inserting a kind: "submission" row. The
// sender's own message arrives the same way as everyone else's — no optimistic local
// append — since broadcastToRoom's io.to(channel).emit() includes the
// sender's own open socket.
export function Chat({
  roomId,
  initialMessages,
  isHost,
}: {
  roomId: string;
  initialMessages: ChatMessageRow[];
  isHost: boolean;
}) {
  const [messages, setMessages] = useState(initialMessages);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const listEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    let socket: ReturnType<typeof io> | undefined;

    async function connect() {
      const supabase = createClient();
      const { data } = await supabase.auth.getSession();
      const token = data.session?.access_token;
      if (!token || cancelled) return;

      socket = io(process.env.NEXT_PUBLIC_REALTIME_SERVER_URL!, {
        auth: { token },
      });

      socket.on("connect", () => {
        socket?.emit("room:join", { roomId });
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
    <div className="flex flex-col gap-2">
      <h2 className="text-sm font-medium">Chat</h2>
      <div className="flex max-h-64 flex-col gap-1 overflow-y-auto rounded-md border border-black/10 p-2 dark:border-white/15">
        {messages.length === 0 ? (
          <p className="text-sm text-zinc-500">No messages yet.</p>
        ) : (
          messages.map((message) => (
            <div
              key={message.id}
              className={`flex items-start justify-between gap-2 text-sm ${
                message.kind === "submission" ? "italic text-zinc-500 dark:text-zinc-400" : ""
              }`}
            >
              <p className="flex items-start gap-2">
                {message.avatar_url ? (
                  // eslint-disable-next-line @next/next/no-img-element -- avatar URLs are arbitrary LeetCode-hosted images, not project assets next/image can optimize.
                  <img
                    src={message.avatar_url}
                    alt=""
                    className="mt-0.5 h-5 w-5 shrink-0 rounded-full"
                  />
                ) : null}
                <span>
                  {message.kind === "user" ? (
                    <span className="font-medium not-italic">{message.display_name ?? "Anonymous"}: </span>
                  ) : null}
                  {message.body}
                  {message.is_out_of_contest ? (
                    <span className="ml-1 rounded bg-zinc-200 px-1 text-xs not-italic dark:bg-zinc-700">
                      out of contest
                    </span>
                  ) : null}
                </span>
              </p>
              {isHost ? (
                <button
                  type="button"
                  onClick={() => handleDelete(message.id)}
                  className="shrink-0 text-xs text-zinc-500 underline"
                >
                  Delete
                </button>
              ) : null}
            </div>
          ))
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
          className="flex-1 rounded-md border border-black/10 bg-transparent px-2 py-1.5 text-sm dark:border-white/15"
        />
        <button
          type="submit"
          className="rounded-full bg-foreground px-4 py-1.5 text-sm font-medium text-background"
        >
          Send
        </button>
      </form>
      {error ? <p className="text-xs text-red-600 dark:text-red-400">{error}</p> : null}
    </div>
  );
}
