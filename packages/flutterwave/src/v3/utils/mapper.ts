import {
  Checkout,
  PAYKIT_METADATA_KEY,
  Payment,
  PaykitMetadata,
  Refund,
  Schema,
  Subscription,
  SubscriptionBillingInterval,
  omitInternalMetadata,
  parseJSON,
  stringifyMetadataValues,
} from '@paykit-sdk/core';
import {
  FlutterwaveV3Authorization,
  FlutterwaveV3HostedLink,
  FlutterwaveV3PaymentPlan,
  FlutterwaveV3Refund,
  FlutterwaveV3Subscription,
  FlutterwaveV3Transaction,
  FlutterwaveV3TransactionStatus,
} from '../schema';

/**
 * Keys Flutterwave writes into `meta` itself, which would otherwise
 * leak into the metadata a merchant sent. A preauthorized charge swaps
 * the merchant's `meta` for these, and a tokenized charge puts the
 * next authorization step there.
 */
const FLUTTERWAVE_META_KEYS = new Set([
  'authorization',
  'trxauthorizeid',
  'trxreference',
  'old_amount',
  'old_charged_amount',
  'old_fee',
  'old_merchant_fee',
]);

/**
 * A Payment has nowhere to say what Flutterwave wants next, so while a
 * charge is `requires_action` its metadata carries the step: `pin`,
 * `otp`, `avs_noauth` or `redirect`, plus the fields it needs.
 */
export const AUTHORIZATION_MODE_KEY =
  'flutterwave_authorization_mode';
export const AUTHORIZATION_FIELDS_KEY =
  'flutterwave_authorization_fields';

const authorizationMetadata = (
  authorization: FlutterwaveV3Authorization,
): PaykitMetadata => ({
  [AUTHORIZATION_MODE_KEY]: authorization.mode,
  ...(authorization.fields?.length && {
    [AUTHORIZATION_FIELDS_KEY]: authorization.fields.join(','),
  }),
});

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** `meta` is an object, but hosted checkouts can return `[{ metaname, metavalue }]`. */
const normalizeMeta = (
  meta: FlutterwaveV3Transaction['meta'],
): Record<string, unknown> => {
  if (!meta) return {};

  const entries: Array<[string, unknown]> = Array.isArray(meta)
    ? meta.map(({ metaname, metavalue }) => [metaname, metavalue])
    : Object.entries(meta);

  return Object.fromEntries(
    entries.filter(([key]) => !FLUTTERWAVE_META_KEYS.has(key)),
  );
};

/** A preauthorized charge stays `pending` until it is captured. */
export const isPreauthorized = (
  tx: Pick<FlutterwaveV3Transaction, 'charge_type' | 'meta'>,
): boolean =>
  tx.charge_type === 'preauth' ||
  (!Array.isArray(tx.meta) && Boolean(tx.meta?.trxauthorizeid));

/**
 * `pending` means three different things: waiting on the customer
 * (an authorization step is open), authorized and waiting to be
 * captured (preauth), or simply not settled yet.
 */
export const flutterwaveV3StatusToPaymentStatus = (
  status: FlutterwaveV3TransactionStatus,
  context: {
    authorization?: FlutterwaveV3Authorization;
    preauth?: boolean;
  } = {},
): Payment['status'] => {
  switch (status) {
    case 'successful':
    case 'success':
    case 'completed':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'voided':
    case 'cancelled':
      return 'canceled';
    case 'pending-capture':
      return 'requires_capture';
    default:
      if (context.preauth) return 'requires_capture';
      return context.authorization ? 'requires_action' : 'pending';
  }
};

/**
 * Flutterwave adds its own bookkeeping to `meta` (such as
 * `__CheckoutInitAddress`), always under a `__` prefix, so the PayKit
 * key and those are dropped to leave only what the merchant sent.
 */
export const toPaykitMetadata = (
  meta: Record<string, unknown>,
): PaykitMetadata =>
  omitInternalMetadata(
    stringifyMetadataValues(
      Object.fromEntries(
        Object.entries(meta).filter(([key]) => !key.startsWith('__')),
      ),
    ),
  ) as PaykitMetadata;

