import { execFile } from "node:child_process";
import type { ExecFn } from "./common.ts";

/**
 * Adding heel to an agent app (`heel agent add|rotate --client`). For Claude
 * Code heel runs `claude mcp add` itself, so the token goes straight into
 * Claude Code's config: an agent setting heel up never sees it, and a careful
 * one can't burn it by hiding it from its own output.
 * Codex reads its token from an environment variable heel can't set, so for
 * Codex, and whenever running the command fails, heel prints what to run.
 */

/** The agent apps `--client` knows. */
export const AGENT_CLIENTS = ["claude-code", "codex"] as const;
export type AgentClient = (typeof AGENT_CLIENTS)[number];

export function isAgentClient(value: string): value is AgentClient {
  return (AGENT_CLIENTS as readonly string[]).includes(value);
}

/**
 * Pure: `claude mcp add`'s arguments. User scope, so heel is there in every
 * project, not only the directory the command ran in.
 */
export function claudeAddArgs(url: string, token: string): string[] {
  return [
    "mcp",
    "add",
    "--scope",
    "user",
    "--transport",
    "http",
    "heel",
    url,
    "--header",
    `Authorization: Bearer ${token}`,
  ];
}

/** Pure: how to add heel to an agent app by hand, as commands to run. */
export function addToClient(client: AgentClient, url: string, token: string): string {
  switch (client) {
    case "claude-code":
      return (
        "Add heel to Claude Code (then run /mcp, or restart, to load it):\n" +
        `  claude mcp add --scope user --transport http heel "${url}" --header "Authorization: Bearer ${token}"`
      );
    case "codex":
      return (
        "Add heel to Codex (keep HEEL_TOKEN set where Codex runs, for example in your shell profile):\n" +
        `  export HEEL_TOKEN=${token}\n` +
        `  codex mcp add heel --url "${url}" --bearer-token-env-var HEEL_TOKEN`
      );
  }
}

/** What `--client` did: the text to print, and whether that text shows the token. */
export interface ClientResult {
  text: string;
  tokenShown: boolean;
}

/** Pure: a program's output with any heel token in it masked, for an error line. */
export function maskTokens(text: string): string {
  return text.replace(/heel_[A-Za-z0-9_-]+/g, "heel_…");
}

/**
 * Adds heel to the app. Claude Code, with a program runner: runs `claude mcp
 * add` and says what it changed. `replace` (rotate) first removes the user-scope
 * entry the old token sits in. Anything else, or a failure: prints the command,
 * with the token, so the token isn't lost.
 */
export async function connectClient(
  client: AgentClient,
  url: string,
  token: string,
  agentName: string,
  options: { exec: ExecFn | undefined; replace: boolean },
): Promise<ClientResult> {
  const manual = addToClient(client, url, token);
  if (client !== "claude-code" || options.exec === undefined) {
    return { text: manual, tokenShown: true };
  }
  if (options.replace) await options.exec("claude", ["mcp", "remove", "heel", "--scope", "user"]);
  const added = await options.exec("claude", claudeAddArgs(url, token));
  if (added.code === 0) {
    return {
      text:
        "Added heel to Claude Code for every project (claude mcp add --scope user, in your\n" +
        "Claude Code config). Run /mcp, or restart Claude Code, to load it.",
      tokenShown: false,
    };
  }
  const why =
    added.code === 127
      ? "the claude command isn't on this PATH"
      : (maskTokens(added.output).trim().split("\n")[0] ?? `claude exited ${added.code}`);
  const exists = /already exists/i.test(added.output)
    ? "\nTo replace that entry instead: claude mcp remove heel --scope user, then\n" +
      `heel agent rotate ${agentName} --client claude-code`
    : "";
  return {
    text: `heel couldn't add itself to Claude Code (${why}).${exists}\n\n${manual}`,
    tokenShown: true,
  };
}

/** Runs a program without a shell, for `CliIo.exec`. 127 when it isn't installed. */
export const runProgram: ExecFn = (command, args) =>
  new Promise((resolve) => {
    execFile(command, [...args], { timeout: 60_000 }, (error, stdout, stderr) => {
      const output = `${stdout}${stderr}`;
      if (error === null) {
        resolve({ code: 0, output });
      } else if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ code: 127, output });
      } else {
        resolve({ code: typeof error.code === "number" ? error.code : 1, output });
      }
    });
  });
