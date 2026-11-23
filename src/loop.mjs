import { readFileSync } from "node:fs";
import { copyFile, mkdir, readdir, stat, writeFile } from "node:fs/promises";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { homedir } from "node:os";
import { buildFailureReport, isPassingRun, makeRepairPrompt, parseNdjson, runKane } from "./kane.mjs";

const SNAPSHOT_SKIP = new Set(["node_modules", ".git", ".stillhere"]);

function nowTag() {
  return new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-");
}

function cleanSegment(value) {
  return basename(value).replace(/[^a-zA-Z0-9_-]/g, "_");
}

async function copyEvidence(result, artifactDir) {
  const sessionDir = result.runEnd?.session_dir;
  if (!sessionDir) return;
  const expandedSessionDir = sessionDir.startsWith("~/") ? join(homedir(), sessionDir.slice(2)) : sessionDir;
  const evidenceDir = join(expandedSessionDir, "evidence");
  let files;
  try {
    files = (await readdir(evidenceDir)).filter((file) => file.endsWith(".evidence"));
  } catch {
    return;
  }
  if (!files.length) return;
  const packPath = join(artifactDir, files[0]);
  try {
    await copyFile(join(evidenceDir, files[0]), packPath);
  } catch {
    return;
  }
  result.evidenceCopyPath = packPath;
  const extractPath = join(artifactDir, "evidence-extracted");
  const unzip = spawnSync("unzip", ["-q", "-o", packPath, "-d", extractPath], { encoding: "utf8", timeout: 15_000 });
  if (unzip.status === 0) result.evidenceExtractPath = extractPath;
}

