import { createSign, generateKeyPairSync } from "node:crypto";

function derLen(len) {
  if (len < 128) return Buffer.from([len]);
  const bytes = [];
  let n = len;
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return Buffer.from([0x80 | bytes.length, ...bytes]);
}

function derTag(tag, content) {
  const buf = Buffer.isBuffer(content) ? content : Buffer.concat(content);
  return Buffer.concat([Buffer.from([tag]), derLen(buf.length), buf]);
}

const derSeq = (...items) => derTag(0x30, items);
const derSet = (...items) => derTag(0x31, items);
const derInt = (bufOrNum) => {
  let b =
    typeof bufOrNum === "number"
      ? Buffer.from(bufOrNum === 0 ? [0] : bufOrNum.toString(16).padStart(2, "0"), "hex")
      : Buffer.from(bufOrNum);
  if (b[0] & 0x80) b = Buffer.concat([Buffer.from([0x00]), b]);
  return derTag(0x02, b);
};
const derBitStr = (buf) => derTag(0x03, Buffer.concat([Buffer.from([0x00]), buf]));
const derOctet = (buf) => derTag(0x04, buf);
const derOid = (oid) => {
  const parts = oid.split(".").map(Number);
  const out = [40 * parts[0] + parts[1]];
  for (let i = 2; i < parts.length; i += 1) {
    let v = parts[i];
    const enc = [v & 0x7f];
    while ((v >>= 7) > 0) enc.unshift(0x80 | (v & 0x7f));
    out.push(...enc);
  }
  return derTag(0x06, Buffer.from(out));
};
const derNull = () => Buffer.from([0x05, 0x00]);
const derUtf8 = (s) => derTag(0x0c, Buffer.from(s, "utf8"));
const derTime = (d) =>
  derTag(0x17, Buffer.from(d.toISOString().replace(/[-:T]/g, "").slice(2, 14) + "Z", "ascii"));

export function generateSelfSignedCert({
  cn = "tg-proxy-only.invalid",
  dnsNames = ["tg-proxy-only.invalid", "localhost"],
  ips = [[127, 0, 0, 1]],
} = {}) {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const spki = publicKey.export({ type: "spki", format: "der" });
  const keyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const sha256WithRsa = derSeq(derOid("1.2.840.113549.1.1.11"), derNull());
  const name = derSeq(derSet(derSeq(derOid("2.5.4.3"), derUtf8(cn))));
  const now = new Date(Date.now() - 60_000);
  const exp = new Date(Date.now() + 7 * 86400_000);
  const sanEntries = [
    ...dnsNames.map((d) => derTag(0x82, Buffer.from(d, "ascii"))),
    ...ips.map((ip) => derTag(0x87, Buffer.from(ip))),
  ];
  const exts = derTag(
    0xa3,
    derSeq(
      derSeq(derOid("2.5.29.19"), Buffer.from([0x01, 0x01, 0xff]), derOctet(derSeq(Buffer.from([0x01, 0x01, 0xff])))),
      derSeq(derOid("2.5.29.17"), derOctet(derSeq(...sanEntries))),
    ),
  );
  const tbs = derSeq(
    derTag(0xa0, derInt(2)),
    derInt(Buffer.from([0x01, 0x23, 0x45, 0x67])),
    sha256WithRsa,
    name,
    derSeq(derTime(now), derTime(exp)),
    name,
    spki,
    exts,
  );
  const sig = createSign("RSA-SHA256").update(tbs).sign(privateKey);
  const certDer = derSeq(tbs, sha256WithRsa, derBitStr(sig));
  const b64 = certDer.toString("base64").match(/.{1,64}/g).join("\n");
  const certPem = `-----BEGIN CERTIFICATE-----\n${b64}\n-----END CERTIFICATE-----\n`;
  return { certPem, keyPem };
}

