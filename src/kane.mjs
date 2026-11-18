import { spawn } from "node:child_process";

export const DEFAULT_OBJECTIVE = `On the StillHere sample shop, start by clicking “Reset demo”. Add the Sonder travel mug to the cart and continue checkout. Enter customer name “Amina Bello” and email “amina@example.com”, choose Standard delivery, and continue to Review order. Verify the review shows Amina Bello, amina@example.com, one Sonder travel mug, and total $34.00. Open Product details, then use Back to checkout to return to the review. Verify the current step is still Review order and the same customer, item, quantity, and total remain. Click Refresh and verify the review step and those same values are still present. Report any value that is missing or changed as a failure.`;

export function parseNdjson(stdout = "") {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        const event = JSON.parse(line);
        return event && typeof event === "object" ? [event] : [];
      } catch {
        return [];
      }
    });
}

export function getRunEnd(events = []) {
  return [...events].reverse().find((event) => event.type === "run_end") ?? null;
}

export function isPassingRun(result) {
  return result?.runEnd?.status === "passed";
}

export function buildFailureReport({ objective, url, attempt, result }) {
  const events = result.events ?? parseNdjson(result.stdout);
  const runEnd = result.runEnd ?? getRunEnd(events);
  const failedSteps = events.filter((event) => event.type !== "run_end" && event.status === "failed");
  const finishedSteps = events.filter((event) => event.type !== "run_end" && event.status === "done");
  const lines = [
    "# StillHere Kane failure report",
    "",
    `- Attempt: ${attempt}`,
    `- Start URL: ${url}`,
    `- Kane exit code: ${result.exitCode ?? "unknown"}`,
    `- Kane status: ${runEnd?.status ?? "no run_end event"}`,
    `- Summary: ${runEnd?.summary ?? "Kane did not return a run summary."}`,
    `- Reason: ${runEnd?.reason ?? result.error ?? "No reason was returned."}`,
    `- Test Manager: ${runEnd?.test_url ?? "not available"}`,
    `- Kane evidence directory: ${runEnd?.session_dir ? `${runEnd.session_dir}/evidence/` : "not available; see the saved NDJSON and stderr log"}`,
    `- Evidence copied for the agent: ${result.evidenceCopyPath ?? "not available"}`,
    `- Extracted evidence screenshots: ${result.evidenceExtractPath ?? "not available"}`,
    "",
    "## Failed Kane steps",
    ...(failedSteps.length
      ? failedSteps.map((event) => `- Step ${event.step ?? "?"}: ${event.remark ?? "Kane reported a failed step."}`)
      : ["- Kane did not emit a step marked failed. Review the result summary and evidence pack."]),
    "",
    "## Last completed steps",
    ...(finishedSteps.length
      ? finishedSteps.slice(-8).map((event) => `- Step ${event.step ?? "?"}: ${event.remark ?? "Completed."}`)
      : ["- No completed steps were captured."]),
    "",
    "## Final state from Kane",
    "",
    "```json",
    JSON.stringify(runEnd?.final_state ?? {}, null, 2),
    "```",
    "",
    "## Exact objective to preserve",
    "",
    objective,
    "",
    "The NDJSON stream, stderr log, and this report are saved beside this file. The sealed Kane evidence pack contains step screenshots, browser logs, and failure records when Kane produced a session directory.",
  ];
  return lines.join("\n");
}

export function makeRepairPrompt({ reportPath, report, projectPath }) {
  return `You are the coding agent in StillHere's Kane verification loop. Read the failure report at ${reportPath}. Inspect the copied Kane evidence pack and extracted screenshots in the same report folder when available. Fix the application behavior that caused the user journey to lose its cart, checkout values, or current step on browser Back or Refresh. Preserve the test objective exactly; do not weaken or remove assertions, hide the regression, or hard-code a passing result. Persist the minimum necessary state (for example, sessionStorage plus history state) and restore it on page load and popstate. Keep the existing demo reset control able to clear saved state. Work only in ${projectPath}. The loop will rerun the same Kane objective after you finish.\n\nFailure report:\n${report}`;
}

export function runKane({
  objective,
  url,
  kaneCli = process.env.KANE_CLI || "kane-cli",
  timeoutSeconds = Number(process.env.KANE_TIMEOUT_SECONDS || 300),
  cwd = process.cwd(),
  onEvent = () => {},
}) {
  return new Promise((resolve) => {
    const args = ["run", objective, "--url", url, "--agent", "--timeout", String(timeoutSeconds)];
    if (String(process.env.KANE_HEADLESS || "false").toLowerCase() === "true") args.push("--headless");
    let stdout = "";
    let stderr = "";
    let pendingLine = "";
    let settled = false;
    let watchdogExpired = false;
    let watchdogTimer;
    let killTimer;
    const child = spawn(kaneCli, args, {
      cwd,
      env: { ...process.env, KANE_CLI_USER_AGENT: process.env.KANE_CLI_USER_AGENT || "codex" },
      stdio: ["ignore", "pipe", "pipe"],
    });

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(watchdogTimer);
      clearTimeout(killTimer);
      const events = parseNdjson(stdout);
      const runEnd = getRunEnd(events);
      const timedOutWithoutVerdict = watchdogExpired && !runEnd;
      resolve({
        ...result,
        ...(timedOutWithoutVerdict ? {
          exitCode: 124,
          timedOut: true,
          error: `StillHere safety watchdog expired after ${timeoutSeconds + 60} seconds without Kane's final run_end event.`,
        } : {}),
        watchdogExpired,
        stdout,
        stderr,
        events,
        runEnd,
      });
    };

    // Kane has its own --timeout. Leave an extra minute for its final NDJSON
    // event and process shutdown; never snapshot the stream immediately on kill.
    watchdogTimer = setTimeout(() => {
      watchdogExpired = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 10_000);
    }, (Math.max(1, timeoutSeconds) + 60) * 1000);

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout += text;
      pendingLine += text;
      const lines = pendingLine.split(/\r?\n/);
      pendingLine = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event && typeof event === "object") onEvent(event);
        } catch {
          // Kane's Agent Mode contract is NDJSON; ignore any non-JSON line defensively.
        }
      }
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", (error) => finish({ exitCode: 127, error: error.message }));
    child.on("close", (code, signal) => {
      if (pendingLine.trim()) {
        try {
          const event = JSON.parse(pendingLine);
          if (event && typeof event === "object") onEvent(event);
        } catch {
          // Keep the raw output for diagnosis.
        }
      }
      finish({ exitCode: code ?? (signal ? null : 128), signal });
    });
  });
}
