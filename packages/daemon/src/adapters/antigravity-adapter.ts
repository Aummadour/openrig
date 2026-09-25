import nodePath from "node:path";
import os from "node:os";
import fs from "node:fs";
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

const SHELL_COMMANDS = new Set(["bash", "fish", "nu", "sh", "tmux", "zsh"]);

/**
 * Antigravity CLI runtime adapter.
 * Projects resources into .agents/ and merges guidance into AGENTS.md.
 * Launches, resumes, and checks readiness for Google Antigravity (`agy`).
 */
export class AntigravityRuntimeAdapter implements RuntimeAdapter {
  readonly runtime = "antigravity";
  private tmux: TmuxAdapter;
  private fs: AntigravityAdapterFsOps;
  private sleep: (ms: number) => Promise<void>;
  private launchPath?: string;
  private geminiHome: string;

  constructor(deps: {
    tmux: TmuxAdapter;
    fsOps: AntigravityAdapterFsOps;
    sleep?: (ms: number) => Promise<void>;
    launchPath?: string;
    geminiHome?: string;
  }) {
    this.tmux = deps.tmux;
    this.fs = deps.fsOps;
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.launchPath = deps.launchPath;
    this.geminiHome =
      deps.geminiHome ??
      nodePath.join(this.fs.homedir ?? os.homedir(), ".gemini", "antigravity-cli");
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

    const model = binding.model?.trim();
    const modelArg = model ? ` --model ${shellQuote(model)}` : "";
    const postureArg = " --dangerously-skip-permissions --mode accept-edits";

    let cmd: string;
    if (opts.resumeToken) {
      cmd = `agy${postureArg}${modelArg} --conversation ${shellQuote(opts.resumeToken)}`;
    } else {
      cmd = `agy${postureArg}${modelArg}`;
    }

    const fullCmd = this.launchPath ? `env PATH=${shellQuote(this.launchPath)} ${cmd}` : cmd;
    const textResult = await this.tmux.sendShellCommand(binding.tmuxSession, fullCmd);
    if (!textResult.ok) {
      return { ok: false, error: `Failed to send launch command: ${textResult.message}` };
    }

    if (opts.resumeToken) {
      return {
        ok: true,
        resumeToken: opts.resumeToken,
        resumeType: "antigravity_id",
        appliedLaunch: { runtime: "antigravity", axis: "permission", state: "observed", value: "bypassPermissions" },
      };
    }

    // Capture fresh conversation ID
    await this.sleep(1500);
    const conversationId = await this.captureLatestConversationId();
    if (conversationId) {
      return {
        ok: true,
        resumeToken: conversationId,
        resumeType: "antigravity_id",
        appliedLaunch: { runtime: "antigravity", axis: "permission", state: "observed", value: "bypassPermissions" },
      };
    }

    return {
      ok: true,
      appliedLaunch: { runtime: "antigravity", axis: "permission", state: "observed", value: "bypassPermissions" },
    };
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

    if (paneCommand && SHELL_COMMANDS.has(paneCommand)) {
      return { ready: false, reason: "Pane returned to shell instead of running agy" };
    }

    if (paneContent.includes("Welcome to Antigravity") || paneContent.includes("Type / for commands") || paneCommand?.includes("agy")) {
      return { ready: true };
    }

    // Default to ready if process is running and not in shell
    return { ready: true };
  }

  private async captureLatestConversationId(): Promise<string | undefined> {
    try {
      const brainDir = nodePath.join(this.geminiHome, "brain");
      if (!this.fs.exists(brainDir) || !this.fs.readdir) return undefined;
      const entries = this.fs.readdir(brainDir);
      let newestId: string | undefined;
      let newestTime = 0;
      for (const entry of entries) {
        if (entry.startsWith(".")) continue;
        const entryPath = nodePath.join(brainDir, entry);
        if (this.fs.statMode) {
          try {
            const stat = fs.statSync(entryPath);
            if (stat.isDirectory() && stat.mtimeMs > newestTime) {
              newestTime = stat.mtimeMs;
              newestId = entry;
            }
          } catch {
            // Ignore unreadable entries
          }
        }
      }
      return newestId;
    } catch {
      return undefined;
    }
  }
}
