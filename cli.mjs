import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_OBJECTIVE } from "./src/kane.mjs";
import { runLoop } from "./src/loop.mjs";
import { listenDemoServer } from "./server.mjs";

const projectRoot = resolve(fileURLToPath(new URL(".", import.meta.url)));

async function loadEnvFile() {
  try {
    const content = await readFile(resolve(projectRoot, ".env"), "utf8");
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      let value = trimmed.slice(separator + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (process.env[key] === undefined) process.env[key] = value;
    }
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function readOptions(args) {
  const result = { _: [] };
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      result._.push(value);
      continue;
    }
    const [key, inlineValue] = value.slice(2).split("=", 2);
    if (inlineValue !== undefined) result[key] = inlineValue;
    else if (args[index + 1] && !args[index + 1].startsWith("--")) result[key] = args[++index];
    else result[key] = true;
  }
  return result;
}

async function run(options, fallbackUrl) {
  const targetUrl = options.url || process.env.STILLHERE_URL || fallbackUrl || "http://127.0.0.1:4173/";
  const projectDir = resolve(options["project-dir"] || process.env.STILLHERE_PROJECT_DIR || process.cwd());
  const objective = options.objective || process.env.STILLHERE_OBJECTIVE || DEFAULT_OBJECTIVE;
  const maxAttempts = Number(options["max-attempts"] || process.env.STILLHERE_MAX_ATTEMPTS || 2);
  const agentCommand = options["agent-command"] || process.env.STILLHERE_AGENT_COMMAND || "";
  const result = await runLoop({
    url: targetUrl,
    objective,
    maxAttempts,
    agentCommand,
    workdir: projectDir,
  });
  process.exitCode = result.exitCode;
}

await loadEnvFile();
const [command = "help", ...args] = process.argv.slice(2);
const options = readOptions(args);

if (command === "demo" || command === "start") {
  const { server, host, port } = await listenDemoServer();
  console.log(`StillHere sample shop running at http://${host}:${port}/`);
  console.log("Use another terminal for: npm run loop");
  console.log("Press Ctrl+C to stop.");
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => server.close(() => process.exit(0)));
  }
} else if (command === "loop") {
  await run(options);
} else if (command === "demo-loop") {
  const port = Number(process.env.PORT || 4173);
  const { server, host } = await listenDemoServer({ port });
  try {
    await run(options, `http://${host}:${port}/`);
  } finally {
    await new Promise((resolveClose) => server.close(resolveClose));
  }
} else {
  console.log(`StillHere — Kane CLI state-recovery verifier

Commands:
  npm start                         Start the sample shop at http://127.0.0.1:4173
  npm run loop                      Run Kane against the already-running local app
  npm run demo:loop                 Start the sample shop and run the fail/fix/re-run loop

Options for loop commands:
  --url <url>                       Start URL for your local app
  --project-dir <path>              Directory the coding agent should inspect and patch
  --objective "..."                 Override the default plain-English journey
  --max-attempts <n>                Total Kane runs, including the first run (default 2)
  --agent-command "..."             Override STILLHERE_AGENT_COMMAND`);
}
