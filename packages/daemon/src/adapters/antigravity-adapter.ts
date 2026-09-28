import nodePath from "node:path";
import { randomUUID } from "node:crypto";
import type { TmuxAdapter } from "./tmux.js";
import type {
  RuntimeAdapter,
  NodeBinding,
  ResolvedStartupFile,
  InstalledResource,
  ProjectionResult,
  StartupDeliveryResult,
  ReadinessResult,
  HarnessLaunchResult,
  ForkSource,
} from "../domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../domain/projection-planner.js";
import { shellQuote } from "./shell-quote.js";
import { mergeManagedBlock } from "../domain/managed-blocks.js";
import {
  ANTIGRAVITY_CONVERSATION_ID_RE,
  antigravitySeatPaths,
  buildAgyCommand,
  classifyAgyPane,
  conversationForLaunch,
  parseAgyLog,
  parseLaunchState,
  type AntigravityLaunchState,
} from "./antigravity-protocol.js";

export interface AntigravityAdapterFsOps {
  readFile(path: string): string;
  writeFile(path: string, content: string): void;
  exists(path: string): boolean;
  mkdirp(path: string): void;
  copyFile(src: string, dest: string): void;
  listFiles?(dirPath: string): string[];
  statMode?(path: string): number;
  chmod?(path: string, mode: number): void;
  readdir?(dirPath: string): string[];
  homedir?: string;
}

/**
 * Antigravity CLI runtime adapter.
 * Projects resources into .agents/ and merges guidance into AGENTS.md.
 * Launches, resumes, and checks readiness for Google Antigravity (`agy`).
 * Conversation identity comes from each launch's own --log-file (see
 * antigravity-protocol.ts), never from the shared ~/.gemini data directory.
 */
