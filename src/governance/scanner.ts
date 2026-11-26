export const SCANNER_CLASSES = [
  "zero_width_chars",
  "bidi_controls",
  "unicode_tag_chars",
  "ansi_escape_sequences",
  "hidden_html_or_comment",
  "role_boundary_tags",
  "override_imperatives",
  "host_secret_paths",
  "exfil_commands",
  "oversized_encoded_block",
  "gateway_rewrite_instructions",
  "approval_exemption_claims",
  "capacity_overflow",
] as const;

export type ScannerControlClass = (typeof SCANNER_CLASSES)[number];

export interface ScanHit {
  class: ScannerControlClass;
  detail: string;
  evidence: string;
}

export interface ScanResult {
  hits: ScanHit[];
  clean: boolean;
}

const MAX_SCAN_BYTES = 256 * 1024;
const DEFAULT_CAPACITY_CHARS = 8000;
const PER_CLASS_HIT_CAP = 3;
const TOTAL_HIT_CAP = 40;

const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/u;
const HIDDEN_HTML_RE =
  /<!--[\s\S]*?-->|<(?:script|iframe|style|object|embed)\b|<input[^>]*type=["']?hidden/i;
const ROLE_BOUNDARY_RE =
  /<\/?(?:system|assistant|host|RequestScope|system-reminder)\b[^>]*>|\[(?:system|host|RequestScope)\]|(?:system|host)\s*(?:prompt|message)\s*[:：]/i;
const OVERRIDE_IMPERATIVE_RE =
  /(ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|rules?|prompts?|directives?|guidance)|(?:忽略|无视|抛弃|撤销)掉?(?:之前|先前|上述|上面|以上)(?:的)?(?:所有)?(?:指令|规则|提示|指示|要求)|不再遵守(?:上述|以上|之前)(?:的)?(?:任何)?(?:规则|指令)/iu;
const HOST_SECRET_PATH_RE =
  /(?:^|[\s"'`(=:])(?:\.env|\.env\.[A-Za-z0-9_.-]+|workspace-state[\\/](?:console[\\/]token|db|objects|backups|scopes)(?:[\\/][\w.-]+)*|deletion-manifest\.json)(?=$|[\s"'`),.;/])/i;
const EXFIL_COMMAND_RE =
  /\b(?:curl|wget|nc|ncat|netcat|powershell|bash|sh|python3?|node)\b[^\n]{0,160}\b(?:https?:\/\/|(?::\/dev\/tcp)|\|\s*(?:base64|openssl|curl)|>\s*\/dev\/tcp)\b/i;
const OVERSIZED_ENCODED_RE = /(?:[A-Za-z0-9+/]{200,}={0,2}|[0-9a-fA-F]{200,})/;
const GATEWAY_REWRITE_RE =
  /(?:rewrite|redirect|forward|reroute|替换|改写|重定向|转发)(?:ing)?\s*(?:the\s+)?(?:proxy|gateway|adapter|upstream|endpoint|target|destination|请求|代理|网关|适配器|端点|目标)(?:\s+(?:to|as|into)|\s*(?:为|到))?[\s\S]{0,120}/i;
const APPROVAL_EXEMPTION_RE =
  /(?:no|skip|bypass|without|ignore)\s+(?:the\s+)?(?:approval|review|confirmation|consent)|(?:免|无需|跳过|绕过|忽略)(?:审批|核准|确认|复核|人工)|auto[- ]?(?:approve|approve[d]?)(?:\s+(?:this|the|all))?:?/i;

const INVISIBLE_RANGES: Array<{ lo: number; hi: number; cls: ScannerControlClass }> = [
  { lo: 0x00ad, hi: 0x00ad, cls: "zero_width_chars" },
  { lo: 0x180e, hi: 0x180e, cls: "zero_width_chars" },
  { lo: 0x2061, hi: 0x2064, cls: "zero_width_chars" },
  { lo: 0x200b, hi: 0x200d, cls: "zero_width_chars" },
  { lo: 0x2060, hi: 0x2060, cls: "zero_width_chars" },
  { lo: 0xfeff, hi: 0xfeff, cls: "zero_width_chars" },
  { lo: 0x061c, hi: 0x061c, cls: "bidi_controls" },
  { lo: 0x200e, hi: 0x200f, cls: "bidi_controls" },
  { lo: 0x202a, hi: 0x202e, cls: "bidi_controls" },
  { lo: 0x2066, hi: 0x2069, cls: "bidi_controls" },
  { lo: 0xe0000, hi: 0xe007f, cls: "unicode_tag_chars" },
];

function invisibleClassOf(code: number): ScannerControlClass | null {
  for (const r of INVISIBLE_RANGES) {
    if (code >= r.lo && code <= r.hi) return r.cls;
  }
  return null;
}

function clipEvidence(sample: string): string {
  return sample.length > 40 ? `${sample.slice(0, 40)}…` : sample;
}

export function scanMemoryText(
  text: string,
  opts: { capacityChars?: number; label?: string } = {},
): ScanResult {
  const capacityChars = opts.capacityChars ?? DEFAULT_CAPACITY_CHARS;
  const label = opts.label ?? "text";
  const hits: ScanHit[] = [];
  const classCounts = new Map<ScannerControlClass, number>();
  const push = (cls: ScannerControlClass, evidence: string, detail: string): void => {
    const count = classCounts.get(cls) ?? 0;
    if (count >= PER_CLASS_HIT_CAP || hits.length >= TOTAL_HIT_CAP) return;
    classCounts.set(cls, count + 1);
    hits.push({ class: cls, detail, evidence: clipEvidence(evidence) });
  };

  if (Buffer.byteLength(text, "utf8") > MAX_SCAN_BYTES) {
    push("capacity_overflow", text.slice(0, 40), `input exceeds ${MAX_SCAN_BYTES}-byte scan ceiling`);
    return { hits, clean: false };
  }
  if (text.length > capacityChars) {
    push("capacity_overflow", text.slice(0, 40), `${label} is ${text.length} chars, over ${capacityChars}-char cap`);
  }

  const nfkc = text.normalize("NFKC");
  const forms: Array<[string, string]> = nfkc === text ? [[text, "raw"]] : [[text, "raw"], [nfkc, "NFKC"]];

  for (const [formText, formName] of forms) {
    for (let i = 0; i < formText.length; i++) {
      const code = formText.codePointAt(i)!;
      const inv = invisibleClassOf(code);
      if (inv) {
        push(
          inv,
          formText.slice(Math.max(0, i - 8), i + 8),
          `invisible U+${code.toString(16).toUpperCase()} at offset ${i} (${formName})`,
        );
      }
      if (code > 0xffff) i++;
    }
    const regexChecks: Array<[ScannerControlClass, RegExp, string]> = [
      ["ansi_escape_sequences", ANSI_ESCAPE_RE, "escape"],
      ["hidden_html_or_comment", HIDDEN_HTML_RE, "hidden html"],
      ["role_boundary_tags", ROLE_BOUNDARY_RE, "forged boundary"],
      ["override_imperatives", OVERRIDE_IMPERATIVE_RE, "override imperative"],
      ["host_secret_paths", HOST_SECRET_PATH_RE, "secret path"],
      ["exfil_commands", EXFIL_COMMAND_RE, "exfil command"],
      ["oversized_encoded_block", OVERSIZED_ENCODED_RE, "encoded block"],
      ["gateway_rewrite_instructions", GATEWAY_REWRITE_RE, "gateway rewrite"],
      ["approval_exemption_claims", APPROVAL_EXEMPTION_RE, "approval exemption"],
    ];
    for (const [cls, re, desc] of regexChecks) {
      const m = re.exec(formText);
      if (m) {
        push(cls, m[0], `${desc} at offset ${m.index} (${formName})`);
      }
    }
  }

  return { hits, clean: hits.length === 0 };
}

export function quarantinedReasons(scan: ScanResult): ScannerControlClass[] {
  return [...new Set(scan.hits.map((h) => h.class))];
}
