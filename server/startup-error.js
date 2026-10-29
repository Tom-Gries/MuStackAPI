const MAX_ERRORS = 32;

function errorChain(root) {
  const pending = [root];
  const seen = new Set();
  const errors = [];
  const append = (error) => {
    if (error && typeof error === 'object' && !seen.has(error) && pending.length < MAX_ERRORS) pending.push(error);
  };
  while (pending.length && errors.length < MAX_ERRORS) {
    const error = pending.shift();
    if (!error || typeof error !== 'object' || seen.has(error)) continue;
    seen.add(error);
    errors.push(error);
    append(error.cause);
    const servers = error.reason?.servers;
    if (servers instanceof Map || Array.isArray(servers)) {
      for (const server of servers.values()) {
        append(server?.error);
        if (pending.length >= MAX_ERRORS) break;
      }
    }
  }
  return errors;
}

/** Return only fixed public codes; database errors can embed credentials. */
export function startupErrorCode(error) {
  const errors = errorChain(error);
  const message = (entry) => typeof entry.message === 'string' ? entry.message : '';
  const codeIs = (entry, code) => entry.code === code || entry.code === String(code);
  if (errors.some((entry) => message(entry).startsWith('Für den Cloudbetrieb ist MONGODB_URI erforderlich.'))) return 'MONGODB_URI_MISSING';
  if (errors.some((entry) => entry.name === 'MongoParseError' || message(entry).startsWith('MONGODB_URI enthält Platzhalter.'))) return 'MONGODB_URI_INVALID';
  if (errors.some((entry) => /^API_ORIGIN (muss|benötigt) /.test(message(entry)))) return 'API_ORIGIN_INVALID';
  if (errors.some((entry) => codeIs(entry, 18) || codeIs(entry, 8000) && /\b(?:bad auth|authentication failed|authentication failure|auth failed)\b/i.test(message(entry)))) return 'MONGODB_AUTH_FAILED';
  if (errors.some((entry) => codeIs(entry, 13))) return 'MONGODB_ACCESS_DENIED';
  if (errors.some((entry) => ['ENOTFOUND', 'ENODATA', 'EAI_AGAIN', 'ESERVFAIL'].includes(entry.code))) return 'MONGODB_DNS_FAILED';
  if (errors.some((entry) => typeof entry.code === 'string' && /^(?:ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_VERIFY_|UNABLE_TO_GET_ISSUER_CERT|DEPTH_ZERO_SELF_SIGNED_CERT|SELF_SIGNED_CERT_IN_CHAIN)/.test(entry.code))) return 'MONGODB_TLS_FAILED';
  if (errors.some((entry) => ['MongoServerSelectionError', 'MongoNetworkError', 'MongoNetworkTimeoutError'].includes(entry.name))) return 'MONGODB_NETWORK_FAILED';
  return 'STARTUP_FAILED';
}
