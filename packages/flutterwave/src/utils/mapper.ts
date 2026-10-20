import {
  Customer,
  PAYKIT_METADATA_KEY,
  Payee,
  Payment,
  PaykitMetadata,
  Refund,
  Schema,
  omitInternalMetadata,
  parseCustomerName,
  parseJSON,
} from '@paykit-sdk/core';
import {
  FlutterwaveChargeStatus,
  FlutterwaveCharge,
  FlutterwaveCustomer,
  FlutterwaveNextAction,
  FlutterwaveOrder,
  FlutterwaveOrderStatus,
  FlutterwaveRefund,
  FlutterwaveRefundReason,
  FlutterwaveRefundStatus,
} from '../schema';

type FlutterwaveName = NonNullable<FlutterwaveCustomer['name']>;
type FlutterwavePhone = NonNullable<FlutterwaveCustomer['phone']>;

/**
 * `next_action` types where the customer, or the merchant on their
 * behalf, still has to do something before the payment can settle.
 */
const ACTIONABLE_NEXT_ACTIONS = new Set<
  FlutterwaveNextAction['type']
>([
  'redirect_url',
  'requires_pin',
  'requires_otp',
  'requires_additional_fields',
  'payment_instruction',
  'requires_bank_transfer',
  'qr_code',
]);

/**
 * A `pending` charge or order is only truly waiting on the customer
 * when `next_action` says so. `requires_requery` means Flutterwave is
 * still processing it and the merchant should poll, and
 * `requires_capture` means it is authorized and awaiting capture.
 */
const pendingPaymentStatus = (
  nextAction: FlutterwaveNextAction | undefined,
): Payment['status'] => {
  if (!nextAction) return 'pending';
  if (nextAction.type === 'requires_capture')
    return 'requires_capture';
  if (nextAction.type === 'requires_requery') return 'processing';
  if (ACTIONABLE_NEXT_ACTIONS.has(nextAction.type)) {
    return 'requires_action';
  }
  return 'pending';
};

export const flutterwaveChargeStatusToPaymentStatus = (
  status: FlutterwaveChargeStatus,
  nextAction?: FlutterwaveNextAction,
): Payment['status'] => {
  switch (status) {
    case 'succeeded':
      return 'succeeded';
    case 'failed':
      return 'failed';
    case 'voided':
      return 'canceled';
    case 'pending':
      return pendingPaymentStatus(nextAction);
    default:
      return 'pending';
  }
};

export const flutterwaveOrderStatusToPaymentStatus = (
  status: FlutterwaveOrderStatus,
  nextAction?: FlutterwaveNextAction,
): Payment['status'] => {
  switch (status) {
    case 'completed':
    case 'partially-completed':
      return 'succeeded';
    case 'authorized':
      return 'requires_capture';
    case 'failed':
      return 'failed';
    case 'voided':
      return 'canceled';
    case 'pending':
      return pendingPaymentStatus(nextAction);
    default:
      return 'pending';
  }
};

export const flutterwaveRefundStatusMap: Record<
  FlutterwaveRefundStatus,
  NonNullable<Refund['status']>
> = {
  new: 'pending',
  pending: 'pending',
  requires_action: 'pending',
  succeeded: 'succeeded',
  completed: 'succeeded',
  failed: 'failed',
  cancelled: 'failed',
};

const toPayee = (customer: {
  id?: string;
  email?: string;
}): Payee | null => {
  if (customer.email) return { email: customer.email };
  if (customer.id) return { id: customer.id };
  return null;
};

/* Names and phone numbers */

export const toFlutterwaveName = (name: string): FlutterwaveName => {
  const [first, ...rest] = name.trim().split(/\s+/);
  const last = rest.pop();

  return {
    first,
    ...(rest.length > 0 && { middle: rest.join(' ') }),
    ...(last && { last }),
  };
};

const fromFlutterwaveName = (
  name?: FlutterwaveName,
): string | undefined =>
  [name?.first, name?.middle, name?.last].filter(Boolean).join(' ') ||
  undefined;

/**
 * ITU-T E.164 country codes are prefix-free, so the leading digits
 * alone say how long the code is: 1 and 7 are single digit, the codes
 * below are two digits, everything else is three.
 */
const TWO_DIGIT_CALLING_CODES = new Set([
  '20',
  '27',
  '30',
  '31',
  '32',
  '33',
  '34',
  '36',
  '39',
  '40',
  '41',
  '43',
  '44',
  '45',
  '46',
  '47',
  '48',
  '49',
  '51',
  '52',
  '53',
  '54',
  '55',
  '56',
  '57',
  '58',
  '60',
  '61',
  '62',
  '63',
  '64',
  '65',
  '66',
  '81',
  '82',
  '84',
  '86',
  '90',
  '91',
  '92',
  '93',
  '94',
  '95',
  '98',
]);

