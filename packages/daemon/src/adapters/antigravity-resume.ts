// Restore-path resume for Antigravity seats. Delegates to the runtime
// adapter's launch, which proves the requested conversation from the launch's
// own log. A conversation agy no longer knows maps to retry_fresh, which the
// restore orchestrator turns into a stop-and-ask, never a silent fresh start.
import type { ResumeResult } from "./claude-resume.js";
import type { AntigravityRuntimeAdapter } from "./antigravity-adapter.js";

export { type ResumeResult };

export class AntigravityResumeAdapter {
  constructor(private adapter: Pick<AntigravityRuntimeAdapter, "launchHarness">) {}

  canResume(resumeType: string | null, resumeToken: string | null): boolean {
    return resumeType === "antigravity_id" && !!resumeToken;
  }

  async resume(
    tmuxSessionName: string,
    resumeType: string | null,
    resumeToken: string | null,
    cwd: string,
    model?: string | null,
  ): Promise<ResumeResult> {
    if (!this.canResume(resumeType, resumeToken)) {
      return { ok: false, code: "no_resume", message: "Antigravity resume not available" };
    }
    const result = await this.adapter.launchHarness(
      { tmuxSession: tmuxSessionName, cwd, model: model ?? undefined } as Parameters<AntigravityRuntimeAdapter["launchHarness"]>[0],
      { name: tmuxSessionName, resumeToken: resumeToken! },
    );
    if (result.ok) return { ok: true, appliedLaunch: result.appliedLaunch };
    if (result.recovery === "retry_fresh") return { ok: false, code: "retry_fresh", message: `Antigravity resume failed: ${result.error}` };
    if (result.recovery === "attention_required") {
      return { ok: false, code: "attention_required", message: `Antigravity resume failed: ${result.error}`, evidence: result.evidence };
    }
    return { ok: false, code: "resume_failed", message: `Antigravity resume failed: ${result.error}` };
  }
}
