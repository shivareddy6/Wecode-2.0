import type { Socket } from "socket.io";
import { TokenBucket } from "./tokenBucket.js";

// Generic per-socket rate limit for inbound client events. 20-event
// burst, refilling at 5/sec — comfortable for room:join (once per
// connection) and future chat message sends alike, without any
// per-event-type tuning needed later.
const eventBuckets = new TokenBucket(20, 5);

// Wraps a socket event handler so it's rate-limited per-socket. Any
// future inbound event (e.g. chat's message:send) can reuse this
// unchanged rather than each handler reinventing its own limiter.
export function rateLimited<Args extends unknown[]>(
  socket: Socket,
  handler: (...args: Args) => void | Promise<void>,
): (...args: Args) => void {
  return (...args: Args) => {
    if (!eventBuckets.consume(socket.id)) {
      return;
    }
    void handler(...args);
  };
}

export function clearEventRateLimit(socket: Socket): void {
  eventBuckets.delete(socket.id);
}
