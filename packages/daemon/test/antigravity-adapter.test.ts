import { describe, it, expect, vi } from "vitest";
import { AntigravityRuntimeAdapter, type AntigravityAdapterFsOps } from "../src/adapters/antigravity-adapter.js";
import type { NodeBinding, ResolvedStartupFile } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan, ProjectionEntry } from "../src/domain/projection-planner.js";
import type { TmuxAdapter } from "../src/adapters/tmux.js";

function mockTmux(overrides?: Partial<TmuxAdapter>): TmuxAdapter {
  return {
    sendText: vi.fn(async () => ({ ok: true as const })),
    sendShellCommand: vi.fn(async () => ({ ok: true as const })),
    hasSession: vi.fn(async () => true),
    getPaneCommand: vi.fn(async () => "agy"),
    capturePaneContent: vi.fn(async () => "Welcome to Antigravity\nType / for commands"),
    createSession: vi.fn(async () => ({ ok: true as const })),
    killSession: vi.fn(async () => ({ ok: true as const })),
    listSessions: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    listPanes: vi.fn(async () => []),
    sendKeys: vi.fn(async () => ({ ok: true as const })),
    getPanePid: vi.fn(async () => null),
    ...overrides,
  } as unknown as TmuxAdapter;
}

function mockFs(files?: Record<string, string>): AntigravityAdapterFsOps {
  const store: Record<string, string> = { ...files };
  return {
    readFile: (p: string) => {
      if (p in store) return store[p]!;
      throw new Error(`Not found: ${p}`);
    },
    writeFile: (p: string, c: string) => {
      store[p] = c;
    },
    exists: (p: string) => p in store,
    mkdirp: () => {},
    copyFile: (src: string, dest: string) => {
      store[dest] = store[src] ?? "";
    },
    listFiles: (dir: string) =>
      Object.keys(store)
        .filter((k) => k.startsWith(dir + "/"))
        .map((k) => k.slice(dir.length + 1)),
    readdir: (dir: string) =>
      Object.keys(store)
        .filter((k) => k.startsWith(dir + "/"))
        .map((k) => k.slice(dir.length + 1).split("/")[0]!),
    homedir: "/home/user",
    _store: store,
  } as AntigravityAdapterFsOps & { _store: Record<string, string> };
}

const STATE_ROOT = "/state/antigravity";

function makeBinding(cwd = "/project"): NodeBinding {
  return {
    id: "b1",
    nodeId: "n1",
    tmuxSession: "dev-lead@test-rig",
    tmuxWindow: null,
    tmuxPane: null,
    cmuxWorkspace: null,
    cmuxSurface: null,
    updatedAt: "",
    cwd,
  };
}

