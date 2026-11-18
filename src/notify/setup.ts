import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { WebClient } from "@slack/web-api";
import { createTransport } from "nodemailer";
import { generateVAPIDKeys, sendNotification, type VapidKeys } from "web-push";
import { z } from "zod";
import type { NotifyConfig } from "../config/schema.ts";
import { type ChannelSender, emailSender, slackSender, webPushSender } from "./channels.ts";

/**
 * Builds the senders `heel.yaml` turns on (spec: Notifications), reading
 * their secrets the same way as the SIEM token: from a file, with an
 * environment variable taking precedence.
 */

const VapidFileSchema = z.strictObject({
  publicKey: z.string().min(1),
  privateKey: z.string().min(1),
});

/**
 * The install's VAPID key pair. Created on first boot and kept in a file
 * only heel's user can read; browsers bind each push subscription to the
 * public key, so the pair must outlive restarts.
 */
export function loadOrCreateVapidKeys(file: string): VapidKeys {
  if (existsSync(file)) return VapidFileSchema.parse(JSON.parse(readFileSync(file, "utf8")));
  const keys = generateVAPIDKeys();
  writeFileSync(file, `${JSON.stringify(keys, null, 2)}\n`, { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return keys;
}

function secretFrom(
  env: Readonly<Record<string, string | undefined>>,
  variable: string,
  file: string | null,
): string | null {
  const fromEnv = env[variable];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return file === null ? null : readFileSync(file, "utf8").trim();
}

export interface NotifySetup {
  senders: ChannelSender[];
  /** The VAPID public key the approval page subscribes devices with. */
  vapidPublicKey: string;
}

export function notifySetup(
  config: NotifyConfig,
  env: Readonly<Record<string, string | undefined>>,
): NotifySetup {
  const keys = loadOrCreateVapidKeys(config.webPush.keyFile);
  const senders: ChannelSender[] = [
    webPushSender({ keys, subject: config.webPush.subject, send: sendNotification }),
  ];
  if (config.email !== null) {
    const { host, port, tls, username, passwordFile, from } = config.email;
    const password = secretFrom(env, "HEEL_SMTP_PASSWORD", passwordFile);
    const transport = createTransport({
      host,
      port,
      secure: tls,
      // Without implicit TLS, refuse to send unless the server upgrades with STARTTLS.
      requireTLS: !tls,
      ...(username !== null && password !== null && { auth: { user: username, pass: password } }),
    });
    senders.push(emailSender({ transport, from }));
  }
  if (config.slack !== null) {
    const token = secretFrom(env, "HEEL_SLACK_TOKEN", config.slack.tokenFile);
    if (token !== null) senders.push(slackSender({ client: new WebClient(token) }));
  }
  return { senders, vapidPublicKey: keys.publicKey };
}
