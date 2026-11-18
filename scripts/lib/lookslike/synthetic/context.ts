/**
 * Seeded randomness and the per-message context the synthetic families draw
 * from. Every generated value (brand, host, person, code, token, URL) comes
 * from here, so the same seed always yields the same corpus.
 */
import { hash32 } from "../../../../src/core/lookslike/features.ts";

export interface Rng {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both inclusive. */
  int(min: number, max: number): number;
  pick<T>(items: readonly T[]): T;
  chance(p: number): boolean;
}

/** mulberry32, seeded from the string's hash32. Not for secrets: for reproducible corpora. */
export function makeRng(seed: string): Rng {
  let state = hash32(seed);
  const next = (): number => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return {
    next,
    int: (min, max) => min + Math.floor(next() * (max - min + 1)),
    pick: <T>(items: readonly T[]): T => {
      if (items.length === 0) throw new Error("pick from an empty list");
      return items[Math.floor(next() * items.length)] as T;
    },
    chance: (p) => next() < p,
  };
}

// Invented brands: none is meant to name a real company.
const BRANDS = [
  "Northwind",
  "Brightpath",
  "Lumora",
  "Quillstack",
  "Pinecrest Health",
  "Harborline",
  "Fernly",
  "Orbitdesk",
  "Cobaltcloud",
  "Meadowlark Books",
  "Sprocket",
  "Kitewing",
  "Atlas Learning",
  "Riverbend Credit Union",
  "Copperleaf",
  "Zephyr Notes",
  "Mosaic HR",
  "Bluefin",
  "Trellis",
  "Larkspur",
  "Driftwood Studio",
  "Emberly",
  "Granite Labs",
  "Hollow Oak",
  "Ironbark",
  "Jadeport",
  "Keystone CRM",
  "Saltmarsh",
  "Tidewater Games",
  "Wrenfield",
] as const;
const TLDS = [".com", ".io", ".app", ".co", ".dev", ".net"] as const;
const FIRST = [
  "Ana",
  "Ben",
  "Chloe",
  "Dmitri",
  "Elif",
  "Farah",
  "Gabriel",
  "Hana",
  "Ines",
  "Jamal",
  "Kenji",
  "Lena",
  "Mateo",
  "Nadia",
  "Owen",
  "Priya",
  "Quinn",
  "Rosa",
  "Sami",
  "Tomás",
  "Uma",
  "Viktor",
  "Wei",
  "Yara",
] as const;
const LAST = [
  "Adeyemi",
  "Becker",
  "Castillo",
  "Dubois",
  "Eriksen",
  "Fischer",
  "Gupta",
  "Hughes",
  "Ivanova",
  "Jensen",
  "Kowalski",
  "Lindqvist",
  "Moreau",
  "Nakamura",
  "Okafor",
  "Petrov",
  "Rossi",
  "Silva",
  "Tanaka",
  "Walsh",
] as const;
const MAIL_DOMAINS = [
  "gmail.com",
  "outlook.com",
  "fastmail.com",
  "proton.me",
  "example.org",
  "icloud.com",
] as const;
const SENDER_LOCAL_PARTS = [
  "no-reply",
  "noreply",
  "accounts",
  "support",
  "security",
  "hello",
  "notifications",
  "auth",
  "team",
  "info",
] as const;
const ALNUM = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
const UPPER_ALNUM = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const HEX = "0123456789abcdef";

export interface Person {
  first: string;
  last: string;
  email: string;
  username: string;
}

export interface Ctx {
  rng: Rng;
  brand: string;
  /** The brand's mail and web host, e.g. `northwind.io`. */
  host: string;
  /** Base URL of the brand's app, no trailing slash. */
  appUrl: string;
  /** Sender address, `Brand <local@host>`. */
  from: string;
  user: Person;
  /** A fresh address for flows that mention a second one. */
  otherEmail(): string;
  /** A one-time code in one of the shapes real services use. */
  code(): string;
  /** A random string over `alphabet` (URL-safe alphanumerics by default). */
  token(length: number, alphabet?: string): string;
  hex(length: number): string;
  /** A short expiry, e.g. "15 minutes" or "1 hour". */
  expiry(): string;
  minutes(choices: readonly number[]): number;
  ip(): string;
  when(): string;
  device(): { client: string; device: string; os: string };
}