describe("AntigravityRuntimeAdapter", () => {
  it("declares runtime as 'antigravity'", () => {
    const adapter = new AntigravityRuntimeAdapter({
      tmux: mockTmux(),
      fsOps: mockFs(),
      stateRoot: STATE_ROOT,
    });
    expect(adapter.runtime).toBe("antigravity");
  });

  it("projects guidance into AGENTS.md with managed blocks", async () => {
    const fsOps = mockFs({
      "/guidance/role.md": "You are the lead developer.",
    });
    const adapter = new AntigravityRuntimeAdapter({
      tmux: mockTmux(),
      fsOps,
    });

    const entry: ProjectionEntry = {
      classification: "create",
      category: "guidance",
      effectiveId: "role-guidance",
      absolutePath: "/guidance/role.md",
      mergeStrategy: "managed_block",
    };

    const plan: ProjectionPlan = {
      entries: [entry],
      diagnostics: [],
      conflicts: [],
      noOps: [],
      runtime: "antigravity",
      cwd: "/project",
    };

    const res = await adapter.project(plan, makeBinding("/project"));
    expect(res.projected).toContain("role-guidance");
    expect((fsOps as any)._store["/project/AGENTS.md"]).toContain("BEGIN OpenRig MANAGED BLOCK: role-guidance");
    expect((fsOps as any)._store["/project/AGENTS.md"]).toContain("You are the lead developer.");
  });

  it("projects skills into .agents/skills/<name>", async () => {
    const fsOps = mockFs({
      "/skills/test-skill/SKILL.md": "# Test Skill",
    });
    const adapter = new AntigravityRuntimeAdapter({
      tmux: mockTmux(),
      fsOps,
    });

    const entry: ProjectionEntry = {
      classification: "create",
      category: "skill",
      effectiveId: "test-skill",
      absolutePath: "/skills/test-skill/SKILL.md",
    };

    const plan: ProjectionPlan = {
      entries: [entry],
      diagnostics: [],
      conflicts: [],
      noOps: [],
      runtime: "antigravity",
      cwd: "/project",
    };

    const res = await adapter.project(plan, makeBinding("/project"));
    expect(res.projected).toContain("test-skill");
    expect((fsOps as any)._store["/project/.agents/skills/test-skill/SKILL.md"]).toBe("# Test Skill");
  });

  // ── Launch identity (qualified against agy 1.2.12, 2026-09-28) ────────────
  // Log lines below are verbatim shapes from real agy CLI logs.
  const SEAT = "dev-lead@test-rig";
  const LOG = (id: string) => `${STATE_ROOT}/${SEAT}/launch-${id}.log`;
  const CONV_A = "ddd09ebd-312b-4c3e-88a9-cfec160892c1";
  const CONV_B = "30f10ab2-f812-4489-90bf-14e3592ba98d";
  const READY_PANE = "> Accept-edits mode: file edits auto-approved (shift+tab to cycle)\n? for shortcuts   accept-edits · Gemini 3.8 Flash · low";
  const created = (id: string) => `I0928 08:22:34.770786     598 server.go:1239] Created conversation ${id}\n`;
  const resumed = (id: string) => `I0928 08:23:01.100000     534 common.go:401] Resuming conversation ${id}\n`;
  const missing = (id: string) => `W0928 08:24:03.700000      44 projectresolve.go:63] Conversation ${id} not found, ignoring --conversation flag\n`;
  const rejected = (m: string) => `W0928 08:23:40.000000      12 common.go:335] failed to apply model override: failed to resolve model: model ${m} is not recognized as a known model or custom model in settings\n`;

  function harness(opts: { pane?: string[]; paneCommand?: string[]; log?: (launchId: string) => string | undefined; ids?: string[] } = {}) {
    const fs = mockFs() as AntigravityAdapterFsOps & { _store: Record<string, string> };
    const panes = [...(opts.pane ?? [READY_PANE])];
    const cmds = [...(opts.paneCommand ?? ["agy"])];
    const ids = [...(opts.ids ?? ["L1", "L2", "L3"])];
    let current = "";
    const tmux = mockTmux({
      capturePaneContent: vi.fn(async () => (panes.length > 1 ? panes.shift()! : panes[0]!)),
      getPaneCommand: vi.fn(async () => (cmds.length > 1 ? cmds.shift()! : cmds[0]!)),
    });
    const adapter = new AntigravityRuntimeAdapter({
      tmux,
      fsOps: fs,
      stateRoot: STATE_ROOT,
      sleep: async () => {
        const content = opts.log?.(current);
        if (content !== undefined) fs._store[LOG(current)] = content;
      },
      pollMs: 10,
      maxWaitMs: 100,
      newLaunchId: () => {
        current = ids.shift()!;
        const content = opts.log?.(current);
        if (content !== undefined) fs._store[LOG(current)] = content;
        return current;
      },
    });
    return { adapter, tmux, fs };
  }

  it("launches with bypass flags and a per-launch log file, never the shared brain dir", async () => {
    const { adapter, tmux } = harness();
    const res = await adapter.launchHarness(makeBinding("/project"), { name: "dev-lead" });
    expect(res.ok).toBe(true);
    const cmd = (tmux.sendShellCommand as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(cmd).toContain("agy --dangerously-skip-permissions --mode accept-edits");
    expect(cmd).toContain(`--log-file '${LOG("L1")}'`);
    // A fresh launch has no conversation until the first message.
    expect(res.ok && res.resumeToken).toBeFalsy();
  });

  it("reads each seat's conversation from its own launch log (two seats, two nonces)", async () => {
    const { adapter, fs } = harness({ log: (id) => (id === "L1" ? created(CONV_A) : id === "L2" ? created(CONV_B) : undefined) });
    const other = "dev-builder@other-rig";
    await adapter.launchHarness(makeBinding("/a"), { name: "a" });
    await adapter.launchHarness({ ...makeBinding("/b"), tmuxSession: other }, { name: "b" });
    // L2's log landed under the second seat's directory.
    fs._store[`${STATE_ROOT}/${other}/launch-L2.log`] = created(CONV_B);
    expect(adapter.readConversationId(SEAT)).toBe(CONV_A);
    expect(adapter.readConversationId(other)).toBe(CONV_B);
  });

  it("is null before the first message, even when other conversations exist", async () => {
    const { adapter } = harness({ log: () => "I0928 08:21:59.501390 311 manager.go:932] Full redraw completed (rerenderAll) for conversation  (epoch 0, items 1)\n" });
    await adapter.launchHarness(makeBinding(), { name: "dev-lead" });
    expect(adapter.readConversationId(SEAT)).toBeNull();
  });

  it("binds only the CURRENT launch: a relaunch does not inherit the previous log", async () => {
    const { adapter } = harness({ log: (id) => (id === "L1" ? created(CONV_A) : "") });
    await adapter.launchHarness(makeBinding(), { name: "dev-lead" });
    expect(adapter.readConversationId(SEAT)).toBe(CONV_A);
    await adapter.launchHarness(makeBinding(), { name: "dev-lead" });
    expect(adapter.readConversationId(SEAT)).toBeNull();
  });

  it("resumes only when the log proves the requested conversation", async () => {
    const { adapter, tmux } = harness({ log: () => resumed(CONV_A) });
    const res = await adapter.launchHarness(makeBinding(), { name: "dev-lead", resumeToken: CONV_A });
    expect(res).toMatchObject({ ok: true, resumeToken: CONV_A, resumeType: "antigravity_id" });
    const cmd = (tmux.sendShellCommand as ReturnType<typeof vi.fn>).mock.calls[0]![1] as string;
    expect(cmd).toContain(`--conversation '${CONV_A}'`);
    expect(adapter.readConversationId(SEAT)).toBe(CONV_A);
  });

  it("fails a resume of an unknown conversation instead of accepting agy's silent fresh start", async () => {
    const { adapter, tmux } = harness({ log: () => missing(CONV_B) });
    const res = await adapter.launchHarness(makeBinding(), { name: "dev-lead", resumeToken: CONV_B });
    expect(res).toMatchObject({ ok: false, recovery: "retry_fresh" });
    expect(tmux.sendKeys).toHaveBeenCalledWith(SEAT, ["C-c"]);
  });

  it("never reports a different conversation as the resumed one", async () => {
    const { adapter } = harness({ log: () => resumed(CONV_B) });
    const res = await adapter.launchHarness(makeBinding(), { name: "dev-lead", resumeToken: CONV_A });
    expect(res.ok).toBe(false);
    expect(adapter.readConversationId(SEAT)).toBeNull();
  });

  it("rejects a non-UUID resume token before launching", async () => {
    const { adapter, tmux } = harness();
    const res = await adapter.launchHarness(makeBinding(), { name: "dev-lead", resumeToken: "conv-123-abc" });
    expect(res).toMatchObject({ ok: false, recovery: "retry_fresh" });
    expect(tmux.sendShellCommand).not.toHaveBeenCalled();
  });

  it("fails an invalid model instead of running on agy's fallback model", async () => {
    const { adapter } = harness({ log: () => rejected("no-such-model-x") });
    const res = await adapter.launchHarness({ ...makeBinding(), model: "no-such-model-x" }, { name: "dev-lead" });
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toContain("no-such-model-x");
  });

  it("answers the folder trust dialog once, then waits for the prompt", async () => {
    const trust = "Do you trust the contents of this project?\n> Yes, I trust this folder\n  No, exit";
    const { adapter, tmux } = harness({ pane: [trust, trust, READY_PANE] });
    const res = await adapter.launchHarness(makeBinding(), { name: "dev-lead" });
    expect(res.ok).toBe(true);
    expect((tmux.sendKeys as ReturnType<typeof vi.fn>).mock.calls.filter((c) => c[1][0] === "Enter")).toHaveLength(1);
  });

  it("fails when agy exits during startup", async () => {
    const { adapter } = harness({ pane: ["", "Error: something\n$ "], paneCommand: ["agy", "bash"] });
    const res = await adapter.launchHarness(makeBinding(), { name: "dev-lead" });
    expect(res).toMatchObject({ ok: false, error: "agy exited during startup" });
  });

  it("times out instead of assuming readiness", async () => {
    const { adapter } = harness({ pane: ["loading"] });
    const res = await adapter.launchHarness(makeBinding(), { name: "dev-lead" });
    expect(res).toMatchObject({ ok: false, recovery: "attention_required" });
  });

  it("reports ready only at agy's prompt, not merely because agy is running", async () => {
    const ready = harness({ pane: [READY_PANE] });
    expect((await ready.adapter.checkReady(makeBinding())).ready).toBe(true);
    const starting = harness({ pane: ["loading"] });
    expect((await starting.adapter.checkReady(makeBinding())).ready).toBe(false);
    const trust = harness({ pane: ["Do you trust the contents of this project?"] });
    expect(await trust.adapter.checkReady(makeBinding())).toMatchObject({ ready: false, reason: expect.stringContaining("trust") });
    const shell = harness({ paneCommand: ["bash"] });
    expect((await shell.adapter.checkReady(makeBinding())).ready).toBe(false);
  });
});
