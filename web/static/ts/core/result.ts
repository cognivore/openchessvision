export type Result<T, E> =
  | { ok: true; value: T }
  | { ok: false; error: E };

export const ok = <T>(value: T): Result<T, never> => ({ ok: true, value });
export const err = <E>(error: E): Result<never, E> => ({ ok: false, error });

export const map = <T, U, E>(res: Result<T, E>, fn: (value: T) => U): Result<U, E> =>
  res.ok ? ok(fn(res.value)) : res;

export const mapError = <T, E, F>(res: Result<T, E>, fn: (error: E) => F): Result<T, F> =>
  res.ok ? res : err(fn(res.error));

export const andThen = <T, U, E>(
  res: Result<T, E>,
  fn: (value: T) => Result<U, E>,
): Result<U, E> => (res.ok ? fn(res.value) : res);

export const toPromise = <T, E>(res: Result<T, E>): Promise<T> =>
  res.ok ? Promise.resolve(res.value) : Promise.reject(res.error);