export class AntigravityRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "antigravity";
  private tmux: TmuxAdapter;
  private fs: AntigravityAdapterFsOps;
  private sleep: (ms: number) => Promise<void>;
  private launchPath?: string;
  private stateRoot: string;
  private newLaunchId: () => string;
  private pollMs: number;
  private maxWaitMs: number;

  constructor(deps: {
    tmux: TmuxAdapter;
    fsOps: AntigravityAdapterFsOps;
    sleep?: (ms: number) => Promise<void>;
    launchPath?: string;
    /** Seat state root: <OPENRIG_HOME>/state/antigravity. */
    stateRoot: string;
    newLaunchId?: () => string;
    pollMs?: number;
    maxWaitMs?: number;
  }) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.launchPath = deps.launchPath;
    this.stateRoot = deps.stateRoot;
    this.newLaunchId = deps.newLaunchId ?? (() => randomUUID());
    this.pollMs = deps.pollMs ?? 500;
    this.maxWaitMs = deps.maxWaitMs ?? 30_000;
  }

  async listInstalled(binding: NodeBinding): Promise<InstalledResource[]> {
    const results: InstalledResource[] = [];
    const skillsDir = nodePath.join(binding.cwd, ".agents", "skills");
    if (this.fs.exists(skillsDir) && this.fs.listFiles) {
      for (const file of this.fs.listFiles(skillsDir)) {
        results.push({
          effectiveId: file,
          category: "skill",
          installedPath: nodePath.join(skillsDir, file),
        });
      }
    }
    return results;
  }

  async project(plan: ProjectionPlan, binding: NodeBinding): Promise<ProjectionResult> {
    const projected: string[] = [];
    const skipped: string[] = [];
    const failed: Array<{ effectiveId: string; error: string }> = [];

    for (const entry of plan.entries) {
      if (entry.classification === "no_op") {
        skipped.push(entry.effectiveId);
        continue;
      }

      try {
        const didProject = this.projectEntry(entry, binding.cwd);
        if (didProject) {
          projected.push(entry.effectiveId);
        } else {
          skipped.push(entry.effectiveId);
        }
      } catch (err) {
        failed.push({ effectiveId: entry.effectiveId, error: (err as Error).message });
      }
    }

    return { projected, skipped, failed };
  }

  private projectEntry(entry: ProjectionEntry, cwd: string): boolean {
    if (entry.category === "guidance" && entry.mergeStrategy === "managed_block") {
      const targetPath = nodePath.join(cwd, "AGENTS.md");
      const content = this.fs.readFile(entry.absolutePath);
      mergeManagedBlock(this.fs, targetPath, entry.effectiveId, content);
      return true;
    }

    const targetDir = this.resolveTargetDir(entry, cwd);
    if (!targetDir) return true;

    this.fs.mkdirp(targetDir);
    const isDir = this.fs.listFiles ? this.fs.listFiles(entry.absolutePath).length > 0 : false;

    if (isDir && this.fs.listFiles) {
      for (const rel of this.fs.listFiles(entry.absolutePath)) {
        const src = nodePath.join(entry.absolutePath, rel);
        const dest = nodePath.join(targetDir, rel);
        this.fs.mkdirp(nodePath.dirname(dest));
        this.fs.copyFile(src, dest);
        if (this.fs.statMode && this.fs.chmod) {
          const mode = this.fs.statMode(src);
          this.fs.chmod(dest, mode);
        }
      }
    } else {
      const fileName = nodePath.basename(entry.absolutePath);
      const dest = nodePath.join(targetDir, fileName);
      this.fs.copyFile(entry.absolutePath, dest);
      if (this.fs.statMode && this.fs.chmod) {
        const mode = this.fs.statMode(entry.absolutePath);
        this.fs.chmod(dest, mode);
      }
    }
    return true;
  }

  private resolveTargetDir(entry: ProjectionEntry, cwd: string): string | null {
    if (entry.category === "skill") {
      return nodePath.join(cwd, ".agents", "skills", entry.effectiveId);
    }
    if (entry.category === "subagent") {
      return nodePath.join(cwd, ".agents", "subagents");
    }
    return null;
  }

  async deliverStartup(
    files: ResolvedStartupFile[],
    binding: NodeBinding,
  ): Promise<StartupDeliveryResult> {
    let delivered = 0;
    const failed: Array<{ path: string; error: string }> = [];

    for (const file of files) {
      try {
        const content = this.fs.readFile(file.absolutePath);
        if (file.deliveryHint === "guidance_merge" || file.path.endsWith("AGENTS.md")) {
          const targetPath = nodePath.join(binding.cwd, "AGENTS.md");
          mergeManagedBlock(this.fs, targetPath, file.path, content);
        } else {
          const dest = nodePath.isAbsolute(file.path)
            ? file.path
            : nodePath.join(binding.cwd, file.path);
          this.fs.mkdirp(nodePath.dirname(dest));
          this.fs.writeFile(dest, content);
        }
        delivered++;
      } catch (err) {
        failed.push({ path: file.path, error: (err as Error).message });
      }
    }

    return { delivered, failed };
  }

  async launchHarness(
    binding: NodeBinding,
    opts: { name: string; resumeToken?: string; forkSource?: ForkSource },
  ): Promise<HarnessLaunchResult> {
    if (!binding.tmuxSession) {
      return { ok: false, error: "No tmux session bound — cannot launch Antigravity harness" };
    }

    if (opts.resumeToken && opts.forkSource) {
      return { ok: false, error: "resumeToken and forkSource are mutually exclusive — pick one" };
    }
    if (opts.resumeToken && !ANTIGRAVITY_CONVERSATION_ID_RE.test(opts.resumeToken)) {
      return { ok: false, error: "Antigravity resume token is not a conversation id", recovery: "retry_fresh" };
    }

    const seat = antigravitySeatPaths(this.stateRoot, binding.tmuxSession);
    this.fs.mkdirp(seat.seatRoot);
    const launchId = this.newLaunchId();
    const state: AntigravityLaunchState = {
      launchId,
      logFile: seat.logPath(launchId),
      launchedAt: new Date().toISOString(),
      requestedModel: binding.model?.trim() || null,
      requestedConversation: opts.resumeToken ?? null,
    };
    this.fs.writeFile(seat.launchStatePath, JSON.stringify(state));

    const cmd = buildAgyCommand({ model: binding.model, logFile: state.logFile, resumeToken: opts.resumeToken });
    const fullCmd = this.launchPath ? `env PATH=${shellQuote(this.launchPath)} ${cmd}` : cmd;
    const textResult = await this.tmux.sendShellCommand(binding.tmuxSession, fullCmd);
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }

    return this.waitForLaunch(binding.tmuxSession, state);
  }

  /**
   * Wait until this launch is interactive and its identity is proven from its
   * own log. A fresh launch has no conversation until the first message; its
   * id is read later by readConversationId().
   */
  private async waitForLaunch(session: string, state: AntigravityLaunchState): Promise<HarnessLaunchResult> {
    const appliedLaunch = { runtime: "antigravity", axis: "permission", state: "observed", value: "bypassPermissions" } as const;
    const attempts = Math.max(1, Math.ceil(this.maxWaitMs / this.pollMs));
    let trustAnswered = false;
    let sawAgy = false;
    let lastPane = "";
    // Before the launch script runs, the pane still shows the interactive shell.
    const shellGraceAttempts = Math.ceil(10_000 / this.pollMs);

    for (let attempt = 0; attempt < attempts; attempt++) {
      const facts = this.readLogFacts(state.logFile);
      if (facts.rejectedModel) {
        await this.stopAgy(session);
        return {
          ok: false,
          error: `agy rejected model ${facts.rejectedModel}; it would silently fall back to its default model`,
          recovery: "attention_required",
        };
      }
      if (state.requestedConversation && facts.missing) {
        await this.stopAgy(session);
        return {
          ok: false,
          error: "Antigravity conversation not found; agy would silently start a fresh conversation",
          recovery: "retry_fresh",
        };
      }

      const paneCommand = await this.tmux.getPaneCommand(session);
      lastPane = (await this.tmux.capturePaneContent(session, 40)) ?? "";
      const pane = classifyAgyPane(lastPane, paneCommand);
      if (pane.kind !== "shell") sawAgy = true;
      if (pane.kind === "shell" && (sawAgy || attempt >= shellGraceAttempts)) {
        return {
          ok: false,
          error: sawAgy ? "agy exited during startup" : "agy did not start",
          recovery: "attention_required",
          evidence: lastPane.split("\n").slice(-12).join("\n"),
        };
      }
      if (pane.kind === "trust_prompt" && !trustAnswered) {
        // The seat already runs with --dangerously-skip-permissions; the folder
        // trust dialog is agy's own record of that choice (first option = trust).
        await this.tmux.sendKeys(session, ["Enter"]);
        trustAnswered = true;
      } else if (pane.kind === "ready" && (!state.requestedModel || facts.appliedModelLabel)) {
        if (!state.requestedConversation) return { ok: true, appliedLaunch };
        if (facts.resumed === state.requestedConversation) {
          return { ok: true, resumeToken: facts.resumed, resumeType: "antigravity_id", appliedLaunch };
        }
      }
      if (attempt < attempts - 1) await this.sleep(this.pollMs);
    }

    return {
      ok: false,
      error: state.requestedConversation
        ? "timed out waiting for agy to confirm the requested conversation"
        : "timed out waiting for agy to become interactive",
      recovery: "attention_required",
      evidence: lastPane.split("\n").slice(-12).join("\n"),
    };
  }

  /**
   * The conversation bound to the seat's CURRENT launch, read from that
   * launch's own log. Null until agy records one (fresh launches: after the
   * first message).
   */
  readConversationId(sessionName: string): string | null {
    const seat = antigravitySeatPaths(this.stateRoot, sessionName);
    if (!this.fs.exists(seat.launchStatePath)) return null;
    let state: AntigravityLaunchState | null;
    try {
      state = parseLaunchState(this.fs.readFile(seat.launchStatePath));
    } catch {
      return null;
    }
    if (!state) return null;
    return conversationForLaunch(state, this.readLogFacts(state.logFile));
  }

  private readLogFacts(logFile: string) {
    if (!this.fs.exists(logFile)) return parseAgyLog("");
    try {
      return parseAgyLog(this.fs.readFile(logFile));
    } catch {
      return parseAgyLog("");
    }
  }

  private async stopAgy(session: string): Promise<void> {
    await this.tmux.sendKeys(session, ["C-c"]);
    await this.sleep(this.pollMs);
    await this.tmux.sendKeys(session, ["C-c"]);
  }

  async checkReady(binding: NodeBinding): Promise<ReadinessResult> {
    if (!binding.tmuxSession) {
      return { ready: false, reason: "No tmux session bound" };
    }
    const alive = await this.tmux.hasSession(binding.tmuxSession);
    if (!alive) {
      return { ready: false, reason: "tmux session not responsive" };
    }

    const paneCommand = await this.tmux.getPaneCommand(binding.tmuxSession);
    const paneContent = (await this.tmux.capturePaneContent(binding.tmuxSession, 40)) ?? "";
    const pane = classifyAgyPane(paneContent, paneCommand);
    if (pane.kind === "ready") return { ready: true };
    if (pane.kind === "shell") return { ready: false, reason: "Pane returned to shell instead of running agy" };
    if (pane.kind === "trust_prompt") return { ready: false, reason: "agy is waiting at its folder trust dialog" };
    return { ready: false, reason: "agy has not shown its prompt yet" };
  }
}