function unquoteGitPath(raw) {
  const value = raw.replace(/\r$/, "");
  if (!value.startsWith('"') || !value.endsWith('"')) return value;
  return value.slice(1, -1).replace(/\\([nrt\\"]|[0-7]{3})/g, (_, token) => {
    if (token === "n") return "\n";
    if (token === "r") return "\r";
    if (token === "t") return "\t";
    if (token === "\\") return "\\";
    if (token === '"') return '"';
    return String.fromCharCode(parseInt(token, 8));
  });
}

function isSkippedSnapshotPath(relative) {
  return relative.split("/").some((part) => SNAPSHOT_SKIP.has(part));
}

function untrackedPathsFromStatus(statusText) {
  const paths = [];
  for (const line of statusText.split("\n")) {
    if (!line.startsWith("?? ")) continue;
    const relative = unquoteGitPath(line.slice(3));
    if (!isSkippedSnapshotPath(relative)) paths.push(relative);
  }
  return paths;
}

function listUntrackedFiles(workdir) {
  const listed = spawnSync("git", ["ls-files", "--others", "--exclude-standard", "-z", "--", "."], {
    cwd: workdir,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (listed.error || listed.status !== 0) return null;
  return (listed.stdout ?? "")
    .split("\0")
    .filter(Boolean)
    .filter((relative) => !isSkippedSnapshotPath(relative));
}

function snapshotGit(workdir) {
  const status = spawnSync("git", ["status", "--porcelain", "--", "."], {
    cwd: workdir,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (status.error || status.status !== 0) return null;
  // `git diff` (no HEAD) only shows unstaged worktree changes, so extra
  // staged edits and already-untracked file edits would hash the same.
  // Compare against HEAD, then hash untracked file contents too.
  const diff = spawnSync("git", ["diff", "HEAD", "--", "."], {
    cwd: workdir,
    encoding: "utf8",
    timeout: 15_000,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (diff.error || diff.status !== 0) return null;
  const untracked = listUntrackedFiles(workdir) ?? untrackedPathsFromStatus(status.stdout ?? "");
  const hash = createHash("sha256");
  hash.update(status.stdout ?? "");
  hash.update("\0");
  hash.update(diff.stdout ?? "");
  untracked.sort();
  for (const relative of untracked) {
    hash.update(relative);
    hash.update("\0");
    try {
      hash.update(readFileSync(join(workdir, relative)));
    } catch {
      hash.update("missing");
    }
    hash.update("\n");
  }
  return { kind: "git", hash: hash.digest("hex") };
}

async function snapshotFiles(root) {
  const hash = createHash("sha256");
  async function walk(dir, rel = "") {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (SNAPSHOT_SKIP.has(entry.name)) continue;
      const relative = rel ? `${rel}/${entry.name}` : entry.name;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, relative);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      try {
        const info = await stat(full);
        hash.update(relative);
        hash.update("\0");
        hash.update(String(info.mtimeMs));
        hash.update("\0");
        hash.update(String(info.size));
        hash.update("\n");
      } catch {
        // Skip paths that disappear mid-walk.
      }
    }
  }
  await walk(root);
  return { kind: "files", hash: hash.digest("hex") };
}

export async function snapshotWorkdir(workdir) {
  return snapshotGit(workdir) ?? await snapshotFiles(workdir);
}

function stopAgentProcess(child, signal, groupPid = child.pid) {
  if (process.platform !== "win32" && groupPid) {
    try {
      process.kill(-groupPid, signal);
      return;
    } catch {
      // The group may already be gone; fall back to the child.
    }
  }
  try {
    child.kill(signal);
  } catch {
    // The process may already have exited.
  }
}

export function runAgentCommand(command, prompt, { cwd, timeoutMs = 300_000 } = {}) {
  return new Promise((resolvePromise) => {
    const child = spawn(command, {
      cwd,
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
      detached: process.platform !== "win32",
    });
    const groupPid = child.pid;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;
    let killTimer;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!timedOut) clearTimeout(killTimer);
      resolvePromise({ ...result, stdout, stderr });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      // Always follow SIGTERM with a group SIGKILL so descendants that
      // ignore SIGTERM cannot keep running after the shell has already exited.
      stopAgentProcess(child, "SIGTERM", groupPid);
      killTimer = setTimeout(() => stopAgentProcess(child, "SIGKILL", groupPid), 5_000);
      finish({ exitCode: 124, error: "Coding agent exceeded the five minute timeout." });
    }, timeoutMs);
    child.stdout.on("data", (chunk) => { stdout += chunk.toString(); });
    child.stderr.on("data", (chunk) => { stderr += chunk.toString(); });
    child.on("error", (error) => finish({ exitCode: 127, error: error.message }));
    child.on("close", (code) => finish({ exitCode: code ?? 128 }));
    child.stdin.end(prompt);
  });
}

export async function runLoop({
  url,
  objective,
  maxAttempts = 2,
  agentCommand = "",
  workdir = process.cwd(),
  reportRoot = join(workdir, ".stillhere", "runs"),
  runKaneFn = runKane,
  runAgentFn = runAgentCommand,
  onLine = (line) => console.log(line),
}) {
  const outcomes = [];
  const boundedAttempts = Math.max(1, Number(maxAttempts) || 2);
  let firstFailure = null;

  for (let attempt = 1; attempt <= boundedAttempts; attempt += 1) {
    onLine(`\n[StillHere] Kane run ${attempt}/${boundedAttempts}`);
    const result = await runKaneFn({
      objective,
      url,
      cwd: workdir,
      onEvent: (event) => {
        if (event.status === "done" || event.status === "failed") {
          onLine(`  Kane step ${event.step ?? "?"} ${event.status}: ${event.remark ?? ""}`);
        }
      },
    });
    const normalized = { ...result, events: result.events ?? parseNdjson(result.stdout), runEnd: result.runEnd };
    outcomes.push(normalized);

    if (isPassingRun(normalized)) {
      if (normalized.exitCode !== 0) {
        const exitMeaning = normalized.exitCode === 3
          ? "Kane exited 3 (cancelled or hit --timeout) after emitting its final record."
          : `Kane exited ${normalized.exitCode} after emitting its final record.`;
        onLine(`[StillHere] ${exitMeaning} Using run_end.status=passed as the journey verdict.`);
      }
      if (firstFailure) {
        onLine(`\nBEFORE: FAIL — ${firstFailure.runEnd?.summary ?? firstFailure.runEnd?.reason ?? "Kane found lost checkout state."}`);
        onLine(`AFTER:  PASS — ${normalized.runEnd?.summary ?? "the same journey completed with state intact."}`);
        onLine(`[StillHere] Repaired on Kane run ${attempt}; original evidence is in ${firstFailure.artifactDir}.`);
      } else {
        onLine(`\nBEFORE: PASS — the journey already passed on its first run.`);
        onLine(`AFTER:  PASS — ${normalized.runEnd?.summary ?? "checkout state remained intact."}`);
      }
      return { exitCode: 0, outcomes, firstFailure, final: normalized };
    }

    const runEnd = normalized.runEnd;
    const isProductFailure = runEnd?.status === "failed";
    const tag = `${nowTag()}-attempt-${attempt}`;
    const artifactDir = join(reportRoot, cleanSegment(tag));
    await mkdir(artifactDir, { recursive: true });
    await copyEvidence(normalized, artifactDir);
    const reportPath = join(artifactDir, "failure-report.md");
    const report = buildFailureReport({ objective, url, attempt, result: normalized });
    await Promise.all([
      writeFile(join(artifactDir, "kane.ndjson"), normalized.stdout ?? "", "utf8"),
      writeFile(join(artifactDir, "kane.stderr.log"), normalized.stderr ?? "", "utf8"),
      writeFile(reportPath, report, "utf8"),
    ]);
    normalized.artifactDir = artifactDir;

    if (!isProductFailure) {
      const reason = normalized.exitCode === 3
        ? "Kane exited 3 (cancelled or hit --timeout) without a final run_end verdict."
        : normalized.error || `Kane stopped without a final run_end verdict (exit ${normalized.exitCode}).`;
      onLine(`\nBEFORE: ERROR — ${reason}`);
      onLine("AFTER:  NOT RUN — no app verdict was returned, so the coding agent was not asked to change the app.");
      onLine(`[StillHere] Diagnostics saved to ${artifactDir}.`);
      return { exitCode: normalized.exitCode || 2, outcomes, firstFailure, final: normalized };
    }

    if (!firstFailure) firstFailure = normalized;
    if (normalized.exitCode === 3) {
      onLine(`[StillHere] Kane exited 3 (cancelled or hit --timeout), and its final run_end says failed: ${runEnd.reason ?? runEnd.summary ?? "see the failure report"}.`);
    }
    onLine(`\nBEFORE: FAIL — ${runEnd?.summary ?? runEnd?.reason ?? "Kane found a broken checkout journey."}`);
    onLine(`[StillHere] Failure report: ${reportPath}`);
    onLine(`[StillHere] Kane evidence: ${runEnd?.session_dir ? `${runEnd.session_dir}/evidence/` : "not returned; see saved NDJSON and stderr"}`);

    if (!agentCommand) {
      onLine("AFTER:  WAITING FOR AGENT — set STILLHERE_AGENT_COMMAND or paste the saved report into your coding agent, then rerun.");
      return { exitCode: 1, outcomes, firstFailure, final: normalized, reportPath };
    }

    if (attempt >= boundedAttempts) {
      onLine("AFTER:  FAIL — retry limit reached; inspect the report and agent changes.");
      return { exitCode: 1, outcomes, firstFailure, final: normalized, reportPath };
    }

    const prompt = makeRepairPrompt({ reportPath, report, projectPath: resolve(workdir), objective });
    await writeFile(join(artifactDir, "repair-prompt.md"), prompt, "utf8");
    onLine(`\n[StillHere] Sending Kane's failure evidence to the coding agent: ${agentCommand}`);
    const beforeSnapshot = await snapshotWorkdir(workdir);
    const agentResult = await runAgentFn(agentCommand, prompt, { cwd: workdir });
    await Promise.all([
      writeFile(join(artifactDir, "agent.stdout.log"), agentResult.stdout ?? "", "utf8"),
      writeFile(join(artifactDir, "agent.stderr.log"), agentResult.stderr ?? "", "utf8"),
    ]);
    if (agentResult.exitCode !== 0) {
      onLine(`AFTER:  FAIL — coding agent exited with ${agentResult.exitCode}${agentResult.error ? `: ${agentResult.error}` : "."}`);
      onLine(`[StillHere] Agent logs are in ${artifactDir}.`);
      return { exitCode: agentResult.exitCode || 1, outcomes, firstFailure, final: normalized, reportPath, agentResult };
    }
    const afterSnapshot = await snapshotWorkdir(workdir);
    if (beforeSnapshot.hash === afterSnapshot.hash) {
      onLine("[StillHere] Coding agent made no changes. Skipping the re-run.");
      onLine("AFTER:  NO CHANGES — the coding agent finished without editing the app, so Kane was not run again.");
      return { exitCode: 1, outcomes, firstFailure, final: normalized, reportPath, agentResult, noChanges: true };
    }
    onLine("[StillHere] Coding agent finished. Re-running the unchanged Kane objective.");
  }

  return { exitCode: 1, outcomes, firstFailure, final: outcomes.at(-1) };
}
