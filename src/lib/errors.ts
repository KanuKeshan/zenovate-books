/**
 * The only error type routes are allowed to throw deliberately.
 *
 * `message` is written for the person reading it and is safe to show. Anything
 * that would leak internals — a SQL string, a stack, a table name — belongs in
 * `internal`, which is logged and never serialised to the client. Getting this
 * boundary wrong is how error messages become a reconnaissance tool.
 */
export class HttpError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
    public readonly internal?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export const notFound = (what = 'That') => new HttpError(404, 'not_found', `${what} could not be found.`);

/**
 * Deliberately identical to notFound.
 *
 * Answering "403 forbidden" to a request for someone else's business confirms
 * that the business exists. Across a whole API that difference is enough to
 * enumerate another firm's client list, so an unauthorised read of a record and
 * a request for a record that does not exist are answered the same way.
 */
export const noAccess = () =>
  new HttpError(404, 'not_found', 'That could not be found.');

export const badRequest = (message: string, internal?: unknown) =>
  new HttpError(400, 'bad_request', message, internal);

export const conflict = (message: string) => new HttpError(409, 'conflict', message);

export const staleWrite = () =>
  new HttpError(
    409,
    'stale_write',
    'Someone else changed this while you had it open. Refresh to pick up their change, then try again.',
  );
