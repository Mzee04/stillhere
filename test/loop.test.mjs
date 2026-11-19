import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { buildFailureReport, getRunEnd, isPassingRun, parseNdjson } from "../src/kane.mjs";
import { runAgentCommand, runLoop } from "../src/loop.mjs";

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

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitUntil(predicate, timeoutMs, message) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(message);
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
      await writeFile(join(workdir, "shop-fix.js"), "sessionStorage.setItem('fixed', '1');\n", "utf8");
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

test("loop skips the Kane re-run when the coding agent makes no changes", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "stillhere-nochange-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const outputs = [];
  let runCount = 0;
  const result = await runLoop({
    url: "http://127.0.0.1:4173/",
    objective: "same exact objective",
    maxAttempts: 2,
    agentCommand: "mock-agent",
    workdir,
    reportRoot: join(workdir, ".stillhere", "runs"),
    onLine: (line) => outputs.push(line),
    runKaneFn: async () => {
      runCount += 1;
      return failureResult();
    },
    runAgentFn: async () => ({ exitCode: 0, stdout: "looked around, no edits", stderr: "" }),
  });
  const text = outputs.join("\n");
  assert.equal(result.exitCode, 1);
  assert.notEqual(result.exitCode, 0);
  assert.equal(runCount, 1);
  assert.equal(result.noChanges, true);
  assert.match(text, /Coding agent made no changes\. Skipping the re-run\./);
  assert.match(text, /AFTER:  NO CHANGES/);
});

test("loop reruns Kane after a git workdir edit and skips when git sees no change", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "stillhere-git-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  await writeFile(join(workdir, "app.js"), "const n = 1;\n", "utf8");
  const gitOpts = { cwd: workdir, encoding: "utf8" };
  assert.equal(spawnSync("git", ["init"], gitOpts).status, 0);
  assert.equal(spawnSync("git", ["add", "."], gitOpts).status, 0);
  const commit = spawnSync("git", ["-c", "user.name=StillHereTest", "-c", "user.email=test@example.com", "commit", "-m", "init"], gitOpts);
  assert.equal(commit.status, 0, commit.stderr);

  let runCount = 0;
  const outputs = [];
  const edited = await runLoop({
    url: "http://127.0.0.1:4173/",
    objective: "same exact objective",
    maxAttempts: 2,
    agentCommand: "mock-agent",
    workdir,
    reportRoot: join(workdir, ".stillhere", "runs"),
    onLine: (line) => outputs.push(line),
    runKaneFn: async () => {
      runCount += 1;
      return runCount === 1 ? failureResult() : passingResult();
    },
    runAgentFn: async () => {
      await writeFile(join(workdir, "app.js"), "const n = 2;\n", "utf8");
      return { exitCode: 0, stdout: "edited app.js", stderr: "" };
    },
  });
  assert.equal(edited.exitCode, 0);
  assert.equal(runCount, 2);
  assert.match(outputs.join("\n"), /Re-running the unchanged Kane objective/);

  runCount = 0;
  const noChangeOutputs = [];
  const unchanged = await runLoop({
    url: "http://127.0.0.1:4173/",
    objective: "same exact objective",
    maxAttempts: 2,
    agentCommand: "mock-agent",
    workdir,
    reportRoot: join(workdir, ".stillhere", "runs-2"),
    onLine: (line) => noChangeOutputs.push(line),
    runKaneFn: async () => {
      runCount += 1;
      return failureResult();
    },
    runAgentFn: async () => {
      const now = new Date();
      await utimes(join(workdir, "app.js"), now, now);
      return { exitCode: 0, stdout: "touched only", stderr: "" };
    },
  });
  assert.equal(unchanged.exitCode, 1);
  assert.equal(runCount, 1);
  assert.equal(unchanged.noChanges, true);
  assert.match(noChangeOutputs.join("\n"), /Coding agent made no changes\. Skipping the re-run\./);
});

test("runAgentCommand kills the whole process group on timeout", async (t) => {
  const workdir = await mkdtemp(join(tmpdir(), "stillhere-timeout-"));
  t.after(() => rm(workdir, { recursive: true, force: true }));
  const pidFile = join(workdir, "child.pid");
  const script = join(workdir, "hang.mjs");
  await writeFile(script, `
import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const ignore = () => {};
process.on("SIGTERM", ignore);
process.on("SIGHUP", ignore);
process.on("SIGINT", ignore);

if (process.argv[2] === "child") {
  setInterval(() => {}, 1000);
} else {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "child"], { stdio: "ignore" });
  writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
  setInterval(() => {}, 1000);
}
`);
  const started = Date.now();
  const result = await runAgentCommand(`${process.execPath} ${JSON.stringify(script)}`, "prompt", { cwd: workdir, timeoutMs: 800 });
  assert.equal(result.exitCode, 124, result.stderr || result.error || String(result.exitCode));
  assert.match(result.error, /timeout/i);
  assert.ok(Date.now() - started < 3_000, "timeout should resolve without waiting for SIGKILL");
  const pidText = await readFile(pidFile, "utf8");
  const childPid = Number(pidText.trim());
  assert.ok(Number.isInteger(childPid) && childPid > 0, "grandchild pid should be recorded");
  await waitUntil(() => !isAlive(childPid), 8_000, `grandchild pid ${childPid} was still running after the process-group kill`);
  assert.equal(isAlive(childPid), false);
});
