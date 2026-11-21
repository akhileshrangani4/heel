# Code mode: how it runs

Written 2026-11-20, with the change that made code mode run on every OS (PR #177). It describes the code under `src/codemode/` as it is, for someone reading it for the first time. The user-facing version is [How code mode runs](../sandbox.md#how-code-mode-runs).

## What code mode is

An agent connected to bare `/mcp` gets one tool, `run_code`, instead of one tool per account action. It sends a short Python script. The script calls accounts as modules (`github.list_pull_requests(...)`).

[Monty](https://github.com/pydantic/monty) runs the script. Monty can pause a script at any call to a function it was given from outside. So every account call pauses the script, heel decides the call with its normal rule pipeline and runs it with the real credential, and the script resumes with the result. The script never holds a credential, and heel's own process never loads Monty.

## The pieces

```
agent ── run_code ──> gateway/mcp/server.ts   takes a slot, makes a CodeWorker, calls runScript
                             │
                             ▼
                      codemode/run.ts          the loop: one step at a time, each call through the pipeline
                             │  CodeWorker (worker.ts): start() -> Step, step.resume() / step.raise(), stop()
              ┌──────────────┴───────────────┐
              ▼                              ▼
   SandboxedCodeWorker               HostedCodeWorker ──> CodemodeHost
   (sandboxed.ts)                    (hosted.ts)          (hosted.ts, one per heel)
              │ JSON lines                                   │ JSON lines, each with a script id
              ▼                                              ▼
   heel codemode-worker              heel codemode-host  (the "helper")
   (worker-main.ts)                  (host-main.ts)
   one process per script,           one process for every script,
   under bubblewrap                  under Node's permission model
              │                                              │
              ▼                                              ▼
   MontyWorker (monty.ts)            MontyWorker (monty.ts)
   Monty's native build              Monty's WebAssembly build, one worker thread per script
```

`run.ts` knows nothing about processes. It only sees a `CodeWorker`, so the same loop drives both paths, and tests drive `MontyWorker` directly.

`serve.ts` picks the path once, at boot: bubblewrap if `probeSandbox()` says it works, the helper if not.

## The two paths side by side

| | Bubblewrap path | Helper path |
| --- | --- | --- |
| Where | Linux with unprivileged user namespaces | Everywhere else: macOS, containers without the flags, servers without user namespaces |
| heel's side | `sandboxed.ts` | `hosted.ts` |
| The other side | `worker-main.ts` (`heel codemode-worker`) | `host-main.ts` (`heel codemode-host`) |
| Processes | One per script, started for it and killed after it | One for all scripts, started on the first script |
| Monty build | Native addon | WebAssembly, in a worker thread |
| A script's own worker | The whole sandboxed process | A worker thread, made ahead of time, used once |
| Protocol | `ToWorker` / `FromWorker` | `ToHost` / `FromHost`: the same messages plus a script `id`, and `stop` / `ended` |
| How heel ends a script | Kills the sandbox | Sends `stop`, waits for `ended` |
| Backstops heel adds | 1 GiB memory, 10 minutes wall time, 64 MB of output | The script's time limit plus 10 seconds on `stop` only |
| What the process can read | `bin`, `src`, `dist`, `node_modules`, `package.json` of the install | The whole install directory |

What the two share lives in one place each:

- `protocol.ts`: the messages, the checks heel runs on anything a process sends (`parseFromWorker`, `parseFromHost`), and the conversions both sides use (`toWireModules`, `fromWireModules`, `toWire`, `fromWire`, `applyAnswer`, `stdoutUpTo`).
- `install.ts`: where heel's dependencies sit when they are outside the install (`hoistedDependencies`).
- `monty.ts`: the one place that talks to Monty.

## The life of one script

### Start

1. `run_code` arrives. `server.ts` takes a slot for the agent (`SandboxSlots`). No slot means the answer is `busy`, and nothing starts.
2. `server.ts` makes a `CodeWorker` and calls `runScript`. It also stops the worker if the HTTP request closes.
3. `runScript` calls `worker.start(code, modules, limits, onStdout)`.
   - Bubblewrap path: a temp directory is made, the sandbox starts, and `start` is written to its stdin.
   - Helper path: the script gets a random id, the helper is started if it isn't running, and `start` is sent with that id. The helper takes a spare worker thread and makes a new spare.
4. Monty type-checks the script against the account stubs, then runs it until the first call, the end, or a failure. That comes back as a `step`. Anything the script printed came back before it as `stdout` messages.

### A call

1. The step is `call`: module, function, keyword arguments. heel checks its shape before trusting it.
2. `run.ts` finds the account and tool, and runs the call through the pipeline with `surface: "code"`. Each call is decided on its own, so a loop of 500 deletes meets the same limits as 500 separate calls.
3. What happens next depends on the decision:
   - allowed: the script resumes with the result (after hiding);
   - denied, or an approval expired: `PermissionError` is raised at the call, and the script may catch it;
   - the account answered with an error: `RuntimeError` at the call;
   - anything else: the script is stopped. See the next section.

### An ask, a pause, or a stop

The script is never resumed. `run.ts` calls `worker.stop()` and returns what ran so far, with the approval id for an ask. No `try/except` in the script can run, because the script never gets control back.

The same happens when heel can't tell whether a write took effect, when a call ran but its result was withheld, when the script passes its call limit, and when the client hangs up.

- Bubblewrap path: `stop()` kills the sandbox, waits for it to end, and removes the temp directory.
- Helper path: `stop()` marks the script over, sends `stop`, and waits for `ended`. A script paused at a call ends at once. A script still computing can't be interrupted in the middle of a turn, so it ends when Monty's time limit ends that turn. If `ended` hasn't come 10 seconds after the time limit, heel kills the helper.

### Finish

The step is `done` or `failed`. `run.ts` calls `worker.stop()` and returns the status, stdout and the list of calls. `server.ts` then releases the slot.

On the helper path, the helper discards the worker thread by itself as soon as it sends a last step, so heel's `stop()` has nothing to wait for.

### The helper crashes

Every script on it gets a `failed` step ("the code-mode helper stopped"). None is retried, because a write may already have happened. heel keeps running. The next script starts a new helper.

If the helper can't make a worker for a script, it sends a `failed` step for that script and keeps going.

On the bubblewrap path the same event is smaller: one sandbox dying fails one script.

## Who cleans up what

| Thing | Owner | When |
| --- | --- | --- |
| The slot | `runCode` in `server.ts` | Released in `finally`, after `worker.stop()` has settled |
| Ending a script | `runScript` (`run.ts`) on every return path | Also `server.ts`: on hang-up, and once more in `finally` in case `runScript` threw |
| The sandbox process and its temp directory | `SandboxedCodeWorker.stop()` | Kill, wait, remove |
| A script's worker thread in the helper | `discard()` in `host-main.ts` | When the script's last step is sent, or on `stop` |
| heel's record of a helper script | `CodemodeHost.stop()` | Dropped once the worker is known to be gone |
| The helper process | `CodemodeHost`, made and closed by `serve.ts` | Started on the first script, restarted after a crash, closed with heel after the agent plane |

`stop()` is called more than once for the same script, and sometimes before `start()`. Every `CodeWorker` has to be safe both ways. The slot is only released after `stop()` settles, so a `stop()` that settles early lets an agent run more scripts than its limit.

## The security walls

From the inside out:

1. **Monty.** The script has no files, network, environment or clock. It can only call the functions heel listed. Monty enforces the script's time, memory and call limits.
2. **The process around Monty.**
   - Bubblewrap path: no network, a clean environment, only heel's install mounted read-only, its own HOME and TMPDIR, and heel's own ceilings on memory, wall time and output.
   - Helper path: WebAssembly first, then Node's permission model. The process may read heel's install and start worker threads. It has no file writes, no network, no child processes, no native addons, and an empty environment.
3. **heel's side of the pipe.** Nothing a process sends is trusted. Each message is checked field by field. Each call goes through the rule pipeline. Results are hidden before they go back in. heel caps stdout again itself. heel holds every credential and neither process ever sees one.

## Known limits

Mostly on the helper path, which is the newer and weaker of the two:

- **One helper serves every agent.** A script that broke out of Monty and WebAssembly into the helper could see other agents' scripts, their arguments and their results, and send calls in their name. Those calls would still go through the other agent's rules. On the bubblewrap path a breakout reaches only its own script.
- **The helper may read the whole install directory.** The bubblewrap path mounts five named parts. In a checkout, anything else in the folder is readable by the helper (a `.heel/` home kept inside the checkout, for example).
- **No ceiling on what the helper sends.** The bubblewrap path caps output at 64 MB and memory at 1 GiB. The helper has neither, and heel buffers a line until its newline arrives.
- **A busy script holds its slot until its time limit** when stopped, because a worker thread can't be interrupted mid-turn.
- **A stuck stop kills the helper,** which fails every other script running on it.
- **No overall time limit on heel's side.** If the helper never sends a step, heel waits until the client hangs up. The bubblewrap path has its 10-minute backstop.
- **The helper's stderr is discarded,** so when it dies heel can't say why.
- **Windows is claimed, not tested.** This was written with the helper path running on macOS.

On both paths:

- **A request that is already closed when `run_code` begins isn't noticed,** so its script runs to the end with nobody reading the result.
- **The script's last expression isn't returned to the agent.** Only stdout, the status and the list of calls are. A script has to `print` what it wants to see.
