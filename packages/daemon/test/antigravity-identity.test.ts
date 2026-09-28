// Antigravity identity wiring: resume-token validation, capture, metadata
// refresh, restore resume, discovery and the native resume probe.
import { describe, it, expect, vi } from "vitest";
import { validateResumeToken, resumeTypeForRuntime } from "../src/domain/resume-token-validation.js";
import { deriveResumeToken } from "../src/domain/resume-token-capture.js";
import { AntigravityResumeAdapter } from "../src/adapters/antigravity-resume.js";
import { SessionFingerprinter } from "../src/domain/session-fingerprinter.js";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";
import { ResumeMetadataRefresher } from "../src/domain/resume-metadata-refresher.js";
import type { CmuxAdapter } from "../src/adapters/cmux.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

const CONV = "ddd09ebd-312b-4c3e-88a9-cfec160892c1";

describe("antigravity resume tokens", () => {
  it("has its own resume type", () => {
    expect(resumeTypeForRuntime("antigravity")).toBe("antigravity_id");
  });

  it("accepts a conversation UUID and rejects anything else", () => {
    expect(validateResumeToken("antigravity", CONV)).toEqual({ ok: true, resumeType: "antigravity_id", token: CONV });
    for (const bad of ["conv-123", CONV.toUpperCase(), `${CONV}x`, "../etc", ""]) {
      expect(validateResumeToken("antigravity", bad).ok).toBe(false);
    }
  });

  it("captures the conversation from the seat's launch log", async () => {
    const reader = { readConversationId: vi.fn(() => CONV) };
    await expect(deriveResumeToken({ runtime: "antigravity", sessionName: "s" }, { antigravityConversationReader: reader }))
      .resolves.toEqual({ outcome: "captured", resumeType: "antigravity_id", token: CONV });
  });

  it("skips capture before the first message", async () => {
    const reader = { readConversationId: () => null };
    await expect(deriveResumeToken({ runtime: "antigravity", sessionName: "s" }, { antigravityConversationReader: reader }))
      .resolves.toEqual({ outcome: "skipped", reason: "missing_sidecar" });
  });

  it("is a no-op without a reader (older wiring)", async () => {
    await expect(deriveResumeToken({ runtime: "antigravity", sessionName: "s" }, {})).resolves.toEqual({ outcome: "noop" });
  });
});

describe("metadata refresh", () => {
  it("fills a null antigravity token once agy records a conversation, and never clobbers one", async () => {
    const updateResumeToken = vi.fn();
    const refresher = new ResumeMetadataRefresher({
      sessionRegistry: { updateResumeToken } as never,
      tmuxAdapter: {} as TmuxAdapter,
      antigravityConversationReader: { readConversationId: () => CONV },
    });
    await refresher.refresh([
      { sessionId: "a", sessionName: "a@r", runtime: "antigravity", resumeType: null, resumeToken: null },
      { sessionId: "b", sessionName: "b@r", runtime: "antigravity", resumeType: "antigravity_id", resumeToken: "30f10ab2-f812-4489-90bf-14e3592ba98d" },
    ] as never, { fillNullOnly: true });
    expect(updateResumeToken).toHaveBeenCalledTimes(1);
    expect(updateResumeToken).toHaveBeenCalledWith("a", "antigravity_id", CONV, "scrape");
  });
});

describe("restore resume", () => {
  const launcher = (result: unknown) => ({ launchHarness: vi.fn(async () => result) });

  it("resumes through the log-proven launch", async () => {
    const l = launcher({ ok: true, resumeToken: CONV, resumeType: "antigravity_id" });
    const res = await new AntigravityResumeAdapter(l as never).resume("s@r", "antigravity_id", CONV, "/w", "gemini-3.8-flash-low");
    expect(res.ok).toBe(true);
    expect(l.launchHarness).toHaveBeenCalledWith(
      expect.objectContaining({ tmuxSession: "s@r", cwd: "/w", model: "gemini-3.8-flash-low" }),
      { name: "s@r", resumeToken: CONV },
    );
  });

  it("maps a vanished conversation to retry_fresh (stop and ask), not a silent fresh start", async () => {
    const res = await new AntigravityResumeAdapter(launcher({ ok: false, error: "not found", recovery: "retry_fresh" }) as never)
      .resume("s@r", "antigravity_id", CONV, "/w");
    expect(res).toMatchObject({ ok: false, code: "retry_fresh" });
  });

  it("only claims antigravity tokens", () => {
    const a = new AntigravityResumeAdapter(launcher({ ok: true }) as never);
    expect(a.canResume("antigravity_id", CONV)).toBe(true);
    expect(a.canResume("claude_id", CONV)).toBe(false);
    expect(a.canResume("antigravity_id", null)).toBe(false);
  });
});

describe("discovery and probe", () => {
  it("fingerprints an agy pane as antigravity", async () => {
    const fp = new SessionFingerprinter({
      cmuxAdapter: { isAvailable: () => false, queryAgentPIDs: vi.fn(async () => ({ ok: false, code: "unavailable", message: "none" })) } as unknown as CmuxAdapter,
      tmuxAdapter: { capturePaneContent: vi.fn(async () => null) } as unknown as TmuxAdapter,
      fsExists: () => false,
    });
    const result = await fp.fingerprint({ tmuxSession: "s", tmuxWindow: "0", tmuxPane: "%0", pid: 1, cwd: "/tmp", activeCommand: "agy" });
    expect(result.runtimeHint).toBe("antigravity");
  });

  it("does not treat a running agy pane as proof of the requested conversation", () => {
    const res = assessNativeResumeProbe({ runtime: "antigravity", paneCommand: "agy", paneContent: "? for shortcuts" });
    expect(res.status).toBe("inconclusive");
  });
});
