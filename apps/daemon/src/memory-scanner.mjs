// 13-class deterministic injection scanner (Unit 5.1; spec 01 section 4.2,
// audit matrix F09). Depth control, not a promise: legitimate foreign or
// technical text CAN hit these classes — the designed response is quarantine
// plus human review, never silent destruction of the original evidence.
// Scan results never grant or revoke permissions (AGENTS section 5).

const CONTROL_CLASSES = [
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
];
export const SCANNER_CLASSES = [...CONTROL_CLASSES];

export class MemoryScanError extends Error {}

const MAX_SCAN_BYTES = 256 * 1024;

// Class 4: ANSI escape sequences (terminal control reinjection).
const ANSI_ESCAPE_RE = /\x1b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\))/u;
// Class 5: hidden HTML carriers — comments and zero-visibility elements.
const HIDDEN_HTML_RE = /<!--[\s\S]*?-->|<(?:script|iframe|style|object|embed)\b|<input[^>]*type=["']?hidden/i;
// Class 6: forged role-boundary tags pretending to be host/system framing.
const ROLE_BOUNDARY_RE =
  /<\/?(?:system|assistant|host|RequestScope|system-reminder)\b[^>]*>|\[(?:system|host|RequestScope)\]|(?:^|\n)\s*(?:system|host)\s*(?:prompt|message)\s*[:：]/i;
// Class 7: override imperatives (bilingual, bounded list, deterministic).
const OVERRIDE_IMPERATIVE_RE =
  /(ignore|disregard|forget|override)\s+(?:all\s+|any\s+|the\s+)?(?:previous|prior|above|earlier|preceding)\s+(?:instructions?|rules?|prompts?|directives?|guidance)|(?:忽略|无视| disregard|抛弃|撤销)掉?(?:之前|先前|上述|上面|以上)(?:的)?(?:所有)?(?:指令|规则|提示|指示|要求)|不再遵守(?:上述|以上|之前)(?:的)?(?:任何)?(?:规则|指令)/iu;
// Class 8: host secret paths (the secret store layout, never model-visible).
const HOST_SECRET_PATH_RE =
  /(?:^|[\s"'`(=:])(?:\.env|\.env\.[A-Za-z0-9_.-]+|workspace-state[\\/](?:console[\\/]token|db|objects|backups|scopes)|deletion-manifest\.json)(?=$|[\s"'`),.;])/i;
// Class 9: outbound exfiltration commands.
const EXFIL_COMMAND_RE =
  /\b(?:curl|wget|nc|ncat|netcat|powershell|bash|sh|python3?|node)\b[^\n]{0,160}\b(?:https?:\/\/|(?::\/dev\/tcp)|\|\s*(?:base64|openssl|curl)|>\s*\/dev\/tcp)\b/i;
// Class 10: oversized continuous base64/hex blobs (steganography carrier).
const OVERSIZED_ENCODED_RE = /(?:[A-Za-z0-9+/]{200,}={0,2}|[0-9a-fA-F]{200,})/;
// Class 11: gateway/proxy rewrite instructions claiming host authority.
const GATEWAY_REWRITE_RE =
  /(?:rewrite|redirect|forward|reroute|替换|改写|重定向|转发)(?:ing)?\s+(?:the\s+)?(?:proxy|gateway|adapter|upstream|endpoint|target|destination|请求|代理|网关|适配器|端点|目标)(?:\s+(?:to|as|into|为|到))[\s\S]{0,120}/i;
// Class 12: approval-exemption claims.
const APPROVAL_EXEMPTION_RE =
  /(?:no|skip|bypass|without|ignore)\s+(?:the\s+)?(?:approval|review|confirmation|consent)|(?:免|无需|跳过|绕过|忽略)(?:审批|核准|确认|复核|人工)|auto[- ]?(?:approve|approve[d]?)(?:\s+(?:this|the|all))?:?/i;

// Class 13 bounds are caller-supplied (capacity differs per surface).
const DEFAULT_CAPACITY_CHARS = 8000;

function matchAt(text, re) {
  const m = re.exec(text);
  if (!m) return null;
  return { index: m.index, matched: m[0] };
}

function clipEvidence(sample) {
  const s = String(sample ?? "");
  return s.length > 40 ? `${s.slice(0, 40)}…` : s;
}

/**
 * Scan one text for the 13 injection classes.
 * Returns { hits, clean } — hits carry class + a SHORT clipped evidence
 * sample (evidence itself stays in the untouched source object; the hit
 * never copies the full payload onward).
 */
export function scanMemoryText(text, { capacityChars = DEFAULT_CAPACITY_CHARS, label = "text" } = {}) {
  if (typeof text !== "string") {
    throw new MemoryScanError(`scanner refuses to scan a non-string ${label}`);
  }
  const hits = [];
  const push = (controlClass, evidence, detail) => {
    hits.push({ class: controlClass, detail: String(detail), evidence: clipEvidence(evidence) });
  };

  // Class 13 first: oversized input is itself a hit, and bounds every other
  // regex run below (the scan never chews unbounded input).
  if (Buffer.byteLength(text, "utf8") > MAX_SCAN_BYTES) {
    push("capacity_overflow", text.slice(0, 40), `input exceeds the ${MAX_SCAN_BYTES}-byte scan ceiling`);
    return { hits, clean: false };
  }
  if (text.length > capacityChars) {
    push("capacity_overflow", text.slice(0, 40), `${label} is ${text.length} chars, over the ${capacityChars}-char capacity bound`);
  }

  // Classes 1–3: invisible Unicode carriers (zero-width, BiDi, Tag block).
  for (let i = 0; i < text.length; i += 1) {
    const code = text.codePointAt(i);
    let invisible = null;
    if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff || code === 0x2060) {
      invisible = "zero_width_chars";
    } else if (
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0x200e ||
      code === 0x200f
    ) {
      invisible = "bidi_controls";
    } else if (code >= 0xe0000 && code <= 0xe007f) {
      invisible = "unicode_tag_chars";
    }
    if (invisible) {
      push(invisible, text.slice(Math.max(0, i - 8), i + 8), `invisible U+${code.toString(16).toUpperCase()} at offset ${i}`);
      if (hits.filter((h) => h.class === invisible).length >= 3) {
        // One class can carry at most a few hits — the report stays bounded
        // even when a whole invisible run is planted.
        i = text.length;
      }
    }
  }

  // Class 4
  const ansi = matchAt(text, ANSI_ESCAPE_RE);
  if (ansi) push("ansi_escape_sequences", ansi.matched, `escape at offset ${ansi.index}`);
  // Class 5
  const hiddenHtml = matchAt(text, HIDDEN_HTML_RE);
  if (hiddenHtml) push("hidden_html_or_comment", hiddenHtml.matched, `carrier at offset ${hiddenHtml.index}`);
  // Class 6
  const roleTag = matchAt(text, ROLE_BOUNDARY_RE);
  if (roleTag) push("role_boundary_tags", roleTag.matched, `forged boundary at offset ${roleTag.index}`);
  // Class 7
  const imperative = matchAt(text, OVERRIDE_IMPERATIVE_RE);
  if (imperative) push("override_imperatives", imperative.matched, `override imperative at offset ${imperative.index}`);
  // Class 8
  const secretPath = matchAt(text, HOST_SECRET_PATH_RE);
  if (secretPath) push("host_secret_paths", secretPath.matched, `secret path at offset ${secretPath.index}`);
  // Class 9
  const exfil = matchAt(text, EXFIL_COMMAND_RE);
  if (exfil) push("exfil_commands", exfil.matched, `outbound command at offset ${exfil.index}`);
  // Class 10
  const encoded = matchAt(text, OVERSIZED_ENCODED_RE);
  if (encoded) push("oversized_encoded_block", encoded.matched, `≥200-char continuous encoded block at offset ${encoded.index}`);
  // Class 11
  const gateway = matchAt(text, GATEWAY_REWRITE_RE);
  if (gateway) push("gateway_rewrite_instructions", gateway.matched, `rewrite instruction at offset ${gateway.index}`);
  // Class 12
  const exemption = matchAt(text, APPROVAL_EXEMPTION_RE);
  if (exemption) push("approval_exemption_claims", exemption.matched, `approval-exemption claim at offset ${exemption.index}`);

  return { hits, clean: hits.length === 0 };
}

export function quarantinedReasons(scanResult) {
  if (!scanResult || !Array.isArray(scanResult.hits)) return [];
  return [...new Set(scanResult.hits.map((h) => h.class))];
}
