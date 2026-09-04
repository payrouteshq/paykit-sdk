import { createHash } from 'crypto';
import { setTimeout } from 'timers/promises';
import { z } from 'zod';
import { UnTraceableError } from '../error';
import {
  PAYKIT_METADATA_KEY,
  PaykitMetadata,
} from '../resources/metadata';
import { tryCatchSync } from './try-catch';

export type Result<T, E = unknown> =
  | { ok: true; value: T; error?: never }
  | { ok: false; value?: never; error: E };

export const OK = <V>(value: V): Result<V, never> => ({
  ok: true,
  value,
});

export const ERR = <E>(error: E): Result<never, E> => ({
  ok: false,
  error,
});

export const unwrapAsync = async <T>(
  pr: Promise<Result<T, unknown>>,
): Promise<T> => {
  const r = await pr;

  if (!r.ok) throw r.error;

  return r.value;
};

export function safeParse<Inp, Out>(
  rawValue: Inp,
  fn: (value: Inp) => Out,
  errorMessage: string,
): Result<Out, Error> {
  const [result, error] = tryCatchSync(() => fn(rawValue));

  if (error) return ERR(buildError(errorMessage, error));

  return OK(result);
}

export const safeEncode = <T>(value: T) => {
  return safeParse(
    value,
    value => Buffer.from(JSON.stringify(value)).toString('base64'),
    'Failed to encode value',
  );
};

export const safeDecode = <T>(value: string) => {
  return safeParse(
    value,
    value =>
      JSON.parse(Buffer.from(value, 'base64').toString('utf-8')) as T,
    'Failed to decode value',
  );
};

export async function executeWithRetryWithHandler<T>(
  apiCall: () => Promise<T>,
  errorHandler: (
    error: any,
    attempt: number,
  ) => { retry: boolean; data: unknown },
  maxRetries: number = 3,
  baseDelay: number = 1000,
  currentAttempt: number = 1,
): Promise<T> {
  try {
    return await apiCall();
  } catch (error) {
    const handledError = errorHandler(error, currentAttempt);

    if (!handledError.retry) {
      // No fallback data means the error must propagate — returning
      // null here would hand callers a null where a value is expected
      if (handledError.data == null) throw error;
      return handledError.data as T;
    }

    if (handledError.retry && currentAttempt <= maxRetries) {
      const delay =
        baseDelay *
        Math.pow(2, currentAttempt - 1) *
        (0.5 + Math.random() * 0.5);

      await setTimeout(delay);

      return executeWithRetryWithHandler(
        apiCall,
        errorHandler,
        maxRetries,
        baseDelay,
        currentAttempt + 1,
      );
    }

    if (handledError.data == null) throw error;
    return handledError.data as T;
  }
}

export function buildError(message: string, cause?: unknown): Error {
  const error = new Error(message);

  if (cause) error.cause = cause;

  return error;
}

export const validateRequiredKeys = <K extends string>(
  requiredKeys: readonly K[],
  source: Record<K, string>,
  errorMessage: string | ((missingKeys: K[]) => string),
  errorInstance?: (message: string) => Error,
): Record<K, string> => {
  const missingKeys: K[] = [];
  const result: Partial<Record<K, string>> = {};

  for (const key of requiredKeys) {
    const value = source[key];
    if (!value) {
      missingKeys.push(key);
    } else {
      result[key] = value;
    }
  }

  if (missingKeys.length > 0) {
    const missingKeysList = missingKeys.join(', ');
    const error =
      typeof errorMessage === 'function'
        ? errorMessage(missingKeys)
        : errorMessage.replace('{keys}', missingKeysList);

    throw errorInstance?.(error) ?? new UnTraceableError(error);
  }

  return result as Record<K, string>;
};

export const parseJSON = <T>(
  str: string,
  schema: z.ZodSchema<T>,
): T | null => {
  try {
    const parsed = JSON.parse(str);
    return schema.parse(parsed);
  } catch (error) {
    return null;
  }
};

/**
 * Validates that a Zod schema exactly matches a TypeScript interface.
 * Preserves all Zod methods while ensuring type safety.
 *
 * @example
 * export const mySchema = schema<MyInterface>()(z.object({ ... }));
 */
export const schema = <TInterface>() => {
  return <TSchema extends z.ZodType<any>>(
    schema: TSchema &
      (z.infer<TSchema> extends TInterface
        ? TInterface extends z.infer<TSchema>
          ? unknown
          : never
        : never),
  ): TSchema => schema;
};

export const omitInternalMetadata = (
  metadata: Record<string, any>,
  internalKeys: string[] = [PAYKIT_METADATA_KEY],
): PaykitMetadata => {
  return Object.entries(metadata).reduce((acc, [key, value]) => {
    if (!internalKeys.includes(key)) {
      acc[key] = String(value);
    }
    return acc;
  }, {} as PaykitMetadata);
};

/**
 * Safely converts metadata values to strings for provider storage.
 * Only stringifies non-string values to prevent nested JSON escaping.
 *
 * @example
 * stringifyMetadataValues({ count: 5, name: "John" })
 * // => { count: "5", name: "John" }
 *
 * stringifyMetadataValues({ data: { nested: true } })
 * // => { data: "{\"nested\":true}" }
 */
export const stringifyMetadataValues = (
  metadata: Record<string, any>,
): Record<string, string> => {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      typeof value === 'string' ? value : JSON.stringify(value),
    ]),
  );
};

export const getURLFromHeaders = (
  headers: Record<string, string>,
) => {
  if (headers['origin']) return headers['origin'];

  // Behind a proxy (most common in production)
  if (headers['x-forwarded-host']) {
    const protocol = headers['x-forwarded-proto'] ?? 'https';
    const host = headers['x-forwarded-host'];
    const path = headers['x-forwarded-path'] ?? '';
    return `${protocol}://${host}${path}`;
  }

  // Local development (without a proxy)
  if (headers['host']) {
    const protocol = (headers['x-forwarded-proto'] ??
      'https') as string;
    const host = headers['host'];
    const path =
      headers['x-original-url'] ?? headers['x-forwarded-path'] ?? '';
    return `${protocol}://${host}${path}`;
  }

  return '';
};

export const refundReasonMatcher = (matcher: string) => {
  // Match "duplicate" patterns
  if (
    /duplicate|duplicated|double.*charge|charged.*twice/i.test(
      matcher.toLowerCase().trim(),
    )
  ) {
    return 'duplicate';
  }

  // Match "fraudulent" patterns
  if (
    /fraud|fraudulent|unauthorized|scam|stolen.*card|not.*authorized/i.test(
      matcher.toLowerCase().trim(),
    )
  ) {
    return 'fraudulent';
  }

  // Match "requested_by_customer" patterns
  if (
    /customer.*request|requested.*customer|customer.*want|cancel|refund.*request|changed.*mind/i.test(
      matcher.toLowerCase().trim(),
    )
  ) {
    return 'requested_by_customer';
  }

  return 'other';
};

/**
 * Derives a stable webhook event id from the exact payload a provider signs.
 *
 * Providers verify their webhook signature against the raw request body, so a
 * genuine retry of the same delivery is guaranteed to carry byte-identical
 * content (or the signature wouldn't match). Hashing that content instead of
 * generating a random id means retries collapse to the same id without PayKit
 * having to store any delivery state.
 */
export const hashWebhookPayload = (
  eventType: string,
  rawPayload: string,
): string =>
  createHash('sha256')
    .update(`${eventType}:${rawPayload}`)
    .digest('hex')
    .slice(0, 32);