const internalMetadata = (meta: Record<string, unknown>) => {
  const raw = meta[PAYKIT_METADATA_KEY];

  return typeof raw === 'string'
    ? parseJSON(
        raw,
        Schema.object({
          item_id: Schema.string().optional(),
          quantity: Schema.number().optional(),
          type: Schema.enum(['one_time', 'recurring']).optional(),
        }),
      )
    : null;
};

const toPayee = (tx: FlutterwaveV3Transaction) =>
  tx.customer?.email ? { email: tx.customer.email } : null;

/**
 * The payment's id is its `tx_ref`. Flutterwave only hands out the
 * numeric transaction id once a charge exists, so for card PIN steps
 * and redirect-based methods the reference is the only id that stays
 * the same from the first call to the last.
 */
export const Payment$fromTransaction = (
  tx: FlutterwaveV3Transaction,
  authorization?: FlutterwaveV3Authorization,
): Payment => {
  const meta = normalizeMeta(tx.meta);
  const status = flutterwaveV3StatusToPaymentStatus(tx.status, {
    authorization,
    preauth: isPreauthorized(tx),
  });

  return {
    id: tx.tx_ref,
    amount: tx.amount,
    currency: tx.currency,
    customer: toPayee(tx),
    status,
    item_id: internalMetadata(meta)?.item_id ?? null,
    metadata: {
      ...toPaykitMetadata(meta),
      ...(status === 'requires_action' &&
        authorization &&
        authorizationMetadata(authorization)),
    },
    requires_action: status === 'requires_action',
    payment_url:
      status === 'requires_action'
        ? (authorization?.redirect ?? null)
        : null,
  };
};

/**
 * Some charges return no transaction at all, only the next step: a
 * card waiting on its PIN, or a mobile money push that redirects.
 */
export const Payment$fromAuthorization = (
  authorization: FlutterwaveV3Authorization,
  request: Pick<
    Payment,
    'id' | 'amount' | 'currency' | 'customer'
  > & {
    metadata: Record<string, unknown>;
  },
): Payment => ({
  id: request.id,
  amount: request.amount,
  currency: request.currency,
  customer: request.customer,
  status: 'requires_action',
  item_id: internalMetadata(request.metadata)?.item_id ?? null,
  metadata: {
    ...toPaykitMetadata(request.metadata),
    ...authorizationMetadata(authorization),
  },
  requires_action: true,
  payment_url: authorization.redirect ?? null,
});

export const Checkout$fromHostedLink = (
  link: FlutterwaveV3HostedLink,
  request: Pick<
    Checkout,
    'id' | 'amount' | 'currency' | 'customer' | 'session_type'
  > & {
    metadata: Record<string, unknown>;
    item_id: string;
    quantity: number;
    subscription?: Checkout['subscription'];
  },
): Checkout => ({
  id: request.id,
  customer: request.customer,
  payment_url: link.link,
  metadata: toPaykitMetadata(request.metadata),
  session_type: request.session_type,
  products: [{ id: request.item_id, quantity: request.quantity }],
  currency: request.currency,
  amount: request.amount,
  subscription: request.subscription ?? null,
});

/** A checkout that has been paid (or attempted) exists as a transaction. */
export const Checkout$fromTransaction = (
  tx: FlutterwaveV3Transaction,
): Checkout => {
  const meta = normalizeMeta(tx.meta);
  const internal = internalMetadata(meta);

  return {
    id: tx.tx_ref,
    customer: toPayee(tx),
    payment_url: '',
    metadata: toPaykitMetadata(meta),
    session_type: internal?.type ?? 'one_time',
    products: internal?.item_id
      ? [{ id: internal.item_id, quantity: internal.quantity ?? 1 }]
      : [],
    currency: tx.currency,
    amount: tx.amount,
  };
};

/** `completed-mpgs` and friends are card scheme variants of `completed`. */
export const flutterwaveV3RefundStatus = (
  status: string,
): NonNullable<Refund['status']> => {
  if (status.startsWith('completed')) return 'succeeded';
  if (status === 'failed') return 'failed';
  return 'pending';
};

