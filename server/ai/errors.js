/* ReliefGrid AI — error type with user-safe codes. Upstream error bodies are
 * never forwarded to the browser; only these codes are. */
export const ERROR_STATUS = {
  invalid_request: 400,
  not_configured: 503,
  unavailable: 503,
  rate_limited: 429,
  timeout: 504,
  bad_output: 502,
  blocked: 422,
  method_not_allowed: 405,
  forbidden: 403,
};

export class AIError extends Error {
  /** @param {keyof ERROR_STATUS} code  @param {string} [detail] server-log-only detail (never user text) */
  constructor(code, detail = '') {
    super(code);
    this.code = ERROR_STATUS[code] ? code : 'unavailable';
    this.detail = detail;
  }
  get status() { return ERROR_STATUS[this.code] || 500; }
  /** Errors worth retrying on another provider. */
  get retryable() { return ['unavailable', 'timeout', 'rate_limited', 'not_configured'].includes(this.code); }
}

/** Map an HTTP status from a provider to an AIError code. */
export function codeForUpstreamStatus(status) {
  if (status === 429) return 'rate_limited';
  if (status === 408 || status === 504) return 'timeout';
  if (status === 401 || status === 403) return 'not_configured'; // bad / missing key — a config problem
  if (status >= 500) return 'unavailable';
  return 'unavailable';
}
