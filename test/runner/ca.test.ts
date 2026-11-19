import "reflect-metadata";
import { execFileSync } from "node:child_process";
import { webcrypto } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect, createServer } from "node:tls";
import { fileURLToPath } from "node:url";
import * as x509 from "@peculiar/x509";
import { describe, expect, it, vi } from "vitest";
import { createSandboxCa, ipBytes, nameConstraints, trustBundle } from "../../src/runner/ca.ts";

const ALG = { name: "ECDSA", namedCurve: "P-256", hash: "SHA-256" } as const;
type Keys = webcrypto.CryptoKeyPair;

/** A handshake to a server holding `cert`/`key`, verifying it for `host` against `ca`. */
async function verifies(
  ca: string,
  leaf: { cert: string; key: string },
  host: string,
): Promise<string> {
  const server = createServer({ cert: leaf.cert, key: leaf.key }, (socket) => socket.end());
  server.on("tlsClientError", () => {});
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  try {
    return await new Promise<string>((resolve) => {
      const socket = connect(
        {
          port: address.port,
          host: "127.0.0.1",
          ...(isIP(host) === 0 ? { servername: host } : {}),
          ca,
          checkServerIdentity: () => undefined,
        },
        () => {
          socket.destroy();
          resolve("ok");
        },
      );
      socket.on("error", (error: Error & { code?: string }) =>
        resolve(error.code ?? error.message),
      );
    });
  } finally {
    server.close();
  }
}

/** A CA of the test's own, with or without name constraints, that will sign anything. */
async function testCa(constraints: readonly string[] | null) {
  const keys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as Keys;
  const validity = {
    notBefore: new Date(Date.now() - 60_000),
    notAfter: new Date(Date.now() + 3_600_000),
  };
  const cert = await x509.X509CertificateGenerator.createSelfSigned({
    serialNumber: "01",
    name: "CN=test CA",
    ...validity,
    keys,
    signingAlgorithm: ALG,
    extensions: [
      new x509.BasicConstraintsExtension(true, 0, true),
      new x509.KeyUsagesExtension(x509.KeyUsageFlags.keyCertSign, true),
      ...(constraints === null
        ? []
        : [new x509.Extension("2.5.29.30", true, nameConstraints(constraints))]),
    ],
  });
  return {
    pem: cert.toString("pem"),
    async sign(host: string) {
      const leafKeys = (await webcrypto.subtle.generateKey(ALG, true, ["sign", "verify"])) as Keys;
      const leaf = await x509.X509CertificateGenerator.create({
        serialNumber: "02",
        subject: "CN=leaf",
        issuer: cert.subject,
        ...validity,
        publicKey: leafKeys.publicKey,
        signingKey: keys.privateKey,
        signingAlgorithm: ALG,
        extensions: [
          new x509.SubjectAlternativeNameExtension([
            { type: isIP(host) === 0 ? "dns" : "ip", value: host },
          ]),
        ],
      });
      const pkcs8 = Buffer.from(
        await webcrypto.subtle.exportKey("pkcs8", leafKeys.privateKey),
      ).toString("base64");
      return {
        cert: leaf.toString("pem"),
        key: `-----BEGIN PRIVATE KEY-----\n${pkcs8}\n-----END PRIVATE KEY-----\n`,
      };
    },
  };
}

describe("nameConstraints", () => {
  it.each([
    ["a name outside them", ["api.github.com"], "evil.test"],
    ["a subdomain-looking name that isn't one", ["github.com"], "evilgithub.com"],
    ["a real subdomain (RFC 5280 would permit it)", ["github.com"], "uploads.github.com"],
    ["a deeper subdomain", ["github.com"], "a.b.github.com"],
    ["another IP address", ["127.0.0.1"], "127.0.0.2"],
    ["any IP address, when only names are listed", ["api.github.com"], "127.0.0.1"],
    ["any name, when only addresses are listed", ["127.0.0.1"], "api.github.com"],
  ] as const)("a CA bound by them can't vouch for %s", async (_, hosts, host) => {
    const bound = await testCa(hosts);
    const free = await testCa(null);
    // The control: without constraints, the same kind of leaf verifies.
    expect(await verifies(free.pem, await free.sign(host), host)).toBe("ok");
    expect(await verifies(bound.pem, await bound.sign(host), host)).not.toBe("ok");
  });

  it.each([["api.github.com"], ["127.0.0.1"], ["::1"]])(
    "still vouches for %s itself",
    async (host) => {
      const bound = await testCa(["api.github.com", "127.0.0.1", "::1"]);
      expect(await verifies(bound.pem, await bound.sign(host), host)).toBe("ok");
    },
  );
});

