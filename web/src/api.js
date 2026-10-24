// Thin wrapper around fetch for the JSON API. Errors carry the server's message.
async function request(method, path, body) {
  const response = await fetch(`/api${path}`, {
    method,
    // Only send a content type when there is a body; the server rejects an
    // empty body that claims to be JSON.
    headers: body === undefined ? undefined : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const issue = data.issues?.[0];
    throw new Error(issue ? `${issue.path}: ${issue.message}` : (data.error ?? response.statusText));
  }
  return data;
}

export const api = {
  get: (path) => request('GET', path),
  post: (path, body) => request('POST', path, body ?? undefined),
  patch: (path, body) => request('PATCH', path, body),
  put: (path, body) => request('PUT', path, body),
  del: (path) => request('DELETE', path),
};

/** 145 -> "£1.45". Null (no price known) shows as an en dash. */
export const formatPence = (pence) => (pence == null ? '–' : `£${(pence / 100).toFixed(2)}`);

/** "1.45" or "£1.45" -> 145, or null if it is not a valid price. Mirrors the server. */
export function toPence(text) {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(
    String(text ?? '')
      .trim()
      .replace(/^£/, '')
      .replaceAll(',', ''),
  );
  return match ? Number(match[1]) * 100 + Number((match[2] ?? '').padEnd(2, '0')) : null;
}
