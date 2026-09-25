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

  it("launches harness with autonomous permission flags", async () => {
    const tmux = mockTmux();
    const adapter = new AntigravityRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
      sleep: async () => {},
    });

    const res = await adapter.launchHarness(makeBinding("/project"), { name: "dev-lead" });
    expect(res.ok).toBe(true);
    expect(tmux.sendShellCommand).toHaveBeenCalledWith(
      "dev-lead@test-rig",
      expect.stringContaining("agy --dangerously-skip-permissions --mode accept-edits"),
    );
  });

  it("launches harness with conversation resumption when resumeToken provided", async () => {
    const tmux = mockTmux();
    const adapter = new AntigravityRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
    });

    const res = await adapter.launchHarness(makeBinding("/project"), {
      name: "dev-lead",
      resumeToken: "conv-123-abc",
    });
    expect(res.ok).toBe(true);
    expect(res.resumeToken).toBe("conv-123-abc");
    expect(tmux.sendShellCommand).toHaveBeenCalledWith(
      "dev-lead@test-rig",
      expect.stringContaining("--conversation 'conv-123-abc'"),
    );
  });

  it("checks readiness based on pane content and command", async () => {
    const tmux = mockTmux({
      getPaneCommand: vi.fn(async () => "agy"),
      capturePaneContent: vi.fn(async () => "Welcome to Antigravity\nType / for commands"),
    });
    const adapter = new AntigravityRuntimeAdapter({
      tmux,
      fsOps: mockFs(),
    });

    const res = await adapter.checkReady(makeBinding());
    expect(res.ready).toBe(true);
  });
});
