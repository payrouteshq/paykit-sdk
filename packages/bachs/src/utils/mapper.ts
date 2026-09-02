import {
  Customer,
  omitInternalMetadata,
  parseCustomerName,
  Payee,
  Payment,
  PaykitMetadata,
  Refund,
  Subscription,
  SubscriptionStatus,
} from '@paykit-sdk/core';
import { Checkout } from '@paykit-sdk/core';
import {
  BachsChargeStatus,
  BachsCheckoutSessionApiResponse,
  BachsCheckoutStatus,
  BachsCreateCheckoutSessionResponse,
  BachsCustomerDetailResponse,
  BachsRefundResponse,
  BachsSubscriptionResponse,
  BachsSubscriptionStatus,
} from '../schema';

/**
 * From Bachs' PaymentResponse.status docs (`x-enum-descriptions` in
 * the OpenAPI spec).
 */
export const bachsChargeStatusToPaymentStatus = (
  status: BachsChargeStatus,
): Payment['status'] => {
  switch (status) {
    case 'succeeded':
    case 'overpaid':
    case 'partially_refunded':
      return 'succeeded';
    case 'processing':
    case 'accepted':
    case 'underpaid':
      return 'processing';
    case 'created':
      return 'requires_action';
    case 'failed':
    case 'expired':
      return 'failed';
    case 'cancelled':
    case 'refunded':
      return 'canceled';
    default:
      return 'pending';
  }
};

/** Fallback mapping used while a checkout's `charge` is still `null`. */
export const bachsCheckoutStatusToPaymentStatus = (
  status: BachsCheckoutStatus,
): Payment['status'] => {
  switch (status) {
    case 'open':
      return 'pending';
    case 'completed':
      return 'succeeded';
    case 'expired':
      return 'failed';
    case 'cancelled':
      return 'canceled';
    default:
      return 'pending';
  }
};

export const bachsSubscriptionStatusMap: Record<
  BachsSubscriptionStatus,
  SubscriptionStatus
> = {
  trialing: 'trialing',
  active: 'active',
  past_due: 'past_due',
  unpaid: 'expired',
  canceled: 'canceled',
  paused: 'pending',
};

const toPayee = (customer: {
  customer_id?: string | null;
  email?: string | null;
}): Payee | null => {
  if (customer.email) return { email: customer.email };
  if (customer.customer_id) return { id: customer.customer_id };
  return null;
};

export interface BachsCheckoutCreateContext {
  customer: Payee;
  itemId: string;
  quantity: number;
  sessionType: 'one_time' | 'recurring';
  currency: string;
  amount: number;
  metadata: PaykitMetadata | null;
}

/**
 * Bachs' create-checkout-session response is minimal ({checkout_id,
 * checkout_url, status, expires_at, created_at}) - it doesn't echo
 * back amount/currency/customer/products, so those come from the
 * request context instead.
 */
export const Checkout$fromCreate = (
  response: BachsCreateCheckoutSessionResponse,
  ctx: BachsCheckoutCreateContext,
): Checkout => ({
  id: response.checkout_id,
  customer: ctx.customer,
  payment_url: response.checkout_url,
  metadata: ctx.metadata,
  session_type: ctx.sessionType,
  products: [{ id: ctx.itemId, quantity: ctx.quantity }],
  currency: ctx.currency,
  amount: ctx.amount,
});

/**
 * GET /v1/checkout-sessions/{id} never returns `checkout_url` -
 * Bachs only hands that out once, at creation. `payment_url` is
 * therefore always `''` here, matching the convention already used
 * elsewhere in this codebase for providers whose retrieval endpoints
 * don't echo the hosted URL back.
 */
export const Checkout$fromSession = (
  response: BachsCheckoutSessionApiResponse,
): Checkout => {
  const metadata = response.metadata
    ? (omitInternalMetadata(
        response.metadata as Record<string, string>,
      ) as PaykitMetadata)
    : null;

  return {
    id: response.checkout_id,
    customer: toPayee({
      customer_id: response.customer.id,
      email: response.customer.email,
    }),
    payment_url: '',
    metadata,
    session_type: response.recurring ? 'recurring' : 'one_time',
    products: (response.products ?? []).map(p => ({
      id: p.product_id,
      quantity: p.quantity,
    })),
    currency: response.currency,
    amount: Number(response.amount),
  };
};

