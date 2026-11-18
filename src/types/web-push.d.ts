/**
 * The parts of `web-push` 4.0 that heel uses. The package ships no type
 * declarations; these match its source (src/index.js, web-push-lib.js and
 * web-push-error.js).
 */
declare module "web-push" {
  export interface PushSubscription {
    endpoint: string;
    keys: { p256dh: string; auth: string };
  }

  export interface VapidKeys {
    publicKey: string;
    privateKey: string;
  }

  export interface SendOptions {
    vapidDetails?: { subject: string; publicKey: string; privateKey: string };
    /** Seconds the push service keeps the message for an offline device. */
    TTL?: number;
    urgency?: "very-low" | "low" | "normal" | "high";
    /** Milliseconds before the request to the push service is abandoned. */
    timeout?: number;
  }

  export interface SendResult {
    statusCode: number;
    body: string;
    headers: Record<string, string>;
  }

  export class WebPushError extends Error {
    statusCode: number;
    headers: Record<string, string>;
    body: string;
    endpoint: string;
  }

  export function generateVAPIDKeys(): VapidKeys;
  export function sendNotification(
    subscription: PushSubscription,
    payload: string,
    options?: SendOptions,
  ): Promise<SendResult>;
}
