import type { SignInSetup } from "../../definitions/sign-in-setup.ts";
import type { Coverage } from "../../requests/coverage.ts";
import type { AgentRequestStatus } from "../../store/schema.ts";
import { ceremonyButton } from "./ceremony.ts";
import { formatRelative } from "./format.ts";
import { type Html, html } from "./html.ts";
import { badge, type FormTarget, notice, postForm, type Tone, time } from "./layout.ts";

/** One waiting connection request, as the Approvals list shows it. */
export interface RequestCard {
  id: string;
  agent: string;
  /** heel's words: "Gmail", "the MCP server at mcp.example.com". */
  service: string;
  why: string | null;
  createdAt: Date;
  expiresAt: Date;
}

const STATUS: Record<AgentRequestStatus, { label: string; tone: Tone | "muted" }> = {
  pending: { label: "Connection request", tone: "warn" },
  approved: { label: "Connected", tone: "ok" },
  rejected: { label: "Rejected", tone: "muted" },
  superseded: { label: "Replaced", tone: "muted" },
  expired: { label: "Expired", tone: "muted" },
};

/** Connection requests waiting for this person, on the Approvals page. */
export function requestCards(cards: readonly RequestCard[], now: Date): Html | "" {
  if (cards.length === 0) return "";
  return html`<h2 class="section-title">Connection requests</h2>
    <ul class="req-list" aria-label="Connection requests">
      ${cards.map(
        (card) => html`<li class="card req" data-status="pending">
          <div class="ap-meta">
            ${badge(STATUS.pending.label, STATUS.pending.tone)}
            <span class="ap-agent">${card.agent}</span>
            <span class="muted">${formatRelative(card.createdAt, now)}</span>
          </div>
          <h2 class="req-title">
            <a href="/requests/${encodeURIComponent(card.id)}"
              >${card.agent} asks you to connect <mark>${card.service}</mark></a
            >
          </h2>
          ${
            card.why === null
              ? ""
              : html`<p class="req-reason"><span class="muted">${card.agent} says:</span> ${card.why}</p>`
          }
          <p class="req-foot muted">
            Expires ${formatRelative(card.expiresAt, now)} · <span class="mono">${card.id}</span>
          </p>
        </li>`,
      )}
    </ul>`;
}

export interface RequestPageProps {
  id: string;
  agent: string;
  status: AgentRequestStatus;
  service: string;
  provider: string;
  /** The agent's choice of name; how rules and tools will name the account. */
  alias: string;
  /** For an MCP server: its full URL, shown as is. */
  url: string | null;
  /** For an MCP server: whether it signs in with OAuth. */
  oauth: boolean;
  why: string | null;
  createdAt: Date;
  expiresAt: Date;
  decision: { by: string; at: Date } | null;
  now: Date;
  /** The owner's rules and the agent's grants that would cover the account. */
  coverage: Coverage;
  /** Why it can't be connected as asked (the name is taken), or null. */
  problem: string | null;
  /** Sign-in this heel can't do yet for the provider. */
  setup: SignInSetup | null;
  /** Binds the passkey to exactly what's shown. */
  hash: string;
  reject: FormTarget;
  /** After approving: the form that starts the account's sign-in, when it needs one. */
  signIn: FormTarget | null;
  outcome: "approved" | "rejected" | null;
  /** For a service that uses a key: what key it takes. The owner pastes it here, never the agent. */
  key: { hint: string } | null;
}

function coverageView(props: RequestPageProps): Html {
  const { rules, mode } = props.coverage;
  return html`<section class="card">
    <h2 class="section-title">What ${props.agent} could do with it</h2>
    ${
      rules.length === 0
        ? html`<p>
            None of your rules, and none of ${props.agent}'s grants, cover
            <span class="mono">${props.alias}</span>, so every call on it would be denied until you
            add a rule for it.
          </p>`
        : html`<p>
              These cover <span class="mono">${props.alias}</span> as soon as it's connected, for
              the calls they match:
            </p>
            <dl class="facts">
              ${rules.map(
                (r) => html`<dt>${r.rule}</dt>
                  <dd>
                    <strong>${r.decision === "allow" ? "runs" : "asks you"}</strong>
                    <span class="muted"
                      >· ${r.namesIt ? "names this account" : "names no account, so it covers every one"}</span
                    >
                  </dd>`,
              )}
            </dl>`
    }
    ${
      mode === "watch"
        ? notice(
            "warn",
            html`<p>
              Your mode is Watch: calls your rules would deny or ask about run anyway. Switch to
              Enforce on the Modes page before you connect this if that's not what you want.
            </p>`,
          )
        : ""
    }
    <p class="muted">Change your rules first if that's more than you want.</p>
  </section>`;
}

