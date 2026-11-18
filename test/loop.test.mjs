import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { buildFailureReport, getRunEnd, isPassingRun, parseNdjson } from "../src/kane.mjs";
import { runLoop } from "../src/loop.mjs";

function failureResult() {
  const events = [
    { step: 2, status: "done", remark: "Added Sonder travel mug to cart" },
    { step: 8, status: "failed", remark: "Review order step and cart were missing after browser Back" },
    { type: "run_end", status: "failed", summary: "Checkout state did not survive Back", reason: "Expected Review order, found Product", session_dir: "/tmp/kane-session", test_url: "https://test-manager.example/run/1" },
  ];
  return { exitCode: 1, stdout: events.map((event) => JSON.stringify(event)).join("\n"), stderr: "", events, runEnd: events.at(-1) };
}

function passingResult() {
  const runEnd = { type: "run_end", status: "passed", summary: "Checkout values survived Back and Refresh", reason: "Objective completed", final_state: { step: "Review order", cart: "Sonder travel mug" } };
  return { exitCode: 0, stdout: JSON.stringify(runEnd), stderr: "", events: [runEnd], runEnd };
}

test("parseNdjson skips malformed output and finds the final run_end", () => {
  const events = parseNdjson('{"step":1,"status":"done"}\nnot json\n{"type":"run_end","status":"passed"}\n');
  assert.equal(events.length, 2);
  assert.equal(getRunEnd(events).status, "passed");
  assert.equal(isPassingRun({ exitCode: 0, runEnd: getRunEnd(events) }), true);
});

test("failure report carries failed steps, final state, and Kane evidence location", () => {
  const result = failureResult();
  const report = buildFailureReport({ objective: "Preserve the checkout", url: "http://127.0.0.1:4173", attempt: 1, result });
  assert.match(report, /Review order step and cart were missing/);
  assert.match(report, /\/tmp\/kane-session\/evidence\//);
  assert.match(report, /Checkout state did not survive Back/);
});

test("loop hands the Kane failure to an agent and reruns the unchanged objective", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "stillhere-loop-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const outputs = [];
  const objectives = [];
  let runCount = 0;
  let agentPrompt = "";
  const result = await runLoop({
    url: "http://127.0.0.1:4173/",
    objective: "same exact objective",
    maxAttempts: 2,
    agentCommand: "mock-agent",
    workdir,
    reportRoot: join(workdir, ".stillhere", "runs"),
    onLine: (line) => outputs.push(line),
    runKaneFn: async (input) => {
      objectives.push(input.objective);
      runCount += 1;
      return runCount === 1 ? failureResult() : passingResult();
    },
    runAgentFn: async (_command, prompt) => {
      agentPrompt = prompt;
      return { exitCode: 0, stdout: "patched persistence", stderr: "" };
    },
  });

  assert.equal(result.exitCode, 0);
  assert.equal(runCount, 2);
  assert.deepEqual(objectives, ["same exact objective", "same exact objective"]);
  assert.match(agentPrompt, /failure report/);
  assert.match(outputs.join("\n"), /BEFORE: FAIL/);
  assert.match(outputs.join("\n"), /AFTER:  PASS/);
  const report = await readFile(join(result.firstFailure.artifactDir, "failure-report.md"), "utf8");
  const prompt = await readFile(join(result.firstFailure.artifactDir, "repair-prompt.md"), "utf8");
  assert.match(report, /checkout state/i);
  assert.match(prompt, /do not weaken or remove assertions/);
});

test("loop stops with a handoff report when no coding agent command is configured", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "stillhere-handoff-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  let runCount = 0;
  const result = await runLoop({
    url: "http://127.0.0.1:4173/",
    objective: "check checkout",
    workdir,
    reportRoot: join(workdir, "runs"),
    onLine: () => {},
    runKaneFn: async () => { runCount += 1; return failureResult(); },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(runCount, 1);
  assert.match(await readFile(result.reportPath, "utf8"), /failure report/i);
});
