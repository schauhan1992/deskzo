/** A refusal worth telling whoever asked — thrown by the console's libraries; `consoleRefusal` (console-guard.ts) turns it into `{ ok: false }`. */
export class ConsoleRefused extends Error {}
