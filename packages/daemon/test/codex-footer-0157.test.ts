import { describe, it, expect } from "vitest";
import { assessNativeResumeProbe } from "../src/domain/native-resume-probe.js";

// codex-cli 0.157.1 after `codex resume`: the header has scrolled away and the
// footer names the model in upper case.
const RESUMED_0157 = [
  "• Ran echo SHELL-CX-5K2",
  "  └ SHELL-CX-5K2",
  "• SHELL-CX-5K2; SKILL-TOKEN-Q7R2; NONCE-CX-8H3",
  "",
  "› Ask Codex to do anything",
  "",
  "  GPT-5.6-Luna max · /lab/repos/cx · Recovery",
  "  ? for shortcuts                                     ⚠ 2 warnings · f2 to view",
].join("\n");

describe("Codex 0.157 resumed TUI", () => {
  it("is recognized as an active interactive conversation", () => {
    expect(assessNativeResumeProbe({ runtime: "codex", paneCommand: "codex", paneContent: RESUMED_0157 }).status).toBe("resumed");
  });
});
