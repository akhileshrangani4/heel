/**
 * The certificate authority for one sandbox (spec: CLI runner, "Credential
 * delivery"). heel's egress proxy terminates TLS for the hosts a credential
 * goes to, so it can add the credential on the wire; the sandbox trusts this
 * CA for those hosts and for nothing else.
 *
 * - One CA per sandbox, ECDSA P-256. Its private key lives only in heel's
 *   memory and dies with the proxy; nothing writes it to disk.
 * - The CA is name-constrained to exactly the credential hosts: a leaf for
 *   any other name or address fails verification even if the key leaked.
 * - Leaves are made on demand, one per host, and cached for the CA's life.
 */
import "reflect-metadata";
import { randomBytes, webcrypto } from "node:crypto";
import { isIP } from "node:net";
import { getCACertificates } from "node:tls";
import * as x509 from "@peculiar/x509";

x509.cryptoProvider.set(webcrypto as Crypto);

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
/** Longer than the runner's longest wall time (about 24.8 days), so no sandbox outlives its CA. */
const LIFETIME_MS = 30 * 24 * 60 * 60 * 1000;
/** Some slack for a clock that runs a little behind. */
const BACKDATE_MS = 60 * 60 * 1000;
const NAME_CONSTRAINTS_OID = "2.5.29.30";

export interface LeafCertificate {
  /** PEM. */
  readonly cert: string;
  /** PEM, PKCS#8. */
  readonly key: string;
}

export interface SandboxCa {
  /** The CA certificate, PEM. */
  readonly certificate: string;
  /** The hosts (lower-case names or IP literals) the CA may sign for. */
  readonly hosts: readonly string[];
  /** A certificate for `host`, which must be one of `hosts`. */
  leaf(host: string): Promise<LeafCertificate>;
}

export class SandboxCaError extends Error {
  override readonly name = "SandboxCaError";
}

/** Creates a CA that can sign only for `hosts` (names or IP literals, no ports). */
export async function createSandboxCa(hosts: readonly string[]): Promise<SandboxCa> {
  const names = [...new Set(hosts.map((host) => host.toLowerCase()))];
  if (names.length === 0) throw new SandboxCaError("a sandbox CA needs at least one host");
  for (const name of names) {
    if (name === "" || /[^a-z0-9.:-]/.test(name)) {
      throw new SandboxCaError(`can't make a certificate for ${JSON.stringify(name)}`);
    }
  }
  const keys = await generateKeys();
  const now = Date.now();
  const validity = {
    notBefore: new Date(now - BACKDATE_MS),
    notAfter: new Date(now + LIFETIME_MS),
  };
  const ca = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: serial(),
    name: "CN=heel sandbox CA, O=heel",
    ...validity,
    keys,
    signingAlgorithm: ALGORITHM,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
      new x509.Extension(NAME_CONSTRAINTS_OID, true, nameConstraints(names)),
      await x509.SubjectKeyIdentifierExtension.create(keys.publicKey),
    ],
  });

  const leaves = new Map<string, Promise<LeafCertificate>>();
  async function makeLeaf(host: string): Promise<LeafCertificate> {
    const leafKeys = await generateKeys();
    const cert = await x509.X509CertificateGenerator.create({
      serialNumber: serial(),
      subject: isIP(host) === 0 ? `CN=${host}` : "CN=heel sandbox",
      issuer: ca.subject,
      ...validity,
      publicKey: leafKeys.publicKey,
      signingKey: keys.privateKey,
      signingAlgorithm: ALGORITHM,
      extensions: [
        new x509.BasicConstraintsExtension(false, undefined, true),
        new x509.KeyUsagesExtension(x509.KeyUsageFlags.digitalSignature, true),
        new x509.ExtendedKeyUsageExtension([x509.ExtendedKeyUsage.serverAuth]),
        new x509.SubjectAlternativeNameExtension([
          { type: isIP(host) === 0 ? "dns" : "ip", value: host },
        ]),
        await x509.AuthorityKeyIdentifierExtension.create(keys.publicKey),
      ],
    });
    const pkcs8 = Buffer.from(await webcrypto.subtle.exportKey("pkcs8", leafKeys.privateKey));
    return { cert: cert.toString("pem"), key: pem("PRIVATE KEY", pkcs8) };
  }

  return {
    certificate: ca.toString("pem"),
    hosts: names,
    leaf(host) {
      const name = host.toLowerCase();
      if (!names.includes(name)) {
        return Promise.reject(new SandboxCaError(`the sandbox CA doesn't sign for ${name}`));
      }
      let pending = leaves.get(name);
      if (pending === undefined) {
        pending = makeLeaf(name);
        leaves.set(name, pending);
      }
      return pending;
    },
  };
}

