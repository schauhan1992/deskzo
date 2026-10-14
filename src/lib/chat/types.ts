/**
 * What the chat's server hands the browser, as plain JSON: times are ISO strings, nothing is a Prisma
 * row. Shared by src/actions/chat.ts, the live stream (src/app/api/chat/stream) and the chat's
 * components.
 */

export type ChatPerson = {
  id: string;
  name: string;
  photoUpdatedAt: string | null;
  /** Their department's name, to tell two Priyas apart in a picker. */
  department: string | null;
  /** Switched off: their chats stay readable, nothing new can be sent to them. */
  active: boolean;
};

export type ChatMemberView = {
  userId: string;
  name: string;
  photoUpdatedAt: string | null;
  isAdmin: boolean;
  joinedAt: string;
  leftAt: string | null;
  lastDeliveredAt: string | null;
  lastReadAt: string | null;
};

export type ChatAttachmentView = { id: string; fileName: string; mimeType: string; size: number };

export type ChatMessageView = {
  id: string;
  chatId: string;
  kind: "TEXT" | "SYSTEM";
  senderId: string | null;
  senderName: string | null;
  /** Empty once deleted for everyone. */
  body: string;
  replyTo: { id: string; senderName: string | null; body: string; deleted: boolean; attachmentCount: number } | null;
  attachments: ChatAttachmentView[];
  mentionIds: string[];
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
};

/** One row of a person's chat list. */
export type ChatSummary = {
  id: string;
  kind: "DIRECT" | "GROUP";
  /** The group's name, or the other person's. */
  title: string;
  /** A direct chat's other person — their face and their presence. */
  otherUserId: string | null;
  otherPhotoUpdatedAt: string | null;
  otherActive: boolean;
  memberCount: number;
  preview: string;
  lastMessageAt: string | null;
  unread: number;
  /** An unread message @mentions me. */
  mentioned: boolean;
  mutedUntil: string | null;
  isAdmin: boolean;
  /** I have left, or was removed: readable, nothing more. */
  left: boolean;
};

/** Everything the live stream sends, to the people it concerns. */
export type ChatEvent =
  | { type: "ready"; online: string[] }
  /** A new message. `muted`/`mentioned` are the recipient's own, so each is sent per person. */
  | { type: "message"; message: ChatMessageView; muted: boolean; mentioned: boolean }
  /** Edited, or deleted for everyone. */
  | { type: "message-updated"; message: ChatMessageView }
  /** Someone's reading position in a chat moved. */
  | { type: "receipt"; chatId: string; userId: string; lastDeliveredAt: string | null; lastReadAt: string | null }
  | { type: "typing"; chatId: string; userId: string; name: string }
  | { type: "presence"; userId: string; online: boolean; lastSeenAt: string | null }
  /** A chat's name or members changed, or it was created — reload its row. */
  | { type: "chat-changed"; chatId: string }
  /** My unread count, after something read elsewhere (another tab, the rail). */
  | { type: "unread"; total: number };
