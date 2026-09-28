// Antigravity (`agy`) launch protocol: seat paths, the launch command, the
// per-launch CLI log parser and the pane classifier.
//
// Observed behavior of agy 1.2.12 (qualified 2026-09-28):
// - A conversation is created on the FIRST user message, not at startup. The
//   CLI log then records `Created conversation <uuid>`.
// - `--conversation <id>` with a known id logs `Resuming conversation <id>`.
//   An unknown id logs `Conversation <id> not found, ignoring --conversation
//   flag` and silently starts a fresh session.
// - An unknown `--model` logs `failed to apply model override` and silently
//   falls back to the default model.
// - An untrusted folder shows a trust dialog even with
//   --dangerously-skip-permissions.
// - agy has no data-dir override; every launch shares
//   ~/.gemini/antigravity-cli, so "newest directory under brain/" cannot
//   identify a launch. Each launch therefore writes its own `--log-file`, and
//   identity is read from that log only.
import nodePath from "node:path";
import { shellQuote } from "./shell-quote.js";

export interface AntigravitySeatPaths {
  seatRoot: string;
  launchStatePath: string;
  logPath(launchId: string): string;
}

export function antigravitySeatPaths(stateRoot: string, sessionName: string): AntigravitySeatPaths {
  const seatRoot = nodePath.join(stateRoot, sessionName);
  return {
    seatRoot,
    launchStatePath: nodePath.join(seatRoot, "launch.json"),
    logPath: (launchId: string) => nodePath.join(seatRoot, `launch-${launchId}.log`),
  };
}

/** The current launch attempt for one seat. Written before the command is sent. */
export interface AntigravityLaunchState {
  launchId: string;
  logFile: string;
  launchedAt: string;
  requestedModel: string | null;
  /** The conversation requested with --conversation, or null for a fresh launch. */
  requestedConversation: string | null;
}

export function parseLaunchState(raw: string): AntigravityLaunchState | null {
  try {
    const v = JSON.parse(raw) as Partial<AntigravityLaunchState>;
    if (typeof v.launchId !== "string" || typeof v.logFile !== "string") return null;
    return {
      launchId: v.launchId,
      logFile: v.logFile,
      launchedAt: typeof v.launchedAt === "string" ? v.launchedAt : "",
      requestedModel: typeof v.requestedModel === "string" ? v.requestedModel : null,
      requestedConversation: typeof v.requestedConversation === "string" ? v.requestedConversation : null,
    };
  } catch {
    return null;
  }
}

export const ANTIGRAVITY_CONVERSATION_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function buildAgyCommand(opts: {
  model?: string | null;
  logFile: string;
  resumeToken?: string | null;
}): string {
  const model = opts.model?.trim();
  const parts = ["agy", "--dangerously-skip-permissions", "--mode", "accept-edits"];
  if (model) parts.push("--model", shellQuote(model));
  parts.push("--log-file", shellQuote(opts.logFile));
  if (opts.resumeToken) parts.push("--conversation", shellQuote(opts.resumeToken));
  return parts.join(" ");
}

export interface AgyLogFacts {
  /** First conversation this launch created (fresh launch, after the first message). */
  created: string | null;
  /** Conversation this launch resumed. */
  resumed: string | null;
  /** Conversation id that agy reported as not found (it then started fresh). */
  missing: string | null;
  /** Model agy refused (it then fell back to its default model). */
  rejectedModel: string | null;
}

const UUID = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const CREATED_RE = new RegExp(`\\] Created conversation (${UUID})`);
const RESUMED_RE = new RegExp(`\\] Resuming conversation (${UUID})`);
const MISSING_RE = new RegExp(`\\] Conversation (\\S+) not found, ignoring --conversation flag`);
const REJECTED_MODEL_RE = /\] failed to apply model override: .*model (\S+) is not recognized/;

export function parseAgyLog(content: string): AgyLogFacts {
  const facts: AgyLogFacts = { created: null, resumed: null, missing: null, rejectedModel: null };
  for (const line of content.split("\n")) {
    if (!facts.created) facts.created = CREATED_RE.exec(line)?.[1] ?? null;
    if (!facts.resumed) facts.resumed = RESUMED_RE.exec(line)?.[1] ?? null;
    if (!facts.missing) facts.missing = MISSING_RE.exec(line)?.[1] ?? null;
    if (!facts.rejectedModel) facts.rejectedModel = REJECTED_MODEL_RE.exec(line)?.[1] ?? null;
  }
  return facts;
}

/** The conversation a launch is bound to, once agy has recorded one. */
export function conversationForLaunch(state: AntigravityLaunchState, facts: AgyLogFacts): string | null {
  if (state.requestedConversation) {
    // A missing requested conversation means agy started fresh; its new id (if
    // any) is NOT the requested identity and must not be reported as a resume.
    if (facts.resumed === state.requestedConversation) return facts.resumed;
    return facts.missing ? facts.created : null;
  }
  return facts.created;
}

export type AgyPaneState =
  | { kind: "trust_prompt" }
  | { kind: "ready" }
  | { kind: "shell" }
  | { kind: "starting" };

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh", "dash"]);

export function classifyAgyPane(paneContent: string, paneCommand: string | null): AgyPaneState {
  if (paneCommand && SHELL_COMMANDS.has(paneCommand)) return { kind: "shell" };
  if (paneContent.includes("Do you trust the contents of this project?")) return { kind: "trust_prompt" };
  if (paneContent.includes("? for shortcuts") || paneContent.includes("Accept-edits mode:")) return { kind: "ready" };
  return { kind: "starting" };
}
