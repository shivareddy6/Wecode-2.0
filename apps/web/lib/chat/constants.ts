// Epic 07, Story 4 — must match chat_messages' `char_length(body) <= 2000`
// check constraint (v2_schema migration) exactly, so client/server rejection
// happens before ever hitting that DB constraint. Shared by the client
// component (input maxLength) and the sendMessage server action.
export const MAX_MESSAGE_LENGTH = 2000;

// Shared by the room page's initial SSR fetch and Chat's reconnect refetch
// (Epic 11, Story 5) so both ever only disagree on *when* they ran, not on
// how much history they ask for.
export const CHAT_HISTORY_LIMIT = 100;
