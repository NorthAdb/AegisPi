import { createSign, generateKeyPairSync, randomBytes } from "node:crypto";

// Minimal deterministic DER / X.509v3 self-signed certificate builder (zero external OpenSSL dependency).
function encodeLength(len: number): Buffer {
  if (len < 0x80) return Buffer.from([len]);
  const bytes: number[] = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), encodeLength(content.length), content]);
}

function derSeq(...items: Buffer[]): Buffer {
  return derTag(0x30, Buffer.concat(items));
}

function derSet(...items: Buffer[]): Buffer {
  return derTag(0x31, Buffer.concat(items));
}

function derInt(bufOrNum: number | Buffer): Buffer {
  let buf = typeof bufOrNum === "number" ? Buffer.from([bufOrNum]) : bufOrNum;
  if (buf[0]! & 0x80) {
    buf = Buffer.concat([Buffer.from([0x00]), buf]);
  }
  return derTag(0x02, buf);
}

function derOid(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const out: number[] = [parts[0]! * 40 + parts[1]!];
  for (let i = 2; i < parts.length; i++) {
    let val = parts[i]!;
    const sub: number[] = [];
    sub.unshift(val & 0x7f);
    val >>= 7;
    while (val > 0) {
      sub.unshift((val & 0x7f) | 0x80);
      val >>= 7;
    }
    out.push(...sub);
  }
  return derTag(0x06, Buffer.from(out));
}

function derUtf8(str: string): Buffer {
  return derTag(0x0c, Buffer.from(str, "utf8"));
}

function derBitString(buf: Buffer): Buffer {
  return derTag(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
}

function derOctetString(buf: Buffer): Buffer {
  return derTag(0x04, buf);
}

function derUtcTime(date: Date): Buffer {
  const pad = (n: number): string => String(n).padStart(2, "0");
  const yy = String(date.getUTCFullYear()).slice(-2);
  const s = `${yy}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`;
  return derTag(0x17, Buffer.from(s, "ascii"));
}

function derName(cn: string): Buffer {
  return derSeq(derSet(derSeq(derOid("2.5.4.3"), derUtf8(cn))));
}

function toPem(label: string, der: Buffer): string {
  const b64 = der.toString("base64").replace(/(.{64})/g, "$1\n");
  return `-----BEGIN ${label}-----\n${b64}\n-----END ${label}-----\n`;
}

export interface GeneratedTlsCert {
  keyPem: string;
  certPem: string;
  commonName: string;
}

/**
 * Generates an X.509v3 self-signed certificate with explicit SAN DNS names & IPv4 addresses.
 * Used by local fake IMAP TLS server for both positive verification (matching SAN)
 * and negative verification (wrong CN/SAN rejecting before credentials are sent).
 */
export function generateSelfSignedTlsCert(params: {
  commonName: string;
  dnsNames?: string[];
  ipv4Addresses?: string[];
}): GeneratedTlsCert {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const spkiDer = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" }) as string;

  const serial = randomBytes(12);
  serial[0] = serial[0]! & 0x7f;

  // sha256WithRSAEncryption: 1.2.840.113549.1.1.11
  const algId = derSeq(derOid("1.2.840.113549.1.1.11"), Buffer.from([0x05, 0x00]));
  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000);
  const notAfter = new Date(now.getTime() + 7 * 24 * 3600 * 1000);
  const validity = derSeq(derUtcTime(notBefore), derUtcTime(notAfter));

  const sanEntries: Buffer[] = [];
  for (const dns of params.dnsNames ?? [params.commonName]) {
    sanEntries.push(derTag(0x82, Buffer.from(dns, "ascii")));
  }
  for (const ip of params.ipv4Addresses ?? []) {
    const octets = ip.split(".").map(Number);
    if (octets.length === 4) {
      sanEntries.push(derTag(0x87, Buffer.from(octets)));
    }
  }

  // BasicConstraints (CA:TRUE so self-signed cert works as its own CA in Node TLS) + SAN
  const basicConstraintsExt = derSeq(
    derOid("2.5.29.19"),
    Buffer.from([0x01, 0x01, 0xff]), // critical = TRUE
    derOctetString(derSeq(Buffer.from([0x01, 0x01, 0xff]))),
  );
  const sanExt = derSeq(derOid("2.5.29.17"), derOctetString(derSeq(...sanEntries)));
  const extensions = derTag(0xa3, derSeq(basicConstraintsExt, sanExt));

  const tbs = derSeq(
    derTag(0xa0, derInt(2)), // v3
    derInt(serial),
    algId,
    derName(params.commonName),
    validity,
    derName(params.commonName),
    spkiDer,
    extensions,
  );

  const signer = createSign("sha256");
  signer.update(tbs);
  const sig = signer.sign(privateKey);

  const certDer = derSeq(tbs, algId, derBitString(sig));
  return {
    keyPem,
    certPem: toPem("CERTIFICATE", certDer),
    commonName: params.commonName,
  };
}
