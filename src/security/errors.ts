import { redactText } from './redact.ts';

export type RelayErrorCode =
  | 'config_invalid'
  | 'invalid_signature'
  | 'invalid_payload'
  | 'basecamp_http'
  | 'basecamp_network'
  | 'basecamp_timeout'
  | 'basecamp_rate_limited'
  | 'budget_exhausted'
  | 'content_too_large'
  | 'clock_skew'
  | 'github_http'
  | 'internal';

export class RelayError extends Error {
  readonly code: RelayErrorCode;

  // Redaction happens here, at construction, so no call site can forget it and
  // no chatbot key can reach a message by way of an interpolated URL (11.3).
  constructor(code: RelayErrorCode, message: string) {
    super(redactText(message));
    this.name = 'RelayError';
    this.code = code;
  }
}
