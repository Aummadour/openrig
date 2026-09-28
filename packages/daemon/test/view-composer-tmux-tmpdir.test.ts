import { describe, it, expect } from "vitest";
import { composeView } from "../src/domain/terminal/view-composer.js";

const member = { seat: "advisor-lead@kernel", label: "advisor-lead", tmuxSession: "advisor-lead@kernel", alive: true, readOnly: false, host: null };

describe("local attach and a non-default tmux server", () => {
  it("carries the daemon's TMUX_TMPDIR so a provider pane reaches the seat's server", () => {
    const view = composeView("kernel", [member] as never, { resolveHost: () => null, tmuxTmpdir: "/srv/rig tmux" });
    expect(view.opened[0]!.paneCommand).toBe("env TMUX_TMPDIR='/srv/rig tmux' tmux attach -t 'advisor-lead@kernel'");
  });

  it("is unchanged on the default server", () => {
    const view = composeView("kernel", [member] as never, { resolveHost: () => null });
    expect(view.opened[0]!.paneCommand).toBe("tmux attach -t 'advisor-lead@kernel'");
  });
});
