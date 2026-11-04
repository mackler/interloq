// The page's notices (issue #13). Pure, imported by the browser. A notice is a condition of the connection, which ends
// when the next connection's hello arrives, or a message for the developer, which stays until he dismisses it. The kind
// is data: nothing compares a notice's text to decide its kind or its end, so rewording a text in src/prompts.ts
// changes no notice's lifetime, and a message that quotes the developer's own text is never taken for a condition.
import { FELL_BEHIND_NOTICE, protocolErrorNotice, SERVER_CLOSED_NOTICE } from "../../src/prompts.ts";

/** A condition of the connection, which ends when the next connection's hello arrives (requirements 1, 2). */
export type ConnectionCondition =
  | Readonly<{ _tag: "ServerClosed" }> // a `closing` frame
  | Readonly<{ _tag: "FellBehind" }> // the server's `behind` frame
  | Readonly<{ _tag: "Unreadable"; reason: string }>; // a frame the page could not read (decision Q1)

/** What a notice is: a condition of the connection, or a message for the developer, which stays until he dismisses it. */
export type NoticeKind =
  | Readonly<{ _tag: "Connection"; condition: ConnectionCondition }>
  | Readonly<{ _tag: "Message"; text: string }>;

/** A notice's identity, allocated by `added`, unique within one page's life and never reused. */
export type NoticeId = number;
export type Notice = Readonly<{ id: NoticeId; kind: NoticeKind }>;
/** The notices the view holds, in arrival order, with the next id to allocate. */
export type Notices = Readonly<{ next: NoticeId; held: readonly Notice[] }>;
export const EMPTY_NOTICES: Notices = { next: 1, held: [] };

/** The rule that ends each kind, an exhaustive switch, so a new kind cannot be added without one. */
export const endsAt = (kind: NoticeKind): "hello" | "dismissal" => {
  switch (kind._tag) {
    case "Connection":
      return "hello";
    case "Message":
      return "dismissal";
  }
};

/** A connection notice's words, derived from its condition. */
export const connectionText = (condition: ConnectionCondition): string => {
  switch (condition._tag) {
    case "ServerClosed":
      return SERVER_CLOSED_NOTICE;
    case "FellBehind":
      return FELL_BEHIND_NOTICE;
    case "Unreadable":
      return protocolErrorNotice(condition.reason);
  }
};

/** Whether a held notice is a connection notice of the given condition's tag. */
const sameCondition = (notice: Notice, condition: ConnectionCondition): boolean => notice.kind._tag === "Connection" && notice.kind.condition._tag === condition._tag;

/**
 * The notices with one more, given the next id. A connection condition replaces its earlier notice of the same tag, so
 * repeated `closing` frames or a run of unreadable frames never stack copies; messages are never deduplicated.
 */
export const added = (notices: Notices, kind: NoticeKind): Notices => {
  const kept = kind._tag === "Connection" ? notices.held.filter((n) => !sameCondition(n, kind.condition)) : notices.held;
  return { next: notices.next + 1, held: [...kept, { id: notices.next, kind }] };
};

/** The notices a connection's hello leaves: those that end at dismissal, ids, order and the next id unchanged. */
export const afterHello = (notices: Notices): Notices => ({ ...notices, held: notices.held.filter((n) => endsAt(n.kind) === "dismissal") });

/** The notices without the message of that id; an unknown id or a connection notice's id changes nothing. */
export const dismissed = (notices: Notices, id: NoticeId): Notices =>
  notices.held.some((n) => n.id === id && endsAt(n.kind) === "dismissal") ? { ...notices, held: notices.held.filter((n) => n.id !== id) } : notices;

/** The connection notices held, in arrival order. */
export const connectionNotices = (notices: Notices): readonly Notice[] => notices.held.filter((n) => n.kind._tag === "Connection");

/** The messages held, in arrival order. */
export const messages = (notices: Notices): readonly Notice[] => notices.held.filter((n) => n.kind._tag === "Message");