export interface BachsPaymentCreateContext {
  customer: Payee;
  itemId: string;
  currency: string;
  amount: number;
  metadata: PaykitMetadata | null;
}

/**
 * The Payment returned synchronously from createPayment. Its `id` is
 * the checkout_id (a real payment/charge only exists once the
 * customer completes payment against the hosted checkout).
 */
export const Payment$fromCreate = (
  response: BachsCreateCheckoutSessionResponse,
  ctx: BachsPaymentCreateContext,
): Payment => ({
  id: response.checkout_id,
  amount: ctx.amount,
  currency: ctx.currency,
  customer: ctx.customer,
  status: 'pending',
  item_id: ctx.itemId,
  metadata: ctx.metadata ?? {},
  requires_action: true,
  payment_url: response.checkout_url,
});

/**
 * Builds a Payment from GET /v1/checkout-sessions/{id}. Uses the
 * nested `charge` once payment has been attempted; falls back to the
 * checkout's own status/amount while `charge` is still `null`.
 */
export const Payment$fromSession = (
  response: BachsCheckoutSessionApiResponse,
): Payment => {
  const metadata = response.metadata
    ? (omitInternalMetadata(
        response.metadata as Record<string, string>,
      ) as PaykitMetadata)
    : {};

  const customer = toPayee({
    customer_id: response.customer.id,
    email: response.customer.email,
  });

  if (response.charge) {
    const charge = response.charge;
    const status = bachsChargeStatusToPaymentStatus(charge.status);

    return {
      id: response.checkout_id,
      amount: Number(charge.amount),
      currency: charge.currency,
      customer: charge.customer?.email
        ? { email: charge.customer.email }
        : customer,
      status,
      item_id: charge.line_items?.[0]?.product_id ?? null,
      metadata,
      requires_action: status === 'requires_action',
      payment_url: null,
    };
  }

  const status = bachsCheckoutStatusToPaymentStatus(response.status);

  return {
    id: response.checkout_id,
    amount: Number(response.amount),
    currency: response.currency,
    customer,
    status,
    item_id: response.products?.[0]?.product_id ?? null,
    metadata,
    requires_action: status === 'pending',
    payment_url: null,
  };
};

export const Customer$inboundSchema = (
  data: BachsCustomerDetailResponse,
): Customer => ({
  id: data.customer_id,
  email: data.email,
  name: parseCustomerName({
    name: data.name ?? undefined,
    email: data.email,
  }).fullName,
  phone: data.phone_number ?? null,
  metadata: data.metadata as Record<string, string> | undefined,
  created_at: new Date(data.created_at),
  updated_at: data.updated_at ? new Date(data.updated_at) : null,
});

export const Subscription$inboundSchema = (
  data: BachsSubscriptionResponse,
): Subscription => {
  const status = bachsSubscriptionStatusMap[data.status] ?? 'pending';

  return {
    id: data.id,
    customer: toPayee(data.customer),
    amount: Number(data.amount),
    currency: data.currency,
    status,
    current_period_start: new Date(data.current_period_start),
    current_period_end: new Date(data.current_period_end),
    item_id: data.product?.id ?? data.items?.[0]?.product?.id ?? '',
    billing_interval: data.billing_cycle.interval,
    // Bachs' SubscriptionResponse carries no metadata field - nothing to recover here.
    metadata: null,
    custom_fields: null,
    requires_action: status === 'past_due' || status === 'expired',
    payment_url: null,
  };
};

export const Refund$inboundSchema = (
  data: Pick<
    BachsRefundResponse,
    'refund_id' | 'requested_amount' | 'refunded_amount' | 'reason'
  >,
  currency: string,
): Refund => ({
  id: data.refund_id,
  amount: Number(data.refunded_amount ?? data.requested_amount),
  currency,
  reason: data.reason ?? null,
  metadata: null,
});
