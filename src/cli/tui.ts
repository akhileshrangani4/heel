import { spawn } from "node:child_process";
import { adminCall } from "../admin/client.ts";
import type { AdminMethod, AdminRequestOf, AdminResults } from "../admin/protocol.ts";
import type { HeelConfig } from "../config/schema.ts";

/**
 * `heel tui`: a full-screen view of a running heel from the
 * terminal it runs on. It reads through the admin socket and changes only
 * what a plain admin command can: it pauses an agent (one key, then a
 * confirm). Deciding a request needs a passkey, which a terminal can't
 * give, so Enter opens that request's page in the browser instead.
 *
 * Drawing and keys are pure (`renderTui`, `handleKey`) so tests can check
 * them without a terminal; `runTui` is the loop around them.
 */

export type ApprovalItem = AdminResults["approvals.list"][number];

/** A rule proposal waiting for its owner, as `proposals.list` returns it. */
export type ProposalItem = Pick<
  AdminResults["proposals.list"][number],
  "id" | "agent" | "owner" | "rules" | "summary" | "reason" | "createdAt" | "expiresAt" | "url"
>;

/**
 * Pure: proposals join the Requests list as waiting items, newest first
 * with the rest. Enter opens the proposal's page, where the owner adds it
 * with a passkey, just as for a request.
 */
