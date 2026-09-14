import { TokenBucket } from "./tokenBucket.js";

// Per-IP connect-attempt limiter: bounds connection/reconnection floods
// against this publicly reachable endpoint (Epic 11 Story 6). 10-token
// burst, refilling at 1/sec — generous for a real client reconnecting a
// few times, not for a scripted flood.
const connectAttempts = new TokenBucket(10, 1);

export function allowConnectionAttempt(ip: string): boolean {
  return connectAttempts.consume(ip);
}

// Per-(user, room) concurrent socket cap. Deliberately NOT a 1:1 mapping
// to the room's participant_cap — one real participant legitimately opens
// several sockets (multiple tabs/devices), so capping total room
// connections at participant_cap would break normal multi-tab use. This
// instead bounds how many concurrent sockets any single user can hold
// open in one room, which is what actually protects against one
// misbehaving client — consistent in spirit with the participant/room
// caps in Epic 08, not a literal reuse of the same number.
export const MAX_SOCKETS_PER_USER_PER_ROOM = 5;

const socketsByUserRoom = new Map<string, Set<string>>();

function key(userId: string, roomId: string): string {
  return `${userId}:${roomId}`;
}

export function tryReserveRoomSlot(
  userId: string,
  roomId: string,
  socketId: string,
): boolean {
  const k = key(userId, roomId);
  const existing = socketsByUserRoom.get(k) ?? new Set<string>();

  if (existing.size >= MAX_SOCKETS_PER_USER_PER_ROOM) {
    return false;
  }

  existing.add(socketId);
  socketsByUserRoom.set(k, existing);
  return true;
}

export function releaseRoomSlot(
  userId: string,
  roomId: string,
  socketId: string,
): void {
  const k = key(userId, roomId);
  const existing = socketsByUserRoom.get(k);
  if (!existing) return;

  existing.delete(socketId);
  if (existing.size === 0) {
    socketsByUserRoom.delete(k);
  }
}

// Used by internalApi.ts's /internal/disconnect to find which live
// sockets belong to a given user in a given room (the kick mechanism —
// Epic 11 Story 3's second AC). Returns a copy so callers can't mutate
// the tracking map directly.
export function getSocketIdsForUserInRoom(
  userId: string,
  roomId: string,
): Set<string> {
  return new Set(socketsByUserRoom.get(key(userId, roomId)) ?? []);
}
