/**
 * Team chat as Deskzo sends it (src/lib/chat/types.ts on the server — kept in step by hand): times are ISO strings.
 */

export type ChatPerson = { id: string; name: string; photoUpdatedAt: string | null; department: string | null; active: boolean };

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
export type ChatReactionView = { emoji: string; userIds: string[] };

export type ChatPinView = {
  messageId: string;
  pinnedAt: string;
  pinnedByName: string | null;
  senderName: string | null;
  body: string;
  attachmentCount: number;
  createdAt: string;
};

export type ChatMessageView = {
  id: string;
  chatId: string;
  kind: "TEXT" | "SYSTEM";
  senderId: string | null;
  senderName: string | null;
  body: string;
  replyTo: { id: string; senderName: string | null; body: string; deleted: boolean; attachmentCount: number } | null;
  attachments: ChatAttachmentView[];
  mentionIds: string[];
  reactions: ChatReactionView[];
  editedAt: string | null;
  deletedAt: string | null;
  createdAt: string;
};

export type ChatSummary = {
  id: string;
  kind: "DIRECT" | "GROUP";
  title: string;
  otherUserId: string | null;
  otherPhotoUpdatedAt: string | null;
  otherActive: boolean;
  memberCount: number;
  preview: string;
  lastMessageAt: string | null;
  unread: number;
  mentioned: boolean;
  mutedUntil: string | null;
  isAdmin: boolean;
  left: boolean;
};

export type ChatBootstrap = {
  me: { id: string; name: string };
  chats: ChatSummary[];
  people: ChatPerson[];
  departments: { id: string; name: string; memberIds: string[] }[];
  myTeam: string[];
  online: string[];
  lastSeen: Record<string, string>;
  attachmentsViewOnly: boolean;
};

export type OpenedChat = { summary: ChatSummary; members: ChatMemberView[]; messages: ChatMessageView[]; hasMore: boolean; pins: ChatPinView[] };

export type ChatEvent =
  | { type: "ready"; online: string[] }
  | { type: "message"; message: ChatMessageView; muted: boolean; mentioned: boolean; chatTitle?: string | null }
  | { type: "reactions"; chatId: string; messageId: string; reactions: ChatReactionView[] }
  | { type: "pins-changed"; chatId: string }
  | { type: "message-updated"; message: ChatMessageView }
  | { type: "receipt"; chatId: string; userId: string; lastDeliveredAt: string | null; lastReadAt: string | null }
  | { type: "typing"; chatId: string; userId: string; name: string }
  | { type: "presence"; userId: string; online: boolean; lastSeenAt: string | null }
  | { type: "chat-changed"; chatId: string }
  | { type: "unread"; total: number };

/** The six reactions, as on the website (src/lib/chat/rules.ts REACTIONS). */
export const REACTIONS = ["👍", "❤️", "😂", "😮", "😢", "🙏"] as const;
/** Own messages: edited within fifteen minutes, deleted for everyone within the hour (src/lib/chat/rules.ts). */
export const EDIT_WINDOW_MS = 15 * 60_000;
export const DELETE_WINDOW_MS = 60 * 60_000;
export const MAX_FILES_BYTES = 5 * 1024 * 1024;