export function withProposals(
  approvals: readonly ApprovalItem[],
  proposals: readonly ProposalItem[],
): ApprovalItem[] {
  const asItems = proposals.map(
    (p): ApprovalItem => ({
      id: p.id,
      agent: p.agent,
      account: `${p.owner}'s rules`,
      status: "pending",
      summary: p.summary,
      reason: p.reason,
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
      url: p.url,
    }),
  );
  return [...approvals, ...asItems].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export type ActivityItem = AdminResults["activity.list"][number];

export type AgentItem = Pick<
  AdminResults["agent.list"][number],
  "id" | "name" | "owner" | "revokedAt" | "tokenExpiresAt" | "hasToken"
>;

export type AccountItem = Pick<
  AdminResults["account.list"][number],
  "alias" | "provider" | "owner" | "status"
>;

export type PauseItem = Pick<AdminResults["pause.list"][number], "scope" | "targetName">;

export interface TuiData {
  version: string | null;
  approvals: readonly ApprovalItem[];
  activity: readonly ActivityItem[];
  agents: readonly AgentItem[];
  accounts: readonly AccountItem[];
  pauses: readonly PauseItem[];
  /** Why the last refresh failed (heel stopped, say); the view keeps what it had. */
  error: string | null;
}

export const TABS = ["requests", "activity", "agents", "accounts"] as const;
export type Tab = (typeof TABS)[number];

export interface TuiState {
  tab: Tab;
  selected: number;
  /** Waiting for y/n before pausing this agent. */
  confirmPause: string | null;
  message: string | null;
}

export type TuiEffect =
  | { kind: "open"; url: string }
  | { kind: "pause"; agent: string }
  | { kind: "quit" };

export const INITIAL_STATE: TuiState = {
  tab: "requests",
  selected: 0,
  confirmPause: null,
  message: null,
};

type Style = "plain" | "bold" | "dim" | "green" | "red" | "amber" | "blue" | "invert";
type Segment = readonly [string, Style];
type Line = readonly Segment[];

const CODES: Record<Style, string> = {
  plain: "",
  bold: "\u001b[1m",
  dim: "\u001b[2m",
  green: "\u001b[32m",
  red: "\u001b[31m",
  amber: "\u001b[33m",
  blue: "\u001b[34m",
  invert: "\u001b[7m",
};

/** Pure: one line, cut to `width` columns, with colour only when asked. */
function draw(line: Line, width: number, color: boolean): string {
  let left = width;
  let out = "";
  for (const [text, style] of line) {
    if (left <= 0) break;
    const chars = [...text];
    const part = chars.slice(0, left).join("");
    left -= Math.min(chars.length, left);
    out += color && style !== "plain" ? `${CODES[style]}${part}\u001b[0m` : part;
  }
  return out;
}

function ago(iso: string, now: Date): string {
  const minutes = Math.round((now.getTime() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function until(iso: string, now: Date): string {
  const minutes = Math.round((new Date(iso).getTime() - now.getTime()) / 60_000);
  if (minutes <= 0) return "expired";
  if (minutes < 60) return `in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `in ${hours} h` : `in ${Math.round(hours / 24)} d`;
}

const STATUS_STYLE: Record<string, Style> = {
  pending: "amber",
  approved: "green",
  executed: "green",
  denied: "red",
  expired: "dim",
};

const KIND_STYLE: Record<string, Style> = {
  allow: "green",
  executed: "green",
  approved: "green",
  deny: "red",
  approval_denied: "red",
  ask: "amber",
  paused: "blue",
  would_deny: "amber",
  would_ask: "amber",
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function pad(text: string, width: number): string {
  const chars = [...text];
  return chars.length >= width ? `${chars.slice(0, width - 1).join("")} ` : text.padEnd(width);
}

/** How many rows the current tab has, for moving the selection. */
export function rowCount(data: TuiData, tab: Tab): number {
  switch (tab) {
    case "requests":
      return data.approvals.length;
    case "activity":
      return data.activity.length;
    case "agents":
      return data.agents.length;
    case "accounts":
      return data.accounts.length;
  }
}

function header(data: TuiData): Line {
  const waiting = data.approvals.filter((a) => a.status === "pending").length;
  const status: Segment[] =
    data.error !== null
      ? [["● not reachable", "red"]]
      : data.pauses.some((p) => p.scope === "global")
        ? [["● paused: everything", "blue"]]
        : [["● running", "green"]];
  return [
    [" heel ", "bold"],
    ...status,
    [data.version === null ? "" : `  v${data.version}`, "dim"],
    [
      `   ${waiting} waiting · ${plural(data.agents.filter((a) => a.revokedAt === null).length, "agent")} · ${plural(data.accounts.length, "account")}${
        data.pauses.length > 0 ? ` · ${data.pauses.length} paused` : ""
      }`,
      "dim",
    ],
  ];
}

function tabsLine(data: TuiData, state: TuiState): Line {
  const label: Record<Tab, string> = {
    requests: `Requests (${data.approvals.filter((a) => a.status === "pending").length})`,
    activity: "Activity",
    agents: "Agents",
    accounts: "Accounts",
  };
  const segments: Segment[] = [[" ", "plain"]];
  TABS.forEach((tab, i) => {
    segments.push(
      [` ${i + 1} ${label[tab]} `, tab === state.tab ? "invert" : "dim"],
      [" ", "plain"],
    );
  });
  return segments;
}

function body(data: TuiData, state: TuiState, now: Date, height: number): Line[] {
  const mark = (i: number): Segment => [i === state.selected ? " › " : "   ", "bold"];
  switch (state.tab) {
    case "requests": {
      if (data.approvals.length === 0) {
        return [[["   Nothing is waiting. New requests appear here as they come in.", "dim"]]];
      }
      const lines: Line[] = [];
      data.approvals.forEach((a, i) => {
        lines.push([
          mark(i),
          [pad(a.status.toUpperCase(), 10), STATUS_STYLE[a.status] ?? "plain"],
          [a.summary, i === state.selected ? "bold" : "plain"],
        ]);
        lines.push([
          ["             ", "plain"],
          [
            `${a.agent} · ${a.account} · ${ago(a.createdAt, now)}${a.status === "pending" ? ` · expires ${until(a.expiresAt, now)}` : ""}`,
            "dim",
          ],
        ]);
        if (a.reason !== null)
          lines.push([
            ["             ", "plain"],
            [`“${a.reason}”`, "dim"],
          ]);
      });
      return scrolled(lines, state.selected * 2, height);
    }
    case "activity": {
      if (data.activity.length === 0) return [[["   No calls yet.", "dim"]]];
      const names = new Map(data.agents.map((a) => [a.id, a.name]));
      const lines = data.activity.map(
        (r, i): Line => [
          mark(i),
          [`${r.at.slice(11, 19)}  `, "dim"],
          [
            pad(r.kind.replaceAll("_", " ") + (r.mode === null ? "" : " (watch)"), 18),
            KIND_STYLE[r.kind] ?? "plain",
          ],
          [pad(names.get(r.agentId) ?? r.agentId, 14), "plain"],
          [pad(r.account, 16), "plain"],
          [pad(r.action, 22), "plain"],
          [r.rule ?? "no rule", "dim"],
        ],
      );
      return scrolled(lines, state.selected, height);
    }
    case "agents": {
      if (data.agents.length === 0)
        return [[["   No agents yet. Add one: heel agent add <name>", "dim"]]];
      const lines = data.agents.map(
        (a, i): Line => [
          mark(i),
          [pad(a.name, 18), i === state.selected ? "bold" : "plain"],
          [pad(a.owner, 12), "dim"],
          [
            pad(
              a.revokedAt !== null
                ? "revoked"
                : data.pauses.some((p) => p.scope === "agent" && p.targetName === a.name)
                  ? "paused"
                  : "active",
              10,
            ),
            a.revokedAt !== null
              ? "dim"
              : data.pauses.some((p) => p.scope === "agent" && p.targetName === a.name)
                ? "blue"
                : "green",
          ],
          [
            a.revokedAt !== null || !a.hasToken
              ? ""
              : a.tokenExpiresAt === null
                ? "token never expires"
                : `token expires ${until(a.tokenExpiresAt, now)}`,
            "dim",
          ],
        ],
      );
      return scrolled(lines, state.selected, height);
    }
    case "accounts": {
      if (data.accounts.length === 0) {
        return [[["   No accounts yet. Connect one: heel connect <service> --as <name>", "dim"]]];
      }
      const lines = data.accounts.map(
        (a, i): Line => [
          mark(i),
          [pad(a.alias, 22), i === state.selected ? "bold" : "plain"],
          [pad(a.provider, 18), "dim"],
          [
            a.status === "active" ? "ready" : a.status.replaceAll("_", " "),
            a.status === "active" ? "green" : "amber",
          ],
        ],
      );
      return scrolled(lines, state.selected, height);
    }
  }
}

/** The window of `lines` that keeps line `focus` in view. */
function scrolled(lines: Line[], focus: number, height: number): Line[] {
  if (lines.length <= height) return lines;
  const start = Math.min(Math.max(0, focus - Math.floor(height / 2)), lines.length - height);
  return lines.slice(start, start + height);
}

function footer(state: TuiState): Line {
  if (state.confirmPause !== null) {
    return [
      [
        ` Pause agent ${state.confirmPause}? Its calls stop at once. y to pause, any other key to cancel `,
        "invert",
      ],
    ];
  }
  const keys: Record<Tab, string> = {
    requests: "↑↓ select  enter open in browser  p pause its agent",
    activity: "↑↓ scroll  p pause its agent",
    agents: "↑↓ select  p pause",
    accounts: "↑↓ select",
  };
  return [[` ${keys[state.tab]}  1-4 tabs  q quit`, "dim"]];
}

/** Pure: the whole screen as text, `rows` lines of at most `columns` characters. */
export function renderTui(
  data: TuiData,
  state: TuiState,
  size: { columns: number; rows: number },
  now: Date,
  color: boolean,
): string {
  const rule: Line = [["─".repeat(size.columns), "dim"]];
  const top = [header(data), tabsLine(data, state), rule];
  const notes: Line[] = [];
  if (data.error !== null) notes.push([[` ${data.error}`, "red"]]);
  if (state.message !== null) notes.push([[` ${state.message}`, "amber"]]);
  const height = Math.max(1, size.rows - top.length - notes.length - 2);
  const lines = [...top, ...body(data, state, now, height)];
  while (lines.length < size.rows - notes.length - 2) lines.push([]);
  lines.push(...notes, rule, footer(state));
  return lines
    .slice(0, size.rows)
    .map((line) => draw(line, size.columns, color))
    .join("\n");
}

/** Pure: what a key does. `key` is the name readline gives (up, down, return, or the character). */
export function handleKey(
  state: TuiState,
  key: string,
  data: TuiData,
): { state: TuiState; effect: TuiEffect | null } {
  if (state.confirmPause !== null) {
    const agent = state.confirmPause;
    return key === "y"
      ? { state: { ...state, confirmPause: null }, effect: { kind: "pause", agent } }
      : { state: { ...state, confirmPause: null, message: "Not paused." }, effect: null };
  }
  const cleared = { ...state, message: null };
  const count = rowCount(data, state.tab);
  switch (key) {
    case "q":
    case "escape":
      return { state: cleared, effect: { kind: "quit" } };
    case "up":
    case "k":
      return { state: { ...cleared, selected: Math.max(0, state.selected - 1) }, effect: null };
    case "down":
    case "j":
      return {
        state: { ...cleared, selected: Math.min(Math.max(0, count - 1), state.selected + 1) },
        effect: null,
      };
    case "tab":
    case "right": {
      const next = TABS[(TABS.indexOf(state.tab) + 1) % TABS.length] ?? "requests";
      return { state: { ...cleared, tab: next, selected: 0 }, effect: null };
    }
    case "left": {
      const prev = TABS[(TABS.indexOf(state.tab) + TABS.length - 1) % TABS.length] ?? "requests";
      return { state: { ...cleared, tab: prev, selected: 0 }, effect: null };
    }
    case "1":
    case "2":
    case "3":
    case "4":
      return {
        state: { ...cleared, tab: TABS[Number(key) - 1] ?? "requests", selected: 0 },
        effect: null,
      };
    case "return":
    case "o": {
      const request = state.tab === "requests" ? data.approvals[state.selected] : undefined;
      if (request === undefined) return { state: cleared, effect: null };
      return {
        state: { ...cleared, message: `Opening ${request.url}` },
        effect: { kind: "open", url: request.url },
      };
    }
    case "p": {
      const names = new Map(data.agents.map((a) => [a.id, a.name]));
      const agent =
        state.tab === "requests"
          ? data.approvals[state.selected]?.agent
          : state.tab === "activity"
            ? names.get(data.activity[state.selected]?.agentId ?? "")
            : state.tab === "agents"
              ? data.agents[state.selected]?.name
              : undefined;
      if (agent === undefined) return { state: cleared, effect: null };
      return { state: { ...cleared, confirmPause: agent }, effect: null };
    }
    default:
      return { state, effect: null };
  }
}

async function call<M extends AdminMethod>(
  config: HeelConfig,
  request: AdminRequestOf<M>,
): Promise<AdminResults[M]> {
  const response = await adminCall(config.adminSocketPath, request);
  if (!response.ok) throw new Error(response.error.message);
  return response.result;
}

/** One refresh: everything the screen shows, newest activity first. */
async function load(config: HeelConfig, previous: TuiData): Promise<TuiData> {
  try {
    const [ping, approvals, proposals, activity, agents, accounts, pauses] = await Promise.all([
      call(config, { method: "ping" }),
      call(config, { method: "approvals.list" }),
      call(config, { method: "proposals.list" }),
      call(config, { method: "activity.list", params: { limit: 200 } }),
      call(config, { method: "agent.list" }),
      call(config, { method: "account.list" }),
      call(config, { method: "pause.list" }),
    ]);
    return {
      version: ping.version,
      approvals: withProposals(approvals, proposals),
      activity,
      agents,
      accounts,
      pauses,
      error: null,
    };
  } catch (error) {
    return {
      ...previous,
      error: `Can't reach heel at ${config.adminSocketPath}: ${(error as Error).message}. Retrying.`,
    };
  }
}

function openInBrowser(url: string): void {
  const [command, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(command, args, { detached: true, stdio: "ignore" })
      .on("error", () => {})
      .unref();
  } catch {
    // The URL is on screen; over SSH there may be no browser to open.
  }
}

const EMPTY: TuiData = {
  version: null,
  approvals: [],
  activity: [],
  agents: [],
  accounts: [],
  pauses: [],
  error: null,
};

/** The loop: alternate screen, a refresh every two seconds, keys from stdin. */
export async function runTui(config: HeelConfig): Promise<number> {
  const { stdin, stdout } = process;
  const color = process.env["NO_COLOR"] === undefined;
  let data = await load(config, EMPTY);
  let state = INITIAL_STATE;
  const paint = () => {
    stdout.write(
      `\u001b[H\u001b[2J${renderTui(data, state, { columns: stdout.columns ?? 100, rows: stdout.rows ?? 30 }, new Date(), color)}`,
    );
  };
  const { emitKeypressEvents } = await import("node:readline");
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdout.write("\u001b[?1049h\u001b[?25l");
  paint();
  return new Promise<number>((resolve) => {
    const timer = setInterval(async () => {
      data = await load(config, data);
      paint();
    }, 2000);
    const done = () => {
      clearInterval(timer);
      stdin.setRawMode(false);
      stdin.off("keypress", onKey);
      stdin.pause();
      stdout.off("resize", paint);
      stdout.write("\u001b[?25h\u001b[?1049l");
      resolve(0);
    };
    const onKey = async (
      text: string | undefined,
      key: { name?: string; ctrl?: boolean } | undefined,
    ) => {
      if (key?.ctrl === true && key.name === "c") return done();
      const name = key?.name ?? text ?? "";
      const result = handleKey(state, name, data);
      state = result.state;
      if (result.effect?.kind === "quit") return done();
      if (result.effect?.kind === "open") openInBrowser(result.effect.url);
      if (result.effect?.kind === "pause") {
        try {
          await call(config, {
            method: "pause",
            params: { scope: "agent", name: result.effect.agent },
          });
          state = {
            ...state,
            message: `Paused ${result.effect.agent}. Resume it from the web app with your passkey.`,
          };
        } catch (error) {
          state = { ...state, message: `Couldn't pause: ${(error as Error).message}` };
        }
        data = await load(config, data);
      }
      paint();
    };
    stdin.on("keypress", onKey);
    stdout.on("resize", paint);
  });
}
