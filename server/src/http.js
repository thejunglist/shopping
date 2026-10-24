import { z } from 'zod';

/** An error that Fastify's error handler turns into a plain JSON response. */
export class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

export const notFound = (what) => new HttpError(404, `${what} not found`);

/** A positive integer id, accepted as a number or a numeric string (URL params). */
export const id = z.coerce.number().int().positive();

/** Integer pence: whole numbers only, never negative. */
export const pence = z.number().int().min(0).max(10_000_000);

/** Who made the request, from the header that `tailscale serve` adds. */
export function userOf(request) {
  const user = request.headers['tailscale-user-login'];
  return typeof user === 'string' && user !== '' ? user : null;
}

/**
 * Build "SET a = ?, b = ?" from the keys present in `body`. Only keys listed in
 * `allowed` are used, so column names never come from the request.
 */
export function setClause(body, allowed) {
  const keys = allowed.filter((key) => body[key] !== undefined);
  return {
    sql: keys.map((key) => `${key} = ?`).join(', '),
    values: keys.map((key) => body[key]),
  };
}
