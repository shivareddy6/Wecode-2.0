// Epic 07, Story 4 — must match chat_messages' `char_length(body) <= 2000`
// check constraint (v2_schema migration) exactly, so client/server rejection
// happens before ever hitting that DB constraint. Shared by the client
// component (input maxLength) and the sendMessage server action.
export const MAX_MESSAGE_LENGTH = 2000;