function slug(brand: string): string {
  return brand.toLowerCase().replace(/[^a-z0-9]+/g, "");
}

export function makeContext(rng: Rng): Ctx {
  const brand = rng.pick(BRANDS);
  const host = `${slug(brand)}${rng.pick(TLDS)}`;
  const appUrl = `https://${rng.pick(["", "app.", "accounts.", "auth.", "id.", "my."])}${host}`;
  const first = rng.pick(FIRST);
  const last = rng.pick(LAST);
  const ascii = (s: string) =>
    s
      .normalize("NFKD")
      .replace(/[^A-Za-z]/g, "")
      .toLowerCase();
  const user: Person = {
    first,
    last,
    email: `${ascii(first)}.${ascii(last)}${rng.chance(0.3) ? rng.int(1, 99) : ""}@${rng.pick(MAIL_DOMAINS)}`,
    username: `${ascii(first)}${rng.chance(0.5) ? ascii(last).slice(0, 1) : ""}${rng.int(1, 999)}`,
  };
  const token = (length: number, alphabet: string = ALNUM): string => {
    let out = "";
    for (let i = 0; i < length; i += 1) out += alphabet[Math.floor(rng.next() * alphabet.length)];
    return out;
  };
  const digits = (n: number) => token(n, "0123456789");
  const code = (): string => {
    switch (rng.int(0, 9)) {
      case 0:
        return digits(8);
      case 1:
        return digits(4);
      case 2:
        return `${digits(3)}-${digits(3)}`;
      case 3:
        return `${digits(3)} ${digits(3)}`;
      case 4: {
        // Mixed letters and digits, at least one of each.
        const c = token(5, UPPER_ALNUM);
        return `${c}${/\d/.test(c) ? rng.pick(["K", "Q", "X"]) : rng.int(2, 9)}`;
      }
      case 5:
        return `${token(4, UPPER_ALNUM)}-${token(4, UPPER_ALNUM)}`;
      default:
        return digits(6);
    }
  };
  return {
    rng,
    brand,
    host,
    appUrl,
    from: `${brand} <${rng.pick(SENDER_LOCAL_PARTS)}@${host}>`,
    user,
    otherEmail: () =>
      `${ascii(rng.pick(FIRST))}.${ascii(rng.pick(LAST))}@${rng.pick(MAIL_DOMAINS)}`,
    code,
    token,
    hex: (length) => token(length, HEX),
    expiry: () =>
      rng.pick([
        "5 minutes",
        "10 minutes",
        "15 minutes",
        "30 minutes",
        "1 hour",
        "2 hours",
        "24 hours",
      ]),
    minutes: (choices) => rng.pick(choices),
    ip: () => `${rng.int(11, 223)}.${rng.int(0, 255)}.${rng.int(0, 255)}.${rng.int(1, 254)}`,
    when: () =>
      `${rng.pick(["Jan", "Mar", "May", "Jul", "Sep", "Nov"])} ${rng.int(1, 28)}, 2026 at ${String(rng.int(0, 23)).padStart(2, "0")}:${String(rng.int(0, 59)).padStart(2, "0")} UTC`,
    device: () => ({
      client: rng.pick(["Chrome 131", "Firefox 133", "Safari 18", "Edge 131"]),
      device: rng.pick(["Desktop", "iPhone", "Pixel 9", "MacBook Pro"]),
      os: rng.pick(["Windows 11", "macOS 15", "iOS 18", "Android 15", "Ubuntu 24.04"]),
    }),
  };
}