/**
 * What the sandbox trusts: the host's own roots (so hosts heel tunnels
 * without looking inside still verify) plus this sandbox's CA.
 */
export function trustBundle(caCertificate: string): string {
  return `${[...hostRoots(), caCertificate].map((cert) => cert.trim()).join("\n")}\n`;
}

/** The host's system roots and Node's bundled ones, deduplicated. */
export function hostRoots(): string[] {
  return [...new Set([...getCACertificates("system"), ...getCACertificates("bundled")])];
}

type KeyPair = webcrypto.CryptoKeyPair;

async function generateKeys(): Promise<KeyPair> {
  return (await webcrypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"])) as KeyPair;
}

/** 16 random bytes, positive as DER requires. */
function serial(): string {
  const bytes = randomBytes(16);
  bytes[0] = (bytes[0] as number) & 0x7f;
  return bytes.toString("hex");
}

function pem(label: string, der: Buffer): string {
  const lines = der.toString("base64").match(/.{1,64}/g) ?? [];
  return `-----BEGIN ${label}-----\n${lines.join("\n")}\n-----END ${label}-----\n`;
}

/**
 * NameConstraints (RFC 5280 4.2.1.10) permitting only `hosts`. Constraints
 * apply per name type, so each type always gets an entry: when no host is an
 * IP address, the only one permitted is the unspecified address, which no
 * server holds, and likewise `heel.invalid` (RFC 6761) for names.
 */
export function nameConstraints(hosts: readonly string[]): Uint8Array {
  const dns = hosts.filter((host) => isIP(host) === 0);
  const ips = hosts.filter((host) => isIP(host) !== 0);
  const subtrees: Buffer[] = [];
  for (const name of dns.length > 0 ? dns : ["heel.invalid"]) {
    // GeneralName dNSName: [2] IMPLICIT IA5String.
    subtrees.push(der(0x30, der(0x82, Buffer.from(name, "ascii"))));
  }
  for (const ip of ips.length > 0 ? ips : ["0.0.0.0", "::"]) {
    const address = ipBytes(ip);
    // GeneralName iPAddress: [7] IMPLICIT OCTET STRING, the address then an all-ones mask.
    const mask = Buffer.alloc(address.length, 0xff);
    subtrees.push(der(0x30, der(0x87, Buffer.concat([address, mask]))));
  }
  // NameConstraints ::= SEQUENCE { permittedSubtrees [0] GeneralSubtrees }
  return new Uint8Array(der(0x30, der(0xa0, Buffer.concat(subtrees))));
}

function der(tag: number, body: Buffer): Buffer {
  const length = body.length;
  let header: number[];
  if (length < 0x80) header = [length];
  else if (length < 0x100) header = [0x81, length];
  else if (length < 0x10000) header = [0x82, length >> 8, length & 0xff];
  else throw new SandboxCaError("name constraints too long");
  return Buffer.concat([Buffer.from([tag, ...header]), body]);
}

/** The bytes of an IPv4 (4) or IPv6 (16) literal. */
export function ipBytes(ip: string): Buffer {
  if (isIP(ip) === 4) return Buffer.from(ip.split(".").map(Number));
  if (isIP(ip) !== 6) throw new SandboxCaError(`not an IP address: ${ip}`);
  // An embedded IPv4 tail (::ffff:1.2.3.4) is the last two groups.
  const text = ip.replace(/(\d+)\.(\d+)\.(\d+)\.(\d+)$/, (_, a, b, c, d) =>
    [(Number(a) << 8) | Number(b), (Number(c) << 8) | Number(d)]
      .map((n) => n.toString(16))
      .join(":"),
  );
  const [head = "", rest] = text.split("::");
  const left = head === "" ? [] : head.split(":");
  const right = rest === undefined || rest === "" ? [] : rest.split(":");
  const fill = rest === undefined ? 0 : 8 - left.length - right.length;
  const groups = [...left, ...new Array<string>(fill).fill("0"), ...right].map((g) =>
    Number.parseInt(g, 16),
  );
  const bytes = Buffer.alloc(16);
  for (const [i, group] of groups.entries()) bytes.writeUInt16BE(group, i * 2);
  return bytes;
}
