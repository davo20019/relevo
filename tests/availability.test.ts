import { describe, expect, it } from "vitest";
import {
  agentIsEnabled,
  availableAgentNames,
  unavailableAgentReasons,
} from "../src/config.js";

describe("availableAgentNames", () => {
  it("filters missing-command agents and preserves declared order", () => {
    const specs = {
      ready: { cmd: "ready-cli run {prompt}" },
      missing: { cmd: "missing-cli run {prompt}" },
      stdin: { cmd: "stdin-cli run" },
    };
    const fakeWhich = (name: string): string | null =>
      name === "ready-cli" || name === "stdin-cli" ? `/bin/${name}` : null;
    expect(availableAgentNames(specs, fakeWhich)).toEqual(["ready", "stdin"]);
  });

  it("skips disabled agents", () => {
    const specs = {
      ready: { cmd: "ready-cli {prompt}" },
      disabled: { cmd: "disabled-cli {prompt}", enabled: false },
    };
    expect(availableAgentNames(specs, () => "/bin/agent-cli")).toEqual(["ready"]);
  });
});

describe("unavailableAgentReasons", () => {
  it("labels disabled vs missing", () => {
    const specs = {
      ok: { cmd: "ok-cli {prompt}" },
      off: { cmd: "off-cli {prompt}", enabled: false },
      gone: { cmd: "gone-cli {prompt}" },
    };
    const w = (n: string) => (n === "ok-cli" ? "/bin/ok-cli" : null);
    const r = unavailableAgentReasons(specs, w);
    expect(r.off).toBe("disabled");
    expect(r.gone).toBe("not installed");
    expect(r.ok).toBeUndefined();
  });
});

describe("agentIsEnabled", () => {
  it("defaults to enabled when the field is missing", () => {
    expect(agentIsEnabled({ cmd: "x" })).toBe(true);
  });

  it("respects an explicit false", () => {
    expect(agentIsEnabled({ cmd: "x", enabled: false })).toBe(false);
  });
});
