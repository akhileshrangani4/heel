import { createHash, generateKeyPairSync, type KeyObject, randomBytes, sign } from "node:crypto";
import type {
  AuthenticationResponseJSON,
  PublicKeyCredentialCreationOptionsJSON,
  PublicKeyCredentialRequestOptionsJSON,
  RegistrationResponseJSON,
} from "@simplewebauthn/server";

/** The subset of CBOR a `none` attestation needs: unsigned/negative ints, bytes, text, maps. */
type Cbor = number | string | Uint8Array | ReadonlyMap<Cbor, Cbor>;

function cborHead(major: number, length: number): Buffer {
  if (length < 24) return Buffer.from([(major << 5) | length]);
  if (length < 0x100) return Buffer.from([(major << 5) | 24, length]);
  if (length < 0x10000) {
    const head = Buffer.alloc(3);
    head[0] = (major << 5) | 25;
    head.writeUInt16BE(length, 1);
    return head;
  }
  const head = Buffer.alloc(5);
  head[0] = (major << 5) | 26;
  head.writeUInt32BE(length, 1);
  return head;
}

export function cbor(value: Cbor): Buffer {
  if (typeof value === "number") {
    return value >= 0 ? cborHead(0, value) : cborHead(1, -1 - value);
  }
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([cborHead(3, text.length), text]);
  }
  if (value instanceof Uint8Array) return Buffer.concat([cborHead(2, value.length), value]);
  const parts = [cborHead(5, value.size)];
  for (const [key, item] of value) parts.push(cbor(key), cbor(item));
  return Buffer.concat(parts);
}

const sha256 = (data: Uint8Array | string): Buffer => createHash("sha256").update(data).digest();
const b64u = (data: Uint8Array): string => Buffer.from(data).toString("base64url");

export interface SoftAuthenticatorOptions {
  /** Report user verification (the UV flag). Default true. */
  userVerified?: boolean;
}

/**
 * A software WebAuthn authenticator for tests: one ES256 discoverable
 * credential, `none` attestation, a signature counter. It signs whatever
 * challenge it is handed for whatever origin the test names, so tests can
 * prove the server checks both.
 */
export class SoftAuthenticator {
  readonly credentialId: Buffer = randomBytes(16);
  readonly #privateKey: KeyObject;
  readonly #publicKey: KeyObject;
  #counter = 0;
  #userHandle: string | null = null;

  constructor() {
    const pair = generateKeyPairSync("ec", { namedCurve: "P-256" });
    this.#privateKey = pair.privateKey;
    this.#publicKey = pair.publicKey;
  }

  get id(): string {
    return b64u(this.credentialId);
  }

  #coseKey(): Buffer {
    const jwk = this.#publicKey.export({ format: "jwk" });
    if (jwk.x === undefined || jwk.y === undefined) throw new Error("EC key has no coordinates");
    return cbor(
      new Map<Cbor, Cbor>([
        [1, 2], // kty: EC2
        [3, -7], // alg: ES256
        [-1, 1], // crv: P-256
        [-2, Buffer.from(jwk.x, "base64url")],
        [-3, Buffer.from(jwk.y, "base64url")],
      ]),
    );
  }

  #authData(rpId: string, flags: number, attested: boolean): Buffer {
    const counter = Buffer.alloc(4);
    counter.writeUInt32BE(this.#counter);
    const parts = [sha256(rpId), Buffer.from([flags]), counter];
    if (attested) {
      const idLength = Buffer.alloc(2);
      idLength.writeUInt16BE(this.credentialId.length);
      parts.push(Buffer.alloc(16), idLength, this.credentialId, this.#coseKey());
    }
    return Buffer.concat(parts);
  }

  /** `navigator.credentials.create` for these options, as the page would post it. */
  register(
    options: PublicKeyCredentialCreationOptionsJSON,
    origin: string,
    settings: SoftAuthenticatorOptions = {},
  ): RegistrationResponseJSON {
    this.#userHandle = options.user.id;
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.create", challenge: options.challenge, origin }),
    );
    // UP, AT, and UV unless told otherwise.
    const flags = 0x01 | 0x40 | (settings.userVerified === false ? 0 : 0x04);
    const authData = this.#authData(options.rp.id ?? new URL(origin).hostname, flags, true);
    const attestationObject = cbor(
      new Map<Cbor, Cbor>([
        ["fmt", "none"],
        ["attStmt", new Map()],
        ["authData", authData],
      ]),
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        attestationObject: b64u(attestationObject),
        transports: ["internal"],
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
    };
  }

  /** `navigator.credentials.get` for these options. */
  assert(
    options: Pick<PublicKeyCredentialRequestOptionsJSON, "challenge" | "rpId">,
    origin: string,
    settings: SoftAuthenticatorOptions = {},
  ): AuthenticationResponseJSON {
    this.#counter += 1;
    const clientDataJSON = Buffer.from(
      JSON.stringify({ type: "webauthn.get", challenge: options.challenge, origin }),
    );
    const flags = 0x01 | (settings.userVerified === false ? 0 : 0x04);
    const authData = this.#authData(options.rpId ?? new URL(origin).hostname, flags, false);
    const signature = sign(
      "sha256",
      Buffer.concat([authData, sha256(clientDataJSON)]),
      this.#privateKey,
    );
    return {
      id: this.id,
      rawId: this.id,
      type: "public-key",
      response: {
        clientDataJSON: b64u(clientDataJSON),
        authenticatorData: b64u(authData),
        signature: b64u(signature),
        ...(this.#userHandle === null ? {} : { userHandle: this.#userHandle }),
      },
      authenticatorAttachment: "platform",
      clientExtensionResults: {},
    };
  }
}
