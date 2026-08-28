/**
 * Payload redaction.
 *
 * `RedactionConfig` declares which fields are sensitive; `redact()` walks
 * a parsed payload and replaces every occurrence with the masking
 * placeholder. The default config is conservative: built-in PII /
 * credential / financial field names are masked on sight, the output is
 * idempotent (redact(redact(x)) == redact(x)), and the input is never
 * mutated.
 *
 * Masking happens BEFORE the payload reaches the entry. The interceptor
 * applies it on every emission path (success and error). When
 * `capturePayloads` is false the masked payload is simply never added to
 * the entry, so by default the emitted log line carries no body content
 * at all.
 */

export const DEFAULT_PLACEHOLDER = '[REDACTED]';

/**
 * Default field names that are always masked when capturePayloads is
 * enabled. Conservative: PII (email/phone/ssn/name), secrets (password/
 * token/key/secret/credential/authorization), and financial data (card /
 * cvv / iban / account / routing). Substrings match (e.g. `userEmail`
 * hits `email`), so a caller does not need to enumerate every camelCase
 * variant.
 */
export const DEFAULT_SENSITIVE_FIELDS: readonly string[] = [
  'password',
  'passwd',
  'secret',
  'apiKey',
  'api_key',
  'token',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'authorization',
  'credential',
  'credentials',
  'privateKey',
  'private_key',
  'sessionId',
  'session_id',
  'cookie',
  'setCookie',
  'set_cookie',
  'ssn',
  'socialSecurity',
  'social_security',
  'taxId',
  'tax_id',
  'email',
  'phone',
  'phoneNumber',
  'phone_number',
  'address',
  'street',
  'postalCode',
  'postal_code',
  'zip',
  'dob',
  'dateOfBirth',
  'date_of_birth',
  'fullName',
  'full_name',
  'firstName',
  'first_name',
  'lastName',
  'last_name',
  'creditCard',
  'credit_card',
  'cardNumber',
  'card_number',
  'cvv',
  'cvc',
  'iban',
  'accountNumber',
  'account_number',
  'routingNumber',
  'routing_number',
  'bankAccount',
  'bank_account',
  'salary',
  'income',
  'medicalRecord',
  'medical_record',
  'diagnosis',
  'patientId',
  'patient_id',
];

/**
 * Configuration for redaction.
 *
 * `sensitiveFields` — extra field name substrings to mask on top of the
 * built-in defaults.
 *
 * `requestOnly` / `responseOnly` — limit masking to one side. Undefined
 * means "mask on both sides".
 *
 * `placeholder` — what to substitute for the value. Defaults to
 * `[REDACTED]`.
 */
export interface RedactionConfig {
  sensitiveFields?: readonly string[];
  requestOnly?: boolean;
  responseOnly?: boolean;
  placeholder?: string;
}

/** A resolved (filled-in) configuration, used internally by redact(). */
interface ResolvedConfig {
  fieldNeedles: string[];
  requestOnly: boolean;
  responseOnly: boolean;
  placeholder: string;
}

/**
 * The default, ready-to-use configuration. No caller setup is required
 * to achieve no-raw-by-default emission (the interceptor simply does not
 * add masked-payload fields unless `capturePayloads` is true; when it
 * is, this config is applied automatically).
 */
export const DEFAULT_REDACTION_CONFIG: RedactionConfig = {
  sensitiveFields: DEFAULT_SENSITIVE_FIELDS,
  placeholder: DEFAULT_PLACEHOLDER,
};

/** Resolve a RedactionConfig to its concrete values. */
function resolveConfig(config: RedactionConfig | undefined): ResolvedConfig {
  const c = config ?? DEFAULT_REDACTION_CONFIG;
  const allFields = [...DEFAULT_SENSITIVE_FIELDS, ...(c.sensitiveFields ?? [])];
  return {
    fieldNeedles: allFields.map((f) => f.toLowerCase()),
    requestOnly: c.requestOnly === true,
    responseOnly: c.responseOnly === true,
    placeholder: c.placeholder ?? DEFAULT_PLACEHOLDER,
  };
}

/** Decide whether a single side should be masked under this config. */
function shouldMaskSide(
  resolved: ResolvedConfig,
  side: 'request' | 'response',
): boolean {
  if (resolved.requestOnly && side !== 'request') {
    return false;
  }
  if (resolved.responseOnly && side !== 'response') {
    return false;
  }
  return true;
}

/**
 * Whether a key (or any key path segment) is sensitive — case-insensitive
 * substring match against the configured needles. Substring matching is
 * deliberate: it catches camelCase variants (`userEmail`) without forcing
 * the caller to enumerate them.
 */
function isSensitiveKey(key: string, needles: string[]): boolean {
  const lower = key.toLowerCase();
  for (const needle of needles) {
    if (lower.includes(needle)) {
      return true;
    }
  }
  return false;
}

/**
 * Walk a payload and produce a structurally-identical copy with sensitive
 * values replaced by the placeholder. The input is never mutated.
 *
 * Tolerates null, primitives, arrays, deeply nested objects, and circular
 * references (cycles are broken at the cycle point with the placeholder).
 */
export function redact(
  payload: unknown,
  config?: RedactionConfig,
  side: 'request' | 'response' = 'request',
): unknown {
  const resolved = resolveConfig(config);
  if (!shouldMaskSide(resolved, side)) {
    return payload;
  }
  const seen = new WeakSet<object>();
  return walk(payload, resolved, seen);
}

/**
 * Internal recursive walker. Uses a WeakSet to break cycles (the cyclic
 * value is replaced with the placeholder so we still emit a meaningful
 * "something was here" signal without recursing forever).
 */
function walk(
  value: unknown,
  resolved: ResolvedConfig,
  seen: WeakSet<object>,
): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  if (typeof value !== 'object') {
    return value;
  }
  if (seen.has(value)) {
    return resolved.placeholder;
  }
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, resolved, seen));
  }

  // Plain object: walk entries, masking any whose key is sensitive.
  const out: Record<string, unknown> = {};
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (isSensitiveKey(key, resolved.fieldNeedles)) {
      out[key] = resolved.placeholder;
    } else {
      out[key] = walk(record[key], resolved, seen);
    }
  }
  return out;
}
