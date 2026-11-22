# Code mode: how it runs

Written 2026-11-20, with the change that made code mode run on every OS (PR #177). It describes the code under `src/codemode/` as it is, for someone reading it for the first time. The user-facing version is [How code mode runs](../sandbox.md#how-code-mode-runs).

## What code mode is

An agent connected to bare `/mcp` gets one tool, `run_code`, instead of one tool per account action. It sends a short Python script. The script calls accounts as modules (`github.list_pull_requests(...)`).

[Monty](https://github.com/pydantic/monty) runs the script. Monty can pause a script at any call to a function it was given from outside. So every account call pauses the script, heel decides the call with its normal rule pipeline and runs it with the real credential, and the script resumes with the result. The script never holds a credential, and heel's own process never loads Monty.

## The pieces

```
agent -> run_code -> gateway/mcp/server.ts    takes a slot, makes a CodeWorker, calls runScript
                             |
                             v
                      codemode/run.ts          the loop: one step at a time, each call through the pipeline
                             |  CodeWorker (worker.ts): start() -> Step, step.resume() / step.raise(), stop()
              +--------------+---------------+
              v                              v
   SandboxedCodeWorker               HostedCodeWorker -> CodemodeHost
   (sandboxed.ts)                    (hosted.ts)         (hosted.ts, one per heel)
              | JSON lines                                   | JSON lines, each with a script id
              v                                              v
   heel codemode-worker              heel codemode-host  (the "helper")
   (worker-main.ts)                  (host-main.ts)
   one process per script,           one process for every script,
   under bubblewrap                  under Node's permission model
              |                                              |
              v                                              v
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
| Processes | One per script, started for it and killed after it | One per agent (a lane, `lanes.ts`), a few at a time, plus one spare kept started; a lane ends after a minute with nothing running and is never handed to another agent |
| Monty build | Native addon | WebAssembly, in a worker thread |
| A script's own worker | The whole sandboxed process | A worker thread, made ahead of time, used once |
| Protocol | `ToWorker` / `FromWorker` | `ToHost` / `FromHost`: the same messages plus a script `id`, and `stop` / `ended` |
| How heel ends a script | Kills the sandbox | Sends `stop`, waits for `ended` |
| Backstops heel adds | 1 GiB memory, 10 minutes wall time, 64 MB of output | Each step within the script's time limit plus 10 s; 16 MB a line and 64 MB a script; values over 8 MB refused as they're read; a stop within the time limit plus 10 s |
| What the process can read | `bin`, `src`, `dist`, `node_modules`, `package.json` of the install | The same parts, from the install's real path, plus the `node_modules` heel's dependencies were hoisted to |

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

### Parallel reads: futures

A built-in account's read tools also have an `_async` twin in the stubs (`get_issue_async`), declared `async def` (code mode round 2, C4). Monty can't tell a plain call from one inside `asyncio.gather`, so the twin is what says "run this as a future". A passthrough server's tools get none: their read marking is the server's own say-so.

1. A call to a twin arrives as a `call` step. `run.ts` records it (account, tool, arguments) by Monty's call id and answers `future`: the script carries on.
2. When every task is waiting, the worker sends an `await` step with the pending call ids. `run.ts` runs only ids it recorded, so a twin the script never awaits never runs, at most 8 at a time, each through the pipeline with `noAsk`: a rule that asks denies it (`approval_needed`) instead of opening a request, so a gather can't open one per call. An approval already given still lets it run.
3. Every call settles and is recorded. Values and errors go back in one `resolve`: a denial or `approval_needed` is a `PermissionError` at the `await`, an upstream error a `RuntimeError`. A pause, a withheld result or an unknown outcome stops the script once the others have settled.

Futures count toward the 200-call limit. An ask made the plain way while futures are still waiting ends the script rather than parking it (`notParked` says so): the futures' calls live only in `run.ts`.

### An ask: the script is parked

`run.ts` asks the worker to save the script where it waits (a `park` answer). Monty dumps the suspended script, the worker sends it back as a `parked` step and its script ends. `parking.ts` stores the dump in `parked_scripts`, sealed with the vault's key and bound to the row and the agent, with the calls so far and a hash of the modules. The answer is `pending`, with the approval id and a `resume` id. No `try/except` in the script runs, because the script doesn't get control back.

To carry on, the agent sends `run_code({ resume })`:

1. While the approval is still pending, heel answers `pending` again, without taking a slot or loading anything.
2. Once it's decided, heel opens the dump and refuses if the agent's modules changed since. The row stays for now.
3. A fresh worker starts with the dump (`start` with `snapshot`), and Monty restores the script at the call it parked at. Only then is the row deleted (`releaseParked`), so a resume that fails before this point (a hung-up client, a worker that doesn't start) can be tried again, and two resumes can't both run it. The run loop sends that call through the pipeline again: the approval admits it once, a denial raises `PermissionError` there, and the script carries on as usual.

The 200-call limit covers the whole script: Monty's own budget restarts on load, so `run.ts` counts the earlier calls. The time limit (30 s) and the stdout cap apply to each segment, from a start or a resume to the next park or the end, since a parked script spends its wait outside any worker. Expired rows are purged on every `run_code` and when heel starts. Snapshots are sealed with the master key directly (no key version), so rotating the master key makes scripts parked before it unresumable; they last no longer than their approvals anyway.

A dump larger than 4 MB, an agent with 5 scripts already waiting on undecided approvals, or heel without a vault means no parking: the script ends as below, and `notParked` says why.

### A pause, or a stop

The script is never resumed. `run.ts` calls `worker.stop()` and returns what ran so far. No `try/except` in the script can run, because the script never gets control back.

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
| The helper process | `CodemodeHost`, made and closed by `serve.ts` | Started on the first script, restarted after a crash, closed first when heel closes, so a running script's result can still reach its client |

`stop()` is called more than once for the same script, and sometimes before `start()`. Every `CodeWorker` has to be safe both ways. The slot is only released after `stop()` settles, so a `stop()` that settles early lets an agent run more scripts than its limit.

## The security walls

From the inside out:

1. **Monty.** The script has no files, network, environment or clock. It can only call the functions heel listed. Monty enforces the script's time, memory and call limits.
2. **The process around Monty.**
   - Bubblewrap path: no network, a clean environment, only heel's install mounted read-only, its own HOME and TMPDIR, and heel's own ceilings on memory, wall time and output. This is an OS boundary.
   - Helper path: WebAssembly. Breaking out means a bug in Monty's WebAssembly build that also escapes V8's WebAssembly sandbox. Around it, the helper runs with an empty environment, as its own process for one agent only (so a crash or a breakout reaches that agent's scripts, not heel or other agents), under Node's permission model: no file writes, no network, no child processes, no native addons, reads only of heel's install. The permission model alone is not a wall against code that already escaped into JavaScript: with `--allow-worker`, that code could start a worker thread with its own flags and none of the limits (Node documents this as intended). So on macOS the helper also runs inside Seatbelt (`seatbelt.ts`), which the kernel enforces for the whole process: that worker gets no reads outside heel's install, Node and the system, no writes, no network and no other programs. A test runs exactly that escape and checks each route is refused.
3. **heel's side of the pipe.** Nothing a process sends is trusted. Each message is checked field by field. Each call goes through the rule pipeline. Results are hidden before they go back in. heel caps stdout again itself. heel holds every credential and neither process ever sees one.

## Known limits

Mostly on the helper path, which is the newer and weaker of the two:

- **An agent's scripts share its helper.** A breakout reaches the other scripts of the same agent, not other agents'. On the bubblewrap path it reaches only its own script.
- **An agent past the lane cap waits.** With every lane busy with other agents, a script waits for the first to come free (its time still counts toward its client's patience, not its own limit). The cap is one lane per 2 GB of memory, between 2 and 8.
- **No OS sandbox on Linux without bubblewrap, or on Windows.** There, Node's permission model holds against Python but not against code that already escaped WebAssembly. Windows has AppContainer, but Node can't start a process in one without a native helper.
- **A busy script holds its slot until its time limit** when stopped, because Monty can't interrupt a worker thread mid-turn. That's deliberate: heel keeps counting it, so an agent can't start more than its limit by hanging up.
- **A stuck stop, or a helper that sends a line heel can't read, kills the helper,** which fails every other script running on it.
- **Windows is claimed, not tested.** This was written with the helper path running on macOS.

On both paths:

- **A script's last expression comes back as `output`,** beside its stdout, the status and the list of calls, like a REPL. None adds nothing; a value larger than the stdout cap (1 MB) is left out with a note (`output_omitted`).