describe("ipBytes", () => {
  it.each([
    ["127.0.0.1", "7f000001"],
    ["::1", "00000000000000000000000000000001"],
    ["2001:db8::8:1", "20010db8000000000000000000080001"],
    ["::ffff:10.0.0.1", "00000000000000000000ffff0a000001"],
    ["fe80::", "fe800000000000000000000000000000"],
  ])("%s", (ip, hex) => {
    expect(ipBytes(ip).toString("hex")).toBe(hex);
  });
});

describe("createSandboxCa", () => {
  it("gives api.github.com and github.com their own CAs, so neither covers the other's subdomains", async () => {
    const ca = await createSandboxCa(["github.com", "api.github.com"]);
    expect(await verifies(ca.certificate, await ca.leaf("github.com"), "github.com")).toBe("ok");
    expect(await verifies(ca.certificate, await ca.leaf("api.github.com"), "api.github.com")).toBe(
      "ok",
    );
    expect(ca.certificate.match(/BEGIN CERTIFICATE/g)?.length).toBe(2);
  });

  it("doesn't keep a leaf that failed to generate", async () => {
    const ca = await createSandboxCa(["a.test"]);
    const spy = vi
      .spyOn(webcrypto.subtle, "generateKey")
      .mockRejectedValueOnce(new Error("entropy ran out"));
    await expect(ca.leaf("a.test")).rejects.toThrow("entropy ran out");
    spy.mockRestore();
    expect(await verifies(ca.certificate, await ca.leaf("a.test"), "a.test")).toBe("ok");
  });

  it("makes leaves for its hosts that verify against it, and none for any other", async () => {
    const ca = await createSandboxCa(["API.GitHub.com", "127.0.0.1"]);
    expect(ca.hosts).toEqual(["api.github.com", "127.0.0.1"]);
    expect(await verifies(ca.certificate, await ca.leaf("api.github.com"), "api.github.com")).toBe(
      "ok",
    );
    expect(await verifies(ca.certificate, await ca.leaf("127.0.0.1"), "127.0.0.1")).toBe("ok");
    await expect(ca.leaf("github.com")).rejects.toThrow(/doesn't sign/);
    expect(await ca.leaf("api.github.com")).toBe(await ca.leaf("api.github.com"));
  });

  it("is a fresh CA each time, with a name-constrained, path-length-zero CA certificate", async () => {
    const [a, b] = await Promise.all([createSandboxCa(["a.test"]), createSandboxCa(["a.test"])]);
    expect(a.certificate).not.toBe(b.certificate);
    const cert = new x509.X509Certificate(a.certificate);
    expect(cert.getExtension(x509.BasicConstraintsExtension)).toMatchObject({
      ca: true,
      pathLength: 0,
    });
    expect(cert.getExtension("2.5.29.30")?.critical).toBe(true);
    // Another sandbox's leaf doesn't verify against this one's CA.
    expect(await verifies(a.certificate, await b.leaf("a.test"), "a.test")).not.toBe("ok");
  });

  it("refuses a host it couldn't name", async () => {
    await expect(createSandboxCa([])).rejects.toThrow();
    await expect(createSandboxCa(["a b"])).rejects.toThrow();
  });
});

describe("trustBundle", () => {
  it("includes the roots heel itself was given in NODE_EXTRA_CA_CERTS", async () => {
    const corporate = await createSandboxCa(["proxy.corp.example"]);
    const dir = mkdtempSync(join(tmpdir(), "heel-extra-ca-"));
    const file = join(dir, "corp.pem");
    writeFileSync(file, corporate.certificate);
    const ca = fileURLToPath(new URL("../../src/runner/ca.ts", import.meta.url));
    const script = `import("${ca}").then((m) => process.stdout.write(String(m.hostRoots().some((c) => c.includes(process.argv[1])))))`;
    const marker = corporate.certificate.split("\n")[3] ?? "";
    const out = execFileSync(process.execPath, ["-e", script, marker], {
      env: { ...process.env, NODE_EXTRA_CA_CERTS: file },
      encoding: "utf8",
    });
    expect(out).toBe("true");
  });

  it("holds the host's roots and the sandbox CA", async () => {
    const ca = await createSandboxCa(["a.test"]);
    const bundle = trustBundle(ca.certificate);
    expect(bundle).toContain(ca.certificate.trim());
    expect(bundle.match(/BEGIN CERTIFICATE/g)?.length).toBeGreaterThan(10);
  });
});