export const Refund$inboundSchema = (
  data: FlutterwaveV3Refund,
  currency: string,
  reason: string | null,
): Refund => ({
  id: String(data.id),
  amount: data.amount_refunded,
  currency,
  reason: reason ?? data.comments ?? data.comment ?? null,
  metadata: null,
  status: flutterwaveV3RefundStatus(data.status),
});

/* Subscriptions */

export const toBillingInterval = (
  interval: FlutterwaveV3PaymentPlan['interval'],
): SubscriptionBillingInterval => {
  switch (interval) {
    case 'daily':
      return 'day';
    case 'weekly':
      return 'week';
    case 'monthly':
      return 'month';
    case 'yearly':
    case 'annually':
      return 'year';
    case 'hourly':
      return { type: 'custom', durationMs: HOUR_MS };
    case 'quarterly':
      return { type: 'custom', durationMs: 91 * DAY_MS };
    default:
      return 'month';
  }
};

const addInterval = (
  from: Date,
  interval: FlutterwaveV3PaymentPlan['interval'],
): Date => {
  const next = new Date(from);

  switch (interval) {
    case 'hourly':
      next.setTime(next.getTime() + HOUR_MS);
      break;
    case 'daily':
      next.setUTCDate(next.getUTCDate() + 1);
      break;
    case 'weekly':
      next.setUTCDate(next.getUTCDate() + 7);
      break;
    case 'quarterly':
      next.setUTCMonth(next.getUTCMonth() + 3);
      break;
    case 'yearly':
    case 'annually':
      next.setUTCFullYear(next.getUTCFullYear() + 1);
      break;
    default:
      next.setUTCMonth(next.getUTCMonth() + 1);
  }

  return next;
};

/**
 * Flutterwave doesn't expose the billing period of a subscription, so
 * the current one is worked out from when it started and the plan's
 * interval.
 */
const currentPeriod = (
  startedAt: Date,
  interval: FlutterwaveV3PaymentPlan['interval'],
  now: Date,
): { start: Date; end: Date } => {
  let start = startedAt;
  let end = addInterval(start, interval);

  while (end <= now) {
    start = end;
    end = addInterval(start, interval);
  }

  return { start, end };
};

const subscriptionStatusMap: Record<string, Subscription['status']> =
  {
    active: 'active',
    cancelled: 'canceled',
    deactivated: 'canceled',
    completed: 'expired',
  };

export const Subscription$inboundSchema = (
  data: FlutterwaveV3Subscription,
  plan: FlutterwaveV3PaymentPlan,
  now: Date = new Date(),
): Subscription => {
  const { start, end } = currentPeriod(
    new Date(data.created_at),
    plan.interval,
    now,
  );

  return {
    id: String(data.id),
    customer: { email: data.customer.customer_email },
    amount: data.amount,
    currency: plan.currency,
    status: subscriptionStatusMap[data.status] ?? 'active',
    current_period_start: start,
    current_period_end: end,
    item_id: String(plan.id),
    billing_interval: toBillingInterval(plan.interval),
    metadata: null,
    custom_fields: { plan_name: plan.name },
    requires_action: false,
    payment_url: null,
  };
};

/** A subscription that exists only as a hosted checkout nobody has paid yet. */
export const Subscription$fromHostedLink = (
  link: FlutterwaveV3HostedLink,
  request: {
    id: string;
    email: string;
    plan: FlutterwaveV3PaymentPlan;
    metadata: Record<string, unknown>;
  },
  now: Date = new Date(),
): Subscription => ({
  id: request.id,
  customer: { email: request.email },
  amount: request.plan.amount,
  currency: request.plan.currency,
  status: 'pending',
  current_period_start: now,
  current_period_end: addInterval(now, request.plan.interval),
  item_id: String(request.plan.id),
  billing_interval: toBillingInterval(request.plan.interval),
  metadata: toPaykitMetadata(request.metadata),
  custom_fields: { plan_name: request.plan.name },
  requires_action: true,
  payment_url: link.link,
});
