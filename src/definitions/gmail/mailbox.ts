import type { Hiding } from "../../core/hide.ts";
import { normalizeAddress } from "../../core/rules/address.ts";
import type { GmailClient, GmailLabel, GmailMessage, MessageFormat } from "./client.ts";
import { hideCandidate, type MessageBody, messageBody } from "./messages.ts";

/**
 * One call's view of a Gmail mailbox: the client, plus what several tools
 * need to read once per call (the label table and the send-as addresses)
 * and the hidden-message test every by-id tool uses.
 */
export class Mailbox {
  readonly client: GmailClient;
  #labels: Promise<Map<string, GmailLabel>> | null = null;
  #sendAs: Promise<Set<string>> | null = null;

  constructor(client: GmailClient) {
    this.client = client;
  }

  labelTable(signal: AbortSignal): Promise<Map<string, GmailLabel>> {
    this.#labels ??= this.client
      .listLabels(signal)
      .then((list) => new Map(list.map((label) => [label.id, label])));
    return this.#labels;
  }

  /** The addresses this mailbox may send as, normalized (research §2.1, `sendAs.list`). */
  sendAs(signal: AbortSignal): Promise<Set<string>> {
    this.#sendAs ??= this.client
      .listSendAs(signal)
      .then(
        (list) =>
          new Set(
            list.map((address) => normalizeAddress(address)).filter((a): a is string => a !== null),
          ),
      );
    return this.#sendAs;
  }

  /** Whether a message is hidden. A message heel can't judge is. */
  async isHidden(
    message: GmailMessage,
    format: MessageFormat,
    hiding: Hiding,
    signal: AbortSignal,
  ): Promise<boolean> {
    if (hiding.entries.length === 0) return false;
    let body: MessageBody | undefined;
    if (hiding.needsBody) {
      const full =
        format === "full" ? message : await this.client.getMessage(message.id, "full", signal);
      body = messageBody(full);
    }
    const candidate = hideCandidate(message, await this.labelTable(signal), body);
    return candidate === null || hiding.isHidden(candidate);
  }

  /**
   * Reads a message a call is aimed at, and whether it's hidden: the read
   * every by-id tool makes before rules run (I-42).
   */
  async target(
    id: string,
    hiding: Hiding,
    signal: AbortSignal,
  ): Promise<{ message: GmailMessage; hidden: boolean }> {
    const format: MessageFormat = hiding.needsBody ? "full" : "metadata";
    const message = await this.client.getMessage(id, format, signal);
    return { message, hidden: await this.isHidden(message, format, hiding, signal) };
  }

  async labelNames(message: GmailMessage, signal: AbortSignal): Promise<string[]> {
    const table = await this.labelTable(signal);
    return message.labelIds.map((id) => table.get(id)?.name ?? id);
  }
}