/** One request: what the agent asks for, what it would let the agent do, and the controls. */
export function requestPage(props: RequestPageProps): Html {
  const status = STATUS[props.status];
  const pending = props.status === "pending" && props.expiresAt > props.now;
  const outcome =
    props.outcome === "approved" && props.status === "approved"
      ? notice(
          "ok",
          props.signIn === null
            ? html`<p>Connected as <span class="mono">${props.alias}</span>.</p>`
            : html`<p>
                Added as <span class="mono">${props.alias}</span>. Sign in now so heel can use it;
                ${props.agent} never sees what you sign in with.
              </p>`,
        )
      : props.outcome === "rejected" && props.status === "rejected"
        ? notice("info", html`<p>Rejected. Nothing was connected.</p>`)
        : "";
  return html`${outcome}
    <header class="card ap-head">
      <div class="ap-meta">
        <span class="ap-agent">${props.agent}</span>
        <span class="muted">${formatRelative(props.createdAt, props.now)}</span>
        ${badge(status.label, status.tone)}
      </div>
      <h1 class="ap-title">${props.agent} asks you to connect ${props.service}</h1>
      <p>
        As <span class="mono">${props.alias}</span>
        <span class="muted">(the name ${props.agent} chose; rules and tools will use it)</span>
      </p>
      ${
        props.url === null
          ? ""
          : html`<p>
              Server: <span class="mono">${props.url}</span>
              <span class="muted">
                · ${props.oauth ? "you sign in on its own page next" : "no sign-in"}. Check this is
                a server you trust: heel will send ${props.agent}'s calls to it.
              </span>
            </p>`
      }
      ${
        props.why === null
          ? ""
          : html`<figure class="reason">
              <figcaption>${props.agent} says (its own words; heel didn't check them)</figcaption>
              <blockquote>${props.why}</blockquote>
            </figure>`
      }
    </header>
    ${pending ? coverageView(props) : ""}
    ${
      pending && props.problem !== null
        ? notice(
            "error",
            html`<p><strong>This can't be connected as asked.</strong></p><p>${props.problem}</p>`,
          )
        : ""
    }
    ${
      pending && props.setup !== null
        ? notice(
            "warn",
            html`<p>
              Sign-in with ${props.setup.label} isn't set up on this heel, so you won't be able to
              sign in after approving. Set <span class="mono">${props.setup.configKey}</span>:
              <a href="${props.setup.docsUrl}">how</a>.
            </p>`,
          )
        : ""
    }
    ${
      props.decision === null
        ? ""
        : html`<p class="muted">${status.label} by ${props.decision.by} ${time(props.decision.at)}</p>`
    }
    ${
      props.status === "approved" && props.signIn !== null
        ? postForm(
            props.signIn,
            { alias: props.alias },
            html`<button type="submit" class="btn btn-primary">Sign in to ${props.service}</button>`,
          )
        : ""
    }
    ${
      pending
        ? html`<div class="decide">
            ${
              props.problem === null && props.key !== null
                ? html`<fieldset id="request-key">
                    <label for="request-key-input"
                      ><strong>Your ${props.service} key</strong></label
                    >
                    <input
                      id="request-key-input"
                      name="key"
                      type="password"
                      autocomplete="new-password"
                      data-1p-ignore
                      data-lpignore="true"
                      data-bwignore
                      spellcheck="false"
                      required
                    />
                    <p class="muted">
                      ${props.key.hint} It goes to heel's vault only: ${props.agent} never sees it,
                      and only gets the account by its name.
                    </p>
                  </fieldset>`
                : ""
            }
            ${
              props.problem === null
                ? ceremonyButton({
                    callback: { handler: "approveConnection" },
                    intent: "connect",
                    label: "Connect it",
                    tone: "primary",
                    binding: { requestId: props.id, hash: props.hash },
                    describedBy: "request-passkey",
                    ...(props.key === null ? {} : { optionsFrom: "request-key" }),
                  })
                : ""
            }
            ${postForm(props.reject, {}, html`<button type="submit" class="btn btn-secondary">Reject</button>`)}
            <p id="request-passkey" class="muted">
              Connecting asks for your passkey. Nothing is connected, and nothing is contacted,
              until you do. Requests expire ${formatRelative(props.expiresAt, props.now)}.
            </p>
          </div>`
        : ""
    }`;
}
