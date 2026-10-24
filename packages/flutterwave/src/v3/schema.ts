/**
 * Types for Flutterwave's v3 API (`https://api.flutterwave.com/v3`).
 *
 * Unlike v4, Flutterwave publishes no machine-readable spec for v3, so
 * these are written by hand from the reference pages and checked
 * against real sandbox responses.
 */

/* Response envelope */

export interface FlutterwaveV3PageInfo {
  total: number;
  current_page: number;
  total_pages: number;
}

export interface FlutterwaveV3Envelope<T> {
  status: 'success' | 'error';
  message: string;
  data: T | null;
  meta?: {
    authorization?: FlutterwaveV3Authorization;
    page_info?: FlutterwaveV3PageInfo;
  };
}

/* Authorization */

export type FlutterwaveV3AuthMode =
  | 'pin'
  | 'otp'
  | 'avs_noauth'
  | 'redirect'
  | 'ussd'
  | 'banktransfer';

/** What Flutterwave wants next before a charge can complete. */
export interface FlutterwaveV3Authorization {
  mode: FlutterwaveV3AuthMode;
  /** Where to send the customer when `mode` is `redirect`. */
  redirect?: string;
  /** Fields to send back in `authorization` when `mode` is `pin` or `avs_noauth`. */
  fields?: string[];
  endpoint?: string;
  validate_instructions?: string;
}

/** Customer-supplied authorization sent when re-submitting a card charge. */
export type FlutterwaveV3ChargeAuthorization =
  | { mode: 'pin'; pin: string }
  | {
      mode: 'avs_noauth';
      city: string;
      address: string;
      state: string;
      country: string;
      zipcode: string;
    };

/* Transactions */

export type FlutterwaveV3TransactionStatus =
  | 'successful'
  | 'failed'
  | 'pending'
  | 'voided'
  | (string & {});

export interface FlutterwaveV3Customer {
  id: number;
  name?: string | null;
  email: string;
  phone_number?: string | null;
  created_at?: string;
}

export interface FlutterwaveV3Card {
  first_6digits?: string;
  last_4digits?: string;
  issuer?: string;
  country?: string;
  type?: string;
  /** Present on a verified transaction; reusable with tokenized charges. */
  token?: string;
  expiry?: string;
}

export interface FlutterwaveV3Transaction {
  id: number;
  tx_ref: string;
  flw_ref: string;
  amount: number;
  charged_amount?: number;
  currency: string;
  status: FlutterwaveV3TransactionStatus;
  payment_type?: string;
  auth_model?: string;
  processor_response?: string;
  /** Only returned when charging, captured or voiding, not on verify. */
  charge_type?: 'normal' | 'preauth' | (string & {});
  /** Payment plan id when the charge subscribed the customer. */
  plan?: number | null;
  /**
   * An object for most charges. Hosted checkouts have been seen
   * returning `[{ metaname, metavalue }]` instead.
   */
  meta?:
    | Record<string, unknown>
    | Array<{ metaname: string; metavalue: unknown }>
    | null;
  customer?: FlutterwaveV3Customer;
  card?: FlutterwaveV3Card;
  created_at?: string;
  /** Tokenized charges put the authorization here rather than at the top level. */
  redirect_url?: string;
}

export interface FlutterwaveV3HostedLink {
  link: string;
}

/* Refunds */

export interface FlutterwaveV3Refund {
  id: number;
  amount_refunded: number;
  /** `completed`, `completed-mpgs`, `pending`, `failed`, ... */
  status: string;
  flw_ref?: string;
  /** Called `comments` when creating a refund and `comment` when fetching one. */
  comments?: string | null;
  comment?: string | null;
  created_at?: string;
}

/* Payment plans and subscriptions */

export type FlutterwaveV3PlanInterval =
  | 'hourly'
  | 'daily'
  | 'weekly'
  | 'monthly'
  | 'quarterly'
  | 'yearly'
  | (string & {});

export interface FlutterwaveV3PaymentPlan {
  id: number;
  name: string;
  amount: number;
  interval: FlutterwaveV3PlanInterval;
  /** How many times to charge; `0` means until cancelled. */
  duration: number;
  status: string;
  currency: string;
  plan_token?: string;
  created_at?: string;
}

export type FlutterwaveV3SubscriptionStatus =
  | 'active'
  | 'cancelled'
  | (string & {});

export interface FlutterwaveV3Subscription {
  id: number;
  amount: number;
  customer: { id: number; customer_email: string };
  /** Payment plan id. */
  plan: number;
  status: FlutterwaveV3SubscriptionStatus;
  created_at: string;
}

/* Requests */

export interface FlutterwaveV3CardDetails {
  number: string;
  cvv: string;
  /** Two digits, e.g. `09`. */
  expiry_month: string;
  /** Two digits, e.g. `32`. */
  expiry_year: string;
}

export interface FlutterwaveV3HostedPaymentRequest {
  tx_ref: string;
  amount: number;
  currency: string;
  redirect_url: string;
  customer: { email: string; name?: string; phone_number?: string };
  payment_plan?: number;
  payment_options?: string;
  configuration?: {
    /** Minutes the checkout stays payable, at most 1440. */
    session_duration?: number;
    max_retry_attempt?: number;
  };
  customizations?: {
    title?: string;
    logo?: string;
    description?: string;
  };
  meta?: Record<string, string>;
}

export interface FlutterwaveV3RefundRequest {
  /** Omit to refund the full amount. */
  amount?: number;
  comments?: string;
}

/* Webhooks */

/**
 * A webhook in the wrapped format Flutterwave documents:
 * `{ event, data }`. Used for e.g. `charge.completed` and
 * `subscription.cancelled`.
 */
export interface FlutterwaveV3WebhookEnvelope<T = unknown> {
  event: string;
  'event.type'?: string;
  data: T;
}

/**
 * Charge webhooks sent to a sandbox arrive as a bare object in the
 * legacy camelCase shape, with no `event` wrapper.
 */
export interface FlutterwaveV3LegacyChargeWebhook {
  id: number;
  txRef: string;
  flwRef: string;
  amount: number;
  charged_amount?: number;
  currency: string;
  /** `successful`, `failed` or `pending-capture`. */
  status: string;
  charge_type?: string;
  paymentPlan?: number | null;
  customer?: { id: number; email: string; fullName?: string };
  'event.type'?: string;
}

/** Refund webhooks are bare objects too, in PascalCase. */
export interface FlutterwaveV3LegacyRefundWebhook {
  id: number;
  AmountRefunded: number;
  status: string;
  FlwRef?: string;
  comments?: string | null;
  TransactionId?: number;
}

export interface FlutterwaveV3SubscriptionCancelledEventData {
  id?: string;
  status: string;
  currency: string;
  amount: number;
  customer: { email: string; full_name?: string };
  plan: {
    id: number;
    name?: string;
    amount?: number;
    currency?: string;
    interval?: FlutterwaveV3PlanInterval;
    duration?: number;
    status?: string;
    date_created?: string;
  };
}

export interface FlutterwaveV3EventPayloadMap {
  'charge.completed':
    | FlutterwaveV3LegacyChargeWebhook
    | FlutterwaveV3Transaction;
  'refund.completed': FlutterwaveV3LegacyRefundWebhook;
  'subscription.cancelled': FlutterwaveV3SubscriptionCancelledEventData;
}
