import { describe, expect, test } from "claude-code/testing";
import { intercept } from "./host";

const SESSION = "this-session";

const end = (reason: "prompt_input_exit" | "clear" | "resume") => ({
  reason,
  sessionId: SESSION,
  resume: { id: SESSION },
});

describe("on exit", () => {
  test("cancels this session's runs through the plugin's own cpu-lock.sh, detached", async ($, on) => {
    const host = intercept(on, {});
    await $.session.end(end("prompt_input_exit"));
    const [argv] = host.runs();
    expect(argv?.slice(0, 3)).toEqual(["sh", "-c", `nohup "$0" --cancel-session "$1" >/dev/null 2>&1 &`]);
    expect(argv?.[3]).toMatch(/^\/.*\/cpu-lock\.sh$/);
    expect(argv?.slice(4)).toEqual([SESSION]);
  });

  test("cancels nothing on /clear or /resume, which keep the process and its runs", async ($, on) => {
    const host = intercept(on, {});
    await $.session.end(end("clear"));
    await $.session.end(end("resume"));
    expect(host.runs()).toEqual([]);
  });
});
