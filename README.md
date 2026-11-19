# StillHere

**StillHere checks whether a web app keeps a shopper's work after browser Back or Refresh.** It runs a real browser journey with Kane CLI, sends Kane's failure evidence to a coding agent, and asks Kane to verify the agent's repair.

StillHere was built with OpenAI Codex. Its sample configuration uses Codex CLI as the repair agent; you can replace it with another command-line coding agent.

[Demo video](https://youtu.be/4R3yvR5oKvg) (3 minutes 18 seconds): Kane CLI drives a real Chrome session, catches the checkout bug, Codex repairs it, and Kane confirms the fix.

## How it works

1. StillHere starts the sample shop (or targets your running local app) and calls `kane-cli run` with the journey, URL, `--agent`, and a 300-second timeout.
2. Kane writes progress as NDJSON and finishes with a `run_end` record. StillHere waits for Kane to finish and uses the final `run_end.status` as the verdict. A process exit code alone cannot create a pass.
3. If Kane reports `failed`, StillHere saves the report, failed steps, NDJSON, stderr, and available evidence under `.stillhere/runs/`. It sends a repair prompt with that evidence to the configured coding agent on stdin.
4. The agent edits the target app. If it makes no file changes, StillHere skips the Kane re-run and reports that clearly. If the agent exceeds its five-minute timeout, StillHere stops the whole process group so it cannot keep running. Otherwise it runs the unchanged Kane objective again and prints the `BEFORE` and `AFTER` result. If Kane does not emit a final result record, StillHere reports an incomplete run and does not ask the agent to repair the app.

The included Sonder Supply demo shop has an intentional bug: returning from Product details with browser Back loses the checkout state, and Refresh also resets it. The agent's sample repair persists the minimum state in `sessionStorage` and restores it with browser history. `fixtures/broken-shop.js` is the saved buggy source; `npm run demo:reset` copies it into `public/shop.js` before a fresh recording.

## Requirements

- Node.js 18+, npm, and Chrome; recorded on macOS.
- Kane CLI installed and authenticated with a TestMu AI account. Kane keeps its OAuth credentials in its own profile under your home directory, outside this repository.
- A command-line coding agent for automatic repair. The example `.env` uses Codex CLI; authenticate that tool separately. For manual repair, leave `STILLHERE_AGENT_COMMAND` empty and use the saved repair prompt.

## Setup and run

Install Kane CLI once and authenticate it in your own terminal:

```sh
npm install -g @testmuai/kane-cli
kane-cli login --oauth
kane-cli whoami
```

For automatic repair, install Codex CLI if needed, then run `codex` once and choose **Sign in with ChatGPT**. The sample `.env` invokes `codex exec`; no OpenAI API key is needed for this ChatGPT sign-in flow. Follow the [official Codex CLI setup guide](https://developers.openai.com/codex/cli) for install and sign-in options.

```sh
curl -fsSL https://chatgpt.com/codex/install.sh | sh
codex
```

Clone the repo and run the demo:

```sh
git clone https://github.com/Mzee04/stillhere.git
cd stillhere
cp .env.example .env
npm run demo:loop
```

No `npm install` is needed in this repository; the app uses Node.js built-ins. `demo:loop` restores the saved Back/Refresh bug first, then starts the shop, runs Kane, hands a failure to the configured agent, and reruns the same journey. The sample `.env` expects `codex` to be installed and authenticated. Change `STILLHERE_AGENT_COMMAND` in `.env` to use another agent; the command must read the repair prompt from stdin and be able to edit this project. To restore the broken shop on its own, run `npm run demo:reset`.

The browser is visible by default. Set `KANE_HEADLESS=true` in `.env` only when running without a display.

## For judges

No credentials are included in this repository, and none are required to use the sample shop.

Use your own TestMu AI account and `kane-cli login`, plus `codex login` for the automatic repair demo. Then run `npm run demo:loop`.

If you can't run Kane or Codex, watch the demo: https://youtu.be/4R3yvR5oKvg

## Point it at your own app

Start your app locally, then run StillHere from this project directory. `--project-dir` is the app directory the coding agent can inspect and edit; it defaults to the current directory.

```sh
npm run loop -- --url http://127.0.0.1:3000/ --project-dir /path/to/your/app --objective "Complete signup, use Back and Refresh, then verify the same email, form values, and current step remain."
```

Use stable test data and a local or staging app. Do not use real customer data or a live payment flow in a demo. If you omit the configured agent command, StillHere saves the failure report and repair prompt so you can apply the fix manually, then rerun the same command.

## Real fail-fix-pass output

The excerpts below are from the saved StillHere failure report, the actual Codex CLI output, and a later Kane session after the timeout correction. The complete StillHere wrapper transcript was not retained, so these are labeled source excerpts rather than reconstructed console output.

**FAIL — saved StillHere report:**

```text
- Kane exit code: 1
- Kane status: failed
- Summary: The return link does not restore the checkout page that the shopper left.
- Reason: Back to checkout returned to the product shop, so the required review state is missing.
```

**FIX — actual coding-agent output (local file link shortened):**

```text
Updated public/shop.js to save checkout data in sessionStorage, associate page and stage with history entries, and restore them on load and browser Back.
`node --check public/shop.js` passed. I did not rerun Kane; the loop will rerun the unchanged objective.
```

**PASS — Kane's recorded Back, Refresh, and final verdict:**

```text
[2026-11-17 20:58:11] STEP_END Step 15 passed {"index":15,"status":"passed","duration":6.4,"summary":"click: Clicking Back to checkout to return to the review"}
[2026-11-17 20:58:49] STEP_END Step 18 passed {"index":18,"status":"passed","duration":0,"summary":"assert: the current step is still Review order and {{customer_name}}, {{customer_email}}"}
[2026-11-17 20:58:57] STEP_END Step 19 passed {"index":19,"status":"passed","duration":6.6,"summary":"click: Clicking Refresh"}
[2026-11-17 20:59:07] STEP_END Step 20 passed {"index":20,"status":"passed","duration":9.2,"summary":"wait: PRIMARY: wait for the Review order heading to load after Refresh"}
[2026-11-17 20:59:32] STEP_END Step 21 passed {"index":21,"status":"passed","duration":24.9,"summary":"analyze: {{item_quantity}} is still present"}
[2026-11-17 20:59:33] STEP_END Step 22 passed {"index":22,"status":"passed","duration":0,"summary":"assert: the review step and {{customer_name}}, {{customer_email}}, {{cart_item}}, {{item_quantity}}, and {{order_total}} are still present"}
[2026-11-17 20:59:36] RUNNER_EXIT Runner exited {"code":0,"signal":"none"}
[2026-11-17 20:59:36] RUN 0 END status=passed duration=221.9s summary="Reset the StillHere sample shop, added one Sonder travel mug to the cart, and continued to checkout." {"result_code":100}
[2026-11-17 21:00:02] SESSION END status=passed total_runs=1
```

The successful Kane run took about 222 seconds. StillHere's default Kane timeout is 300 seconds, with an additional 60-second shutdown window for Kane's final record.

## Commands

```sh
npm start                         # Serve the sample shop at http://127.0.0.1:4173
npm run demo:reset                # Restore the saved broken shop source
npm run demo:loop                 # Run the sample fail/fix/recheck loop
npm run loop -- --url <url>       # Run against an already-running app
npm test                          # Run the local loop-logic tests
```

## Configuration

Copy `.env.example` to `.env`. It contains example settings, not credentials.

- `PORT`: demo shop port (default `4173`).
- `KANE_CLI`: Kane executable name or path.
- `KANE_TIMEOUT_SECONDS`: timeout for one Kane run (default `300`).
- `KANE_HEADLESS`: `false` shows Chrome; set `true` for a headless machine.
- `KANE_CLI_USER_AGENT`: caller label sent to Kane CLI (default `codex`).
- `STILLHERE_MAX_ATTEMPTS`: total Kane runs in one loop (default `2`).
- `STILLHERE_AGENT_COMMAND`: optional repair command. It receives the prompt on stdin and may edit the configured app directory.

## License

StillHere is released under the MIT License. See [LICENSE](LICENSE).

## Kane CLI documentation

- [Installation](https://www.testmuai.com/docs/kane-cli-installation)
- [Quick start and OAuth authentication](https://www.testmuai.com/docs/kane-cli-quickstart)
- [Authentication details](https://www.testmuai.com/docs/kane-cli-authentication)
- [Agent Mode NDJSON contract](https://www.testmuai.com/docs/kane-cli-agent-mode)
- [CLI flags](https://www.testmuai.com/docs/kane-cli-cli-reference)
