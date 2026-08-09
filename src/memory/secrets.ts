export interface SecretFilterResult {
  /** Content safe to persist. */
  content: string;
  /** True when one or more values were replaced. */
  filtered: boolean;
  redactionCount: number;
}

const REDACTED = "[REDACTED]";
const REDACTED_PRIVATE_KEY = "[REDACTED PRIVATE KEY]";

type Replacement = string | ((substring: string, ...args: string[]) => string);

/**
 * Conservatively remove common credential forms before text reaches storage.
 * The patterns intentionally favor labelled credentials and provider-specific
 * formats over short, ambiguous words and identifiers.
 */
export function filterSecrets(input: string): SecretFilterResult {
  let content = input;
  let redactionCount = 0;

  const replace = (pattern: RegExp, replacement: Replacement): void => {
    content = content.replace(pattern, (...args: unknown[]) => {
      redactionCount += 1;
      if (typeof replacement === "string") return replacement;
      const replacer = replacement as (...values: string[]) => string;
      return replacer(...(args.slice(0, -2) as string[]));
    });
  };

  // PEM private keys, including multiline blocks.
  replace(
    /-----BEGIN(?: [A-Z0-9]+)? PRIVATE KEY-----[\s\S]*?-----END(?: [A-Z0-9]+)? PRIVATE KEY-----/gi,
    REDACTED_PRIVATE_KEY,
  );

  // Authorization headers (including JSON headers) and standalone Bearer credentials.
  replace(
    /((?:["'`])?Authorization(?:["'`])?\s*[:=]\s*)(["'`]?)(?:Bearer\s+|Basic\s+)?[^\s,;"'`]+\2/gi,
    (_match, prefix, quote) => `${prefix}${quote}${REDACTED}${quote}`,
  );
  replace(/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}={0,2}/gi, `Bearer ${REDACTED}`);

  // Labelled assignments. Optional quotes around labels cover JSON and quoted
  // environment keys. Quoted values may contain spaces; unquoted values stop
  // at whitespace or common configuration delimiters.
  const credentialLabel = "(?:api[_-]?key|access[_-]?token|auth[_-]?token|refresh[_-]?token|password|passwd|pwd|client[_-]?secret|api[_-]?secret|secret)";
  replace(
    new RegExp(`((?:["'\\x60])?${credentialLabel}(?:["'\\x60])?\\s*(?:=|:|=>)\\s*)(["'\\x60])[^\\r\\n]*?\\2`, "gi"),
    (_match, prefix, quote) => `${prefix}${quote}${REDACTED}${quote}`,
  );
  replace(
    new RegExp(`((?:["'\\x60])?${credentialLabel}(?:["'\\x60])?\\s*(?:=|:|=>)\\s*)(?!["'\\x60]?\\[REDACTED\\])[^\\s#}\\]]+`, "gi"),
    (_match, prefix) => `${prefix}${REDACTED}`,
  );

  // Provider-specific and otherwise high-confidence credential formats.
  replace(/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, REDACTED);
  replace(/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, REDACTED);
  replace(/\bglpat-[A-Za-z0-9_-]{20,}\b/g, REDACTED);
  replace(/\bxox[baprs]-[A-Za-z0-9-]{20,}\b/g, REDACTED);
  replace(/\bnpm_[A-Za-z0-9]{30,}\b/g, REDACTED);
  replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, REDACTED);
  replace(/\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b/g, REDACTED);
  replace(/\bAIza[0-9A-Za-z_-]{30,}\b/g, REDACTED);
  replace(/\b(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g, REDACTED);
  replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, REDACTED);
  replace(/\bya29\.[A-Za-z0-9_-]{20,}\b/g, REDACTED);

  // Credentials embedded in URLs are unambiguous even when provider-agnostic.
  replace(
    /(\b[a-z][a-z0-9+.-]*:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
    (_match, prefix, suffix) => `${prefix}${REDACTED}${suffix}`,
  );

  // JWTs have three base64url segments. Require substantial segment lengths
  // to avoid treating dotted versions and ordinary prose as credentials.
  replace(
    /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
    REDACTED,
  );

  // Long opaque strings with mixed character classes are likely credentials.
  // Hex hashes and ordinary lowercase identifiers are deliberately excluded.
  replace(/\b(?=[A-Za-z0-9_+\/-]{40,}(?:={0,2})(?=$|[^A-Za-z0-9_+\/-]))(?=[A-Za-z0-9_+\/-]*[a-z])(?=[A-Za-z0-9_+\/-]*[A-Z])(?=[A-Za-z0-9_+\/-]*\d)(?=[A-Za-z0-9_+\/-]*[_+\/-])[A-Za-z0-9_+\/-]+={0,2}/g, REDACTED);

  return { content, filtered: redactionCount > 0, redactionCount };
}

/** Alias for callers that prefer redaction terminology. */
export const redactSecrets = filterSecrets;
