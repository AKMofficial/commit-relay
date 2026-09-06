// src/security/redact.ts
import { escapeHtml } from '../core/escape.ts';

/** Shared credential-shaped rules with bounded quantifiers. */
const CREDENTIAL_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/:\/\/[^/\s@"']*@/g, '://***@'],                    // URL userinfo (class excludes @, so no backtracking)
  [/\bgh[pousr]_[A-Za-z0-9]{16,}\b/g, '***'],          // classic GitHub token shapes
  [/\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, '***'],        // fine-grained PAT shape
  [/\bsha256=[0-9a-f]{64}\b/g, 'sha256=***'],          // never echo a supplied or computed digest
];

/**
 * Shape rules. Ordered cheap-to-expensive. Every pattern is a single-pass
 * character-class or literal-prefix match with no nested quantifier, so this
 * function is linear in input length and safe to run on every log line.
 */
const SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\/integrations\/[^/\s"']+/g, '/integrations/***'], // the Basecamp chatbot key, by position
  ...CREDENTIAL_SHAPES,
  [/\b(Bearer|token)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 ***'],
];

let literals: readonly string[] = [];

/**
 * Called exactly once, immediately after config validation and BEFORE the first
 * log line. Registers EVERY secret reachable from the merged config, not just
 * the default target: the webhook secret (and every per-route webhookSecretEnv
 * value), every route's chatbotKey, every resolved GITHUB_TOKEN*, and
 * HEALTH_TOKEN. Sorted longest-first so a short secret that is a prefix of a
 * longer one cannot mask it into an unmatchable remainder.
 */
export function registerSecrets(values: readonly string[]): void {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value.length < 8) continue;
    const variants = [value, escapeHtml(value), JSON.stringify(value).slice(1, -1)];
    for (const variant of variants) {
      if (variant.length >= 8 && !seen.has(variant)) {
        seen.add(variant);
        out.push(variant);
      }
    }
  }
  literals = out.sort((a, b) => b.length - a.length);
}

/** Every registered secret, masked by literal match. */
function maskLiterals(s: string): string {
  let out = s;
  for (const lit of literals) {
    if (out.includes(lit)) out = out.split(lit).join('***');
  }
  return out;
}

/** Applied to the serialized NDJSON line and to every thrown error message.
 *  Tuned for recall; use `redactOutbound` for anything a human reads. */
export function redactText(s: string): string {
  let out = maskLiterals(s);
  for (const [re, to] of SHAPES) out = out.replace(re, to);
  return out;
}

/** Credential-shaped rules only: each names a vendor token prefix or is anchored
 *  to a host, so none collides with ordinary English. Quantifiers are bounded. */
const OUTBOUND_SHAPES: ReadonlyArray<readonly [RegExp, string]> = [
  // Chatbot key by position, anchored to the Basecamp host: `integrations` is a real GitHub org.
  [
    /(\/\/[a-z0-9.-]{0,253}basecamp(?:api)?\.com\/[0-9]{1,20}\/integrations\/)[^/\s"']{1,256}/gi,
    '$1***',
  ],
  ...CREDENTIAL_SHAPES,
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/g, 'Bearer ***'],
];

/** Applied to the assembled Basecamp `content` before it is posted. Tuned for
 *  precision: a false positive here corrupts the message. `redactText` masks any
 *  8+ char word after "token", which would rewrite routine commit subjects.
 *  Registered secrets are still masked by literal match (11.1). */
export function redactOutbound(s: string): string {
  let out = maskLiterals(s);
  for (const [re, to] of OUTBOUND_SHAPES) out = out.replace(re, to);
  return out;
}