const callingCodeLength = (digits: string): number => {
  if (digits.startsWith('1') || digits.startsWith('7')) return 1;
  return TWO_DIGIT_CALLING_CODES.has(digits.slice(0, 2)) ? 2 : 3;
};

/**
 * Splits an E.164 number (`+2349067985861`) into Flutterwave's
 * `{ country_code, number }`. Returns `null` when the input isn't E.164.
 */
export const toFlutterwavePhone = (
  phone: string,
): FlutterwavePhone | null => {
  const normalized = phone.replace(/[\s()-]/g, '');

  if (!/^\+[1-9]\d{7,14}$/.test(normalized)) return null;

  const digits = normalized.slice(1);
  const length = callingCodeLength(digits);

  return {
    country_code: digits.slice(0, length),
    number: digits.slice(length),
  };
};

const fromFlutterwavePhone = (
  phone?: FlutterwavePhone,
): string | null =>
  phone
    ? `+${phone.country_code.replace(/^\+/, '')}${phone.number}`
    : null;

/* Payments */

type FlutterwavePaymentSource = Pick<
  FlutterwaveCharge,
  | 'id'
  | 'amount'
  | 'currency'
  | 'customer_id'
  | 'billing_details'
  | 'meta'
  | 'next_action'
  | 'redirect_url'
>;

const paymentFrom = (
  data: FlutterwavePaymentSource,
  status: Payment['status'],
): Payment => {
  const meta = data.meta ?? {};
  const internal = meta[PAYKIT_METADATA_KEY]
    ? parseJSON(
        meta[PAYKIT_METADATA_KEY],
        Schema.object({ item_id: Schema.string().optional() }),
      )
    : null;

  return {
    id: data.id,
    amount: data.amount,
    currency: data.currency,
    customer: toPayee({
      id: data.customer_id,
      email: data.billing_details?.email,
    }),
    status,
    item_id: internal?.item_id ?? null,
    metadata: omitInternalMetadata(meta) as PaykitMetadata,
    requires_action: status === 'requires_action',
    payment_url:
      data.next_action?.type === 'redirect_url'
        ? data.next_action.redirect_url.url
        : null,
  };
};

export const Payment$fromCharge = (
  data: FlutterwaveCharge,
): Payment =>
  paymentFrom(
    data,
    flutterwaveChargeStatusToPaymentStatus(
      data.status,
      data.next_action,
    ),
  );

export const Payment$fromOrder = (data: FlutterwaveOrder): Payment =>
  paymentFrom(
    data,
    flutterwaveOrderStatusToPaymentStatus(
      data.status,
      data.next_action,
    ),
  );

/* Customers */

export const Customer$inboundSchema = (
  data: FlutterwaveCustomer,
): Customer => ({
  id: data.id,
  email: data.email,
  name: parseCustomerName({
    name: fromFlutterwaveName(data.name),
    email: data.email,
  }).fullName,
  phone: fromFlutterwavePhone(data.phone),
  metadata: data.meta,
  ...(data.address && { custom_fields: { address: data.address } }),
  created_at: new Date(data.created_datetime),
  updated_at: null,
});

/* Refunds */

const REFUND_REASONS: ReadonlySet<string> =
  new Set<FlutterwaveRefundReason>([
    'duplicate',
    'fraudulent',
    'requested_by_customer',
    'expired_uncaptured_charge',
  ]);

/** `meta` key that carries a free-text refund reason Flutterwave can't store. */
export const REFUND_REASON_NOTE_KEY = 'reason_note';

/**
 * Flutterwave only accepts a fixed set of refund reasons, but PayKit's
 * `reason` is free text. A value outside the set falls back to
 * `requested_by_customer` and the original text is returned as `note`
 * so the caller can keep it in the refund's `meta`.
 */
export const toRefundReason = (
  reason: string | null,
): { reason: FlutterwaveRefundReason; note?: string } => {
  if (reason && REFUND_REASONS.has(reason)) {
    return { reason: reason as FlutterwaveRefundReason };
  }

  return {
    reason: 'requested_by_customer',
    ...(reason && { note: reason }),
  };
};

export const Refund$inboundSchema = (
  data: FlutterwaveRefund,
  currency: string,
): Refund => ({
  id: data.id,
  amount: data.amount_refunded ?? 0,
  currency,
  reason: data.meta?.[REFUND_REASON_NOTE_KEY] ?? data.reason ?? null,
  metadata: data.meta
    ? omitInternalMetadata(
        Object.fromEntries(
          Object.entries(data.meta).filter(
            ([key]) => key !== REFUND_REASON_NOTE_KEY,
          ),
        ),
      )
    : null,
  status: flutterwaveRefundStatusMap[data.status] ?? 'pending',
});
