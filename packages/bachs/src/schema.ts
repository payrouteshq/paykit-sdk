/**
 * Raw types for the Bachs API, sourced directly from Bachs' official
 * OpenAPI spec (https://docs.bachs.io/docs/openapi/openapi.json).
 *
 * Bachs has no direct "create payment" endpoint - every payment
 * originates from a checkout session (POST /v1/checkout-sessions).
 * The checkout session IS the resource; the "charge" it produces is a
 * nested sub-resource that only exists once the customer completes
 * payment (`checkout.charge` is `null` until then).
 *
 * The spec leaves `required` off a number of its schemas. Where it does,
 * a response type marks every field present and a request type marks
 * every field optional, since that is what the endpoints actually do.
 */

/* Status unions shared across the resources below */

export type BachsChargeStatus =
  | 'created'
  | 'processing'
  | 'succeeded'
  | 'accepted'
  | 'failed'
  | 'expired'
  | 'cancelled'
  | 'refunded'
  | 'partially_refunded'
  | 'underpaid'
  | 'overpaid';

export type BachsCheckoutStatus =
  | 'open'
  | 'completed'
  | 'expired'
  | 'cancelled';

export type BachsSubscriptionStatus =
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'unpaid'
  | 'canceled'
  | 'paused';

export type BachsRefundStatus = 'processing' | 'success' | 'failed';

/**
 * Every event type a webhook endpoint can subscribe to. The three
 * Connect events (`account.updated`, `capability.updated`,
 * `transfer.created`) are delivered by `event_source` rather than
 * subscription, so they are not listed here.
 */
export type BachsWebhookEventType =
  | 'checkout.completed'
  | 'checkout.expired'
  | 'collection.succeeded'
  | 'collection.failed'
  | 'collection.underpaid'
  | 'customer.subscription.created'
  | 'customer.subscription.updated'
  | 'customer.subscription.deleted'
  | 'invoice.created'
  | 'invoice.paid'
  | 'invoice.payment_failed'
  | 'payout.created'
  | 'payout.paid'
  | 'payout.failed'
  | 'refund.created'
  | 'refund.paid'
  | 'refund.failed'
  | 'dispute.created'
  | 'dispute.updated'
  | 'conversion.completed'
  | 'conversion.failed'
  | 'customer.created'
  | 'customer.updated';

/* Shared */

/**
 * Standard error response format used across all API endpoints
 */
export interface BachsErrorResponse {
  /**
   * Human-readable error message explaining what went wrong.
   */
  detail: string;
  /**
   * Machine-readable error code. Use this to handle errors
   * programmatically. Common codes: VALIDATION_ERROR, UNAUTHORIZED,
   * FORBIDDEN, NOT_FOUND, CONFLICT, TOO_MANY_REQUESTS,
   * INTERNAL_SERVER_ERROR, BAD_GATEWAY, SERVICE_UNAVAILABLE.
   */
  error_code: string;
  /**
   * Optional array of field-level validation errors. Only present for
   * validation errors (400).
   */
  errors?: Array<{
    /**
     * The field that failed validation.
     */
    field: string;
    /**
     * Description of the validation failure.
     */
    message: string;
    /**
     * Error type identifier.
     */
    type: string;
  }>;
}

export interface BachsPaginationResponse {
  next_cursor: string | null;
  prev_cursor: string | null;
  has_more: boolean;
  limit: number;
  offset: number;
  returned: number;
  total: number;
}

/**
 * Pagination details for a payments list.
 */
export interface BachsPaymentPagination {
  /**
   * Cursor for the next page, or `null` on the last page.
   */
  next_cursor?: string | null;
  /**
   * Cursor for the previous page, or `null` on the first page.
   */
  prev_cursor?: string | null;
  /**
   * Whether more results exist after this page.
   */
  has_more: boolean;
  /**
   * The page size that was applied.
   */
  limit: number;
  /**
   * The offset that was applied.
   */
  offset: number;
  /**
   * Number of items returned on this page.
   */
  returned: number;
  /**
   * Total number of payments matching the query.
   */
  total: number;
}

export interface BachsSubscriptionPagination {
  /**
   * Cursor for the next page, or `null` on the last page.
   */
  next_cursor: string | null;
  /**
   * Cursor for the previous page, or `null` on the first page.
   */
  prev_cursor: string | null;
  /**
   * Whether more results exist after this page.
   */
  has_more: boolean;
  /**
   * The page size that was applied.
   */
  limit: number;
  /**
   * The offset that was applied.
   */
  offset: number;
  /**
   * The number of items returned on this page.
   */
  returned: number;
  /**
   * Total number of subscriptions matching the query.
   */
  total: number;
}

export interface BachsMediaItemResponse {
  id: string;
  url: string | null;
  file_name: string;
  mime_type: string;
  file_size_bytes: number;
  created_at: string;
}

/* Checkout sessions */

export interface BachsNewCustomerRequest {
  /**
   * Customer email address.
   */
  email: string;
  /**
   * Customer full name.
   */
  name: string;
  /**
   * Customer phone number.
   */
  phone_number?: string | null;
}

export interface BachsExistingCustomerRequest {
  /**
   * Existing customer ID.
   */
  customer_id: string;
}

export interface BachsProductItemRequest {
  /**
   * Product ID to include in checkout.
   */
  product_id: string;
  /**
   * Number of units for the product item.
   */
  quantity?: number;
  /**
   * Chosen amount for a pay-what-you-want price. For a catalog CUSTOM
   * product, or an ad-hoc CUSTOM price (pre-filling the buyer's
   * amount).
   */
  amount?: string | null;
  pricing?: BachsAdhocPriceInput | null;
}

/**
 * Ad-hoc price override for this checkout only (no product is
 * created). Priced in the product's primary currency. Supports the
 * same price types as catalog prices: `fixed`, `custom`, `free`.
 */
export interface BachsAdhocPriceInput {
  /**
   * `fixed` sets a set amount via `amount`. `custom` is pay-what-you-
   * want, bounded by `minimum_amount`/`maximum_amount` with an
   * optional `preset_amount`; the buyer picks the amount at checkout.
   * `free` is a $0 line that completes without payment; on a
   * recurring product it creates a free subscription (no card, renews
   * with no charge).
   */
  price_type?: 'fixed' | 'custom' | 'free';
  /**
   * The price, for a `fixed` ad-hoc price. Required for `fixed`; not
   * valid for `custom`.
   */
  amount?: string | null;
  /**
   * Suggested starting amount for a `custom` ad-hoc price.
   */
  preset_amount?: string | null;
  /**
   * Lower bound for a `custom` ad-hoc price.
   */
  minimum_amount?: string | null;
  /**
   * Upper bound for a `custom` ad-hoc price.
   */
  maximum_amount?: string | null;
}

export interface BachsMerchantIntent {
  /**
   * Base currency code (e.g., 'USD', 'NGN'). Must be a supported fiat
   * currency.
   */
  currency: string;
  /**
   * Base amount as decimal string. Required for a fixed price; omit
   * for a custom (buyer-entered) or free price. Minimum 100 for
   * `NGN`, 1 for `USD` (and per-currency minimums for other supported
   * currencies).
   */
  amount?: string;
  /**
   * `fixed` (default when amount is set) | `custom` (buyer enters the
   * amount at checkout, within optional bounds, via the checkout-
   * level set-amount) | `free` ($0).
   */
  price_type?: 'fixed' | 'custom' | 'free';
  /**
   * Suggested starting amount for a custom price.
   */
  preset_amount?: string;
  /**
   * Lower bound for a custom price.
   */
  minimum_amount?: string;
  /**
   * Upper bound for a custom price.
   */
  maximum_amount?: string;
  /**
   * Currency-specific pricing overrides. Keys are fiat currency
   * codes, values are decimal amount strings.
   */
  currency_options?: Record<string, string>;
}

export interface BachsCreateCheckoutSessionRequest {
  /**
   * Optional checkout billing currency. If omitted, defaults to
   * product pricing currency.
   */
  billing_currency?: string | null;
  /**
   * Restricts the checkout to specific payment methods and, within
   * each, specific currencies. Keys are exact payment-method
   * corridors, not payment types: `USD_CARD` and `NGN_CARD` are
   * separate corridors, as is each of the nine mobile money
   * corridors. Valid keys: `USD_CARD` (US card, USD), `NGN_CARD`
   * (Nigerian card, NGN), `NGN_BANK_TRANSFER` (Nigerian bank
   * transfer, NGN), `MOMO_GHS` (Ghana mobile money), `MOMO_KES`
   * (Kenya mobile money), `MOMO_TZS` (Tanzania mobile money),
   * `MOMO_UGX` (Uganda mobile money), `MOMO_XAF` (Central Africa CFA
   * mobile money), `MOMO_XOF` (West Africa CFA mobile money),
   * `MOMO_RWF` (Rwanda mobile money), `MOMO_MWK` (Malawi mobile
   * money), `MOMO_ZMW` (Zambia mobile money), and `CRYPTO` (all
   * supported crypto assets). A corridor you leave out is not
   * offered. Restricting only narrows what the customer sees: it
   * never adds a corridor or a currency your account is not already
   * enabled for. If the restriction leaves no payable method, the
   * request is rejected.
   */
  payment_method_options?: Record<
    string,
    {
      /**
       * Narrows the corridor further. Every corridor except `CRYPTO`
       * names one currency in its key, so this field changes nothing
       * there. Use it for `CRYPTO`, which accepts asset codes such as
       * `USDT_TRC20`, not ISO 4217 currency codes. Omit it to offer
       * everything the corridor supports.
       */
      currencies?: string[];
    }
  > | null;
  /**
   * Where to send the customer if they cancel or abandon the
   * checkout. Returned on the checkout so the hosted page can route
   * back to it.
   */
  cancel_url?: string | null;
  /**
   * Deprecated alias for `success_url`, kept for backward
   * compatibility. If both are set, `success_url` wins.
   */
  return_url?: string | null;
  /**
   * Where to redirect the customer after a successful payment. Bachs
   * appends `?checkout_id=<id>`. This is the primary success-redirect
   * field.
   */
  success_url?: string;
  /**
   * Customer details for the checkout session.
   */
  customer: BachsExistingCustomerRequest | BachsNewCustomerRequest;
  /**
   * Optional metadata (max 20 keys, max 10KB total).
   */
  metadata?: Record<string, unknown> | null;
  /**
   * Catalog products to include in this checkout session. Mutually
   * exclusive with `pricing`.
   */
  product_cart?: BachsProductItemRequest[];
  /**
   * Raw pricing for a product-less (pure) checkout. Mutually
   * exclusive with `product_cart`.
   */
  pricing?: BachsMerchantIntent | null;
  /**
   * The platform's cut of this sale, in the base currency of the
   * sale, taken from the merchant's proceeds rather than from Bachs's
   * processing fee. On a destination charge, this is one of two ways
   * to state the split: the account receives the gross minus this
   * amount. Mutually exclusive with `transfer_data.amount`. A
   * destination charge needs one of the two; a direct charge can set
   * this alone to move part of its own charge up to the platform. See
   * [Platform fees](/connect/platform-fees).
   */
  platform_fee?: string | null;
  /**
   * Names the account this checkout pays out to. Its presence, on its
   * own, is what makes this a destination charge belonging to your
   * platform rather than the account. A destination charge needs a
   * split term: either `platform_fee` on the request root, or
   * `transfer_data.amount` here. Omit `transfer_data` entirely, and
   * act as the account with `X-Account-Id` instead, for a direct
   * charge. See [Destination charges](/connect/split-
   * payments/destination).
   */
  transfer_data?: BachsTransferDataInput | null;
  /**
   * Your own reference for this session, unique per account. Omit it
   * and the session has none; use the session's `id` to track it.
   */
  reference?: string | null;
  /**
   * Minutes until the checkout session expires. Defaults to 60. After
   * expiry the checkout URL is invalid.
   */
  expires_in_minutes?: number;
}

/**
 * Response containing checkout session details and hosted checkout
 * URL.
 */
export interface BachsCreateCheckoutSessionResponse {
  /**
   * Unique identifier for the underlying checkout.
   */
  checkout_id: string;
  /**
   * Hosted checkout URL where your customer can complete payment.
   */
  checkout_url: string;
  /**
   * Current checkout status. `open`: awaiting customer payment, where
   * every new session starts. `completed`: payment succeeded, a
   * terminal state. `expired`: the session window elapsed before
   * payment, a terminal state. `cancelled`: cancelled before
   * completion, a terminal state.
   */
  status: BachsCheckoutStatus;
  /**
   * ISO 8601 timestamp indicating when the checkout will expire.
   * After this time, customers cannot complete payment through this
   * checkout.
   */
  expires_at: string;
  /**
   * ISO 8601 timestamp indicating when the checkout was created.
   */
  created_at: string;
  /**
   * Your own reference for this checkout, echoed back unchanged.
   * `null` when you did not supply one.
   */
  reference: string | null;
  /**
   * The platform's cut of this sale, echoed back from the request, in
   * the base currency of the sale. The key is always present; it
   * reads `null`, not `"0.00"`, on a checkout that carries no fee,
   * and on a checkout that split the sale with `transfer_data.amount`
   * instead. See [Platform fees](/connect/platform-fees).
   */
  platform_fee: string | null;
  /**
   * The seller's contracted share of this sale, echoed back from
   * `transfer_data.amount`, in the base currency of the sale. Null on
   * a checkout that carries no split, and on one that split the sale
   * with `platform_fee` instead.
   */
  destination_amount: string | null;
}

/**
 * A resolved product line item within a checkout session.
 */
export interface BachsResolvedProductItem {
  /**
   * Product identifier.
   */
  product_id: string;
  /**
   * Product display name.
   */
  product_name: string;
  /**
   * Number of units.
   */
  quantity: number;
  /**
   * Price per unit in `currency`.
   */
  unit_amount: string;
  /**
   * Currency code for this line item.
   */
  currency: string;
  /**
   * How the product is priced. `fixed`: a set amount, given in
   * `amount`. `free`: no charge. `custom`: the customer pays what
   * they want, bounded by `minimum_amount` and `maximum_amount` with
   * an optional `preset_amount` suggestion.
   */
  price_type: 'fixed' | 'free' | 'custom';
  /**
   * Minimum allowed amount when `price_type` is true.
   */
  minimum_amount?: string | null;
  /**
   * Maximum allowed amount when `price_type` is true.
   */
  maximum_amount?: string | null;
  /**
   * Total for this line item (`unit_amount` × `quantity`).
   */
  line_total: string;
}

/**
 * The customer attached to the checkout.
 */
export interface BachsCheckoutCustomer {
  /**
   * The customer's ID, once resolved. `null` until a customer is
   * matched or created.
   */
  id?: string | null;
  /**
   * The customer's email address.
   */
  email: string;
  /**
   * The customer's name. `null` when not provided.
   */
  name?: string | null;
}

/**
 * The recurring cadence when the checkout starts a subscription.
 * `null` for a one-time checkout.
 */
export interface BachsCheckoutRecurring {
  /**
   * The billing interval.
   */
  interval: 'day' | 'week' | 'month' | 'year';
  /**
   * Number of intervals per billing cycle.
   */
  interval_count?: number;
}

/**
 * Checkout session details returned by `GET /v1/checkout-
 * sessions/{checkout_id}`.
 */
export interface BachsCheckoutSessionApiResponse {
  /**
   * Unique checkout identifier.
   */
  checkout_id: string;
  /**
   * Current lifecycle status of the checkout session. `open`:
   * awaiting customer payment, where every new session starts.
   * `completed`: payment succeeded, a terminal state. `expired`: the
   * session window elapsed before payment, a terminal state.
   * `cancelled`: cancelled before completion, a terminal state.
   */
  status: BachsCheckoutStatus;
  /**
   * Present only for a subscription checkout; `null` for a one-time
   * checkout.
   */
  recurring?: BachsCheckoutRecurring | null;
  /**
   * Payment lifecycle for the checkout. `requires_payment_method`,
   * `requires_confirmation`, `requires_action`, `processing`,
   * `succeeded`, `failed`, or `canceled`.
   */
  payment_status?:
    | (
        | 'requires_payment_method'
        | 'requires_confirmation'
        | 'requires_action'
        | 'processing'
        | 'succeeded'
        | 'failed'
        | 'canceled'
      )
    | null;
  /**
   * What created the checkout, e.g. `CHECKOUT_SESSION` or `API`.
   */
  source_type?: string | null;
  /**
   * Total amount in `currency`.
   */
  amount: string;
  /**
   * Base currency code.
   */
  currency: string;
  /**
   * The reference you set when you created the session. `null` if you
   * set none.
   */
  reference?: string | null;
  /**
   * The payment created by this checkout, once payment has been
   * attempted. `null` before then.
   */
  charge?: BachsPaymentResponse | null;
  /**
   * The payment method selected for the checkout, if any. For every
   * method except card, this is the exact corridor collected, such as
   * `NGN_BANK_TRANSFER`, `MOMO_GHS`, or `CRYPTO`. Card charges report
   * `CARD` rather than `USD_CARD` or `NGN_CARD`; read the currency to
   * tell which card corridor collected it.
   */
  payment_method?: string | null;
  customer: BachsCheckoutCustomer;
  /**
   * URL the customer is redirected to after successful payment.
   */
  success_url?: string | null;
  /**
   * URL the customer is redirected to if they cancel.
   */
  cancel_url?: string | null;
  /**
   * Resolved product line items. Populated for `CART` sessions; may
   * be `null` for `SELECTION` sessions before the customer picks a
   * product.
   */
  products?: BachsResolvedProductItem[] | null;
  /**
   * Currency the customer selected for billing.
   */
  billing_currency?: string | null;
  /**
   * The platform's cut of this sale, in the base currency of the
   * sale. The key is always present; it reads `null`, not `"0.00"`,
   * on a checkout that carries no fee, and on a checkout that split
   * the sale with `transfer_data.amount` instead. See [Platform
   * fees](/connect/platform-fees).
   */
  platform_fee?: string | null;
  /**
   * The seller's contracted share of this sale, in the base currency
   * of the sale. Null on a checkout that carries no split, and on one
   * that split the sale with `platform_fee` instead.
   */
  destination_amount?: string | null;
  /**
   * How products are presented. `CART` sums a fixed set of items;
   * `SELECTION` lets the customer pick one from a group.
   */
  session_mode?: ('CART' | 'SELECTION') | null;
  /**
   * Public metadata you attached at session creation.
   */
  metadata?: Record<string, unknown> | null;
  /**
   * ISO 8601 creation timestamp.
   */
  created_at: string;
  /**
   * ISO 8601 expiry timestamp.
   */
  expires_at?: string | null;
  /**
   * ISO 8601 timestamp when the session was completed.
   */
  completed_at?: string | null;
  /**
   * ISO 8601 last-updated timestamp.
   */
  updated_at: string;
}

/**
 * Complete payment details including current status, payment
 * information, and status history
 */
export interface BachsChargeStatusResponse {
  /**
   * Unique identifier for this payment/payment. Use this ID to track
   * the payment status.
   */
  charge_id: string;
  /**
   * Organization ID that created this payment.
   */
  organization_id: string;
  /**
   * Customer identifier associated with this payment.
   */
  customer_id: string;
  /**
   * Amount the customer paid, in the payment currency. This is a
   * decimal string for precision.
   */
  amount: string;
  /**
   * Currency code that the customer paid in (e.g., 'NGN', 'USD',
   * 'GHS').
   */
  currency: string;
  /**
   * Currency code you will receive settlement in. This may differ
   * from the payment currency.
   */
  settlement_currency: string;
  /**
   * Amount you will receive after fees are deducted, in
   * settlement_currency. This is a decimal string for precision.
   */
  settlement_amount: string;
  /**
   * Current status of the charge. `created`: the charge exists and no
   * attempt has succeeded yet. `processing`: an attempt is in flight
   * with the provider. `succeeded`: an attempt succeeded and the
   * charge is paid in full. `accepted`: an underpayment or
   * overpayment was accepted as final settlement. `underpaid`: the
   * customer paid less than the amount owed. `overpaid`: the customer
   * paid more than the amount owed. `failed`: every attempt failed,
   * or the charge was given up on. `expired`: the payment window
   * elapsed before any payment arrived. `cancelled`: cancelled before
   * any payment succeeded. `refunded`: the full amount was returned
   * to the customer. `partially_refunded`: part of the amount was
   * returned to the customer.
   */
  status: BachsChargeStatus;
  /**
   * Custom metadata you provided when creating the checkout. This can
   * include order IDs, product SKUs, or any other relevant
   * information.
   */
  metadata: Record<string, unknown>;
  /**
   * Every status this charge has held, oldest first. Read it to
   * reconstruct the lifecycle when you missed a webhook.
   */
  status_history: Array<{
    /**
     * The status the charge moved to, from the same set as `status`.
     */
    status: string;
    /**
     * ISO 8601 timestamp of when the charge moved to this status.
     */
    occurred_at: string;
    /**
     * Why the charge moved to this status, when we have a reason to
     * give. `null` otherwise.
     */
    reason: string | null;
  }>;
  /**
   * ISO 8601 timestamp when the payment was created.
   */
  created_at: string;
  /**
   * ISO 8601 timestamp when the payment was last updated.
   */
  updated_at: string;
}

/* Payments */

/**
 * A product line item purchased in this payment.
 */
export interface BachsPaymentProductItem {
  /**
   * Product identifier.
   */
  product_id: string;
  /**
   * Product display name.
   */
  product_name: string;
  /**
   * Number of units purchased.
   */
  quantity: number;
  /**
   * Price per unit in `currency`.
   */
  unit_amount: string;
  /**
   * Currency code for this line item.
   */
  currency: string;
  /**
   * Total for this line item (`unit_amount` × `quantity`).
   */
  line_total: string;
}

/**
 * A subscription invoice this payment collected.
 */
export interface BachsPaymentInvoiceInfo {
  /**
   * The invoice's identifier.
   */
  invoice_id: string;
  /**
   * Human-facing invoice number, if assigned.
   */
  number?: string | null;
  /**
   * The subscription the invoice belongs to.
   */
  subscription_id?: string | null;
  /**
   * Start of the billing period, UTC.
   */
  period_start?: string;
  /**
   * End of the billing period, UTC.
   */
  period_end?: string;
  /**
   * `cycle`: a regular subscription-period invoice. `proration`: an
   * off-cycle mid-cycle change.
   */
  kind?: 'cycle' | 'proration';
}

/**
 * Detailed payment response for API integrations.
 */
export interface BachsPaymentResponse {
  /**
   * Checkout reference when available.
   */
  reference?: string | null;
  /**
   * Unique identifier for the payment.
   */
  payment_id: string;
  /**
   * Why this payment exists. `purchase`: a one-time purchase.
   * `subscription_create`: the first cycle of a new subscription.
   * `subscription_cycle`: a subscription renewal.
   * `subscription_update`: an off-cycle charge from a mid-cycle plan
   * change (proration).
   */
  billing_reason?:
    | 'purchase'
    | 'subscription_create'
    | 'subscription_cycle'
    | 'subscription_update';
  /**
   * Checkout identifier, when linked.
   */
  checkout_id?: string | null;
  /**
   * Current status of the payment. `created`: the charge exists and
   * no attempt has succeeded yet. `processing`: an attempt is in
   * flight and is being verified. `succeeded`: the payment is
   * confirmed and settled in full. `accepted`: an underpayment or
   * overpayment was accepted as final settlement. `failed`: the
   * payment failed and no funds were captured. `expired`: the payment
   * window elapsed before any payment arrived. `cancelled`: cancelled
   * before completion. `refunded`: the full amount was returned to
   * the customer. `partially_refunded`: part of the amount was
   * returned to the customer. `underpaid`: the customer paid less
   * than the amount owed. `overpaid`: the customer paid more than the
   * amount owed.
   */
  status: BachsChargeStatus;
  /**
   * Whether this payment can currently be refunded.
   */
  is_refundable?: boolean | null;
  /**
   * Requested amount in `currency`.
   */
  amount: string;
  /**
   * Amount received so far.
   */
  amount_paid?: string | null;
  /**
   * Remaining amount still expected.
   */
  amount_remaining?: string | null;
  /**
   * Payment currency code.
   */
  currency: string;
  /**
   * Processing fee for this payment, converted to USD and expressed
   * as a decimal string. `null` until the payment settles.
   */
  fee_usd?: string | null;
  /**
   * Whether merchant bears processing cost.
   */
  merchant_bears_cost?: boolean | null;
  /**
   * What the platform took out of this sale, beside the gross it was
   * taken from, in the base currency of the sale. `null` when the
   * charge carried no platform fee, and on a charge that split the
   * sale with `transfer_data.amount` instead. See [Platform
   * fees](/connect/platform-fees).
   */
  platform_fee?: string | null;
  /**
   * The seller's contracted share of this sale, in the base currency
   * of the sale. Null on a charge that carries no split, and on one
   * that split the sale with `platform_fee` instead.
   */
  destination_amount?: string | null;
  /**
   * Who Bachs's processing fee actually came from on this charge,
   * read back from the ledger posting rather than a flag decided in
   * advance. `merchant`: the fee came out of the charge. `platform`:
   * the platform's own balance covered it. On a destination charge
   * this never reads `platform`; the fee always comes from the charge
   * there. See [Processing fees](/connect/processing-fees).
   */
  fee_paid_by?: ('merchant' | 'platform') | null;
  /**
   * Payment method used for this payment. For every method except
   * card, this is the exact corridor collected, such as
   * `NGN_BANK_TRANSFER`, `MOMO_GHS`, or `CRYPTO`. Card charges report
   * `CARD` rather than `USD_CARD` or `NGN_CARD`; read the currency to
   * tell which card corridor collected it.
   */
  payment_method?: string | null;
  /**
   * Origin channel (for example `api`).
   */
  channel?: string | null;
  /**
   * payment description/narration.
   */
  narration?: string | null;
  /**
   * Public metadata stored for this payment.
   */
  meta?: Record<string, unknown> | null;
  /**
   * Human-readable payment message derived from status.
   */
  message?: string | null;
  /**
   * Customer information when available.
   */
  customer?: {
    /**
     * Full name of the customer associated with this payment, when
     * captured.
     */
    name: string | null;
    /**
     * Customer email address associated with this payment, when
     * captured.
     */
    email: string | null;
  } | null;
  /**
   * The line items this payment covers.
   */
  line_items?: BachsPaymentProductItem[] | null;
  /**
   * The subscription this payment belongs to, or `null` for a one-
   * time purchase.
   */
  subscription_id?: string | null;
  /**
   * The invoice this payment collected. Present only for subscription
   * payments; `null` for one-time purchases.
   */
  invoice?: BachsPaymentInvoiceInfo | null;
  /**
   * IDs of any refunds issued for this payment. `null` if no refund
   * has been created.
   */
  refunds?: string[] | null;
  /**
   * Chronological list of status changes for this payment.
   */
  status_history?: Array<{
    /**
     * Status at this point in time.
     */
    status: string;
    /**
     * When this status change occurred.
     */
    occurred_at: string;
    /**
     * Human-readable reason for the status change, if available.
     */
    reason: string | null;
  }> | null;
  /**
   * Creation timestamp.
   */
  created_at: string;
  /**
   * Last update timestamp.
   */
  updated_at: string;
  /**
   * Completion timestamp when available.
   */
  completed_at?: string | null;
}

/**
 * Paginated list representation of a payment record.
 */
export interface BachsPaymentListItemResponse {
  /**
   * Checkout reference for this payment when available.
   */
  reference?: string | null;
  /**
   * payment ID for retrieval and reconciliation.
   */
  id?: string | null;
  /**
   * Current payment status for this payment.
   */
  status: string;
  /**
   * Whether this payment is currently eligible for refund operations.
   */
  is_refundable?: boolean | null;
  /**
   * Requested payment amount in `currency`.
   */
  amount: string;
  /**
   * Customer full name from checkout data. May be empty when
   * unavailable.
   */
  customer_name: string;
  /**
   * Customer email from checkout data. May be empty when unavailable.
   */
  customer_email: string;
  /**
   * Amount received so far for this payment.
   */
  amount_paid?: string | null;
  /**
   * Remaining amount expected before full completion.
   */
  amount_remaining?: string | null;
  /**
   * Settlement-side amount captured for this payment.
   */
  settlement_amount?: string | null;
  /**
   * Settlement currency code for `settlement_amount`.
   */
  settlement_currency?: string | null;
  /**
   * Reserved fee field in list responses. May be null.
   */
  fee?: string | null;
  /**
   * Reserved VAT field in list responses. May be null.
   */
  vat?: string | null;
  /**
   * Payment currency code.
   */
  currency: string;
  /**
   * Public metadata attached to the payment when available.
   */
  meta?: Record<string, unknown> | null;
  /**
   * ISO 8601 timestamp when the payment was created.
   */
  transaction_date?: string | null;
  /**
   * ISO 8601 timestamp when the payment reached a successful terminal
   * state.
   */
  completed_at?: string | null;
  /**
   * On a destination charge stated fee-first, the platform's cut of
   * this sale, as a decimal string in `currency`. Null on every other
   * payment, including one whose split was stated share-first.
   */
  platform_fee?: string | null;
  /**
   * On a destination charge stated share-first, the amount the
   * connected account receives, as a decimal string. Null on every
   * other payment, including one whose split was stated fee-first.
   */
  destination_amount?: string | null;
  /**
   * Who Bachs's processing fee came from on this charge. `merchant`
   * means it came out of the charge itself. `platform` means the
   * platform's own balance covered it. Null until the charge settles,
   * because the outcome is not decided before then.
   */
  fee_paid_by?: ('merchant' | 'platform') | null;
}

/**
 * A paginated list of payments.
 */
export interface BachsPaymentListResponse {
  /**
   * Payments for the current page.
   */
  items: BachsPaymentListItemResponse[];
  pagination: BachsPaymentPagination;
}

/**
 * Response containing supported payment methods.
 */
export interface BachsPaymentMethodsResponse {
  /**
   * List of payment methods available to the authenticated account in
   * the current environment.
   */
  payment_methods: Array<{
    /**
     * Payment method identifier.
     */
    id: string;
    /**
     * Human-readable payment method name.
     */
    display_name: string;
    /**
     * Icon or token representing the method.
     */
    icon: string;
    /**
     * Developer-facing payment method description.
     */
    description: string;
    /**
     * Method type (for example `fiat` or `crypto`).
     */
    type: string;
    /**
     * Whether enabled by default for accounts.
     */
    enabled_by_default: boolean;
    /**
     * Currencies supported for this method.
     */
    currencies: string[];
  }>;
}

/**
 * Supported payment rail option
 */
export interface BachsPaymentRailOption {
  /**
   * Rail identifier. Use this value as the 'payment_rail' parameter
   * when creating quotes.
   */
  id: string;
  /**
   * Human-readable rail name
   */
  name?: string | null;
  /**
   * Whether the rail is currently active and available for use
   */
  active?: boolean | null;
}

/**
 * Response containing available rails for a method and currency.
 */
export interface BachsPaymentRailsResponse {
  /**
   * Payment method requested.
   */
  payment_method: string;
  /**
   * Currency requested.
   */
  currency: string;
  /**
   * Resolved country code for this rail lookup.
   */
  country_code?: string | null;
  /**
   * Available rails for this method and currency.
   */
  rails: BachsPaymentRailOption[];
}

/* Refunds */

export interface BachsCreateRefundRequest {
  /**
   * The ID of the payment to refund.
   */
  charge_id: string;
  /**
   * Your unique identifier for this refund. Must be unique per
   * account and environment.
   */
  reference: string;
  /**
   * Destination wallet address for crypto refunds. Required when the
   * charge currency is a cryptocurrency.
   */
  refund_address?: string | null;
  /**
   * Optional partial refund amount in the charge settlement currency.
   * Omit to refund the full remaining refundable balance.
   */
  amount?: string | null;
  /**
   * Who absorbs the refund fee. `org`: the fee is charged to your
   * balance on top of the amount returned. `customer`: the fee is
   * taken out of what the customer receives. Defaults to the fee
   * handling set on your account. Case is ignored.
   */
  fee_bearer?: ('org' | 'customer') | null;
  /**
   * Human-readable reason for the refund.
   */
  reason?: string | null;
  /**
   * A key you supply to make this request idempotent. If you send the
   * same idempotency_key twice for the same charge, the second
   * request returns the existing refund.
   */
  idempotency_key?: string | null;
  /**
   * Test mode only. Force a specific refund outcome. Omit to use the
   * default sandbox outcome.
   */
  simulated_outcome?: ('success' | 'failed') | null;
}

export interface BachsRefundResponse {
  /**
   * Pass this to retrieve the refund later.
   */
  refund_id: string;
  /**
   * The charge whose funds are being returned. A charge carries at
   * most one refund, so this value never appears on two refunds.
   */
  charge_id: string;
  /**
   * The reference you supplied on creation.
   */
  reference: string;
  /**
   * Where the refund has reached. `processing`: the return has been
   * accepted and your balance is already reserved, but the outcome is
   * not yet known. `success`: the funds have reached the customer;
   * this is final and cannot be reversed. `failed`: the return did
   * not go through and the reserved balance has been released; this
   * is also final, and because a charge accepts only one refund you
   * cannot create a second one for the same charge.
   */
  status: BachsRefundStatus;
  /**
   * The refund amount you requested, in the charge's settlement
   * currency.
   */
  requested_amount: string;
  /**
   * The amount actually returned to the customer. Null until the
   * refund completes or partially settles.
   */
  refunded_amount: string | null;
  /**
   * Fee charged for this refund, in the charge's settlement currency.
   * "0" if no fee applies.
   */
  refund_fee_amount: string;
  /**
   * Who absorbs the refund fee. `org`: the fee is charged to your
   * balance on top of the amount returned. `customer`: the fee is
   * taken out of what the customer receives.
   */
  fee_bearer: 'org' | 'customer';
  /**
   * The reason you provided, or null if none was given.
   */
  reason: string | null;
  /**
   * ISO 8601 timestamp when the refund was created.
   */
  created_at: string;
  /**
   * ISO 8601 timestamp of the last status update.
   */
  updated_at: string;
  /**
   * ISO 8601 timestamp when the refund reached a terminal status
   * (SUCCESS or FAILED). Null while still processing.
   */
  completed_at: string | null;
}

export interface BachsRefundListResponse {
  /**
   * Total number of refunds matching the query, across all pages.
   */
  total: number;
  /**
   * Refund objects for the current page.
   */
  items: BachsRefundResponse[];
}

/* Customers */

export interface BachsCreateCustomerRequest {
  /**
   * The customer's email address. Used to identify the customer and
   * send receipts.
   */
  email: string;
  /**
   * The customer's full name. Derived from `first_name` and
   * `last_name` when those are provided instead.
   */
  name?: string | null;
  /**
   * The customer's phone number in E.164 format, e.g.
   * `+2348012345678`.
   */
  phone_number?: string | null;
  /**
   * Your own key-value data attached to the customer, returned
   * unchanged.
   */
  metadata?: Record<string, unknown>;
  /**
   * The customer's billing address. Optional on create. `line1` and
   * `country` are required whenever an address is supplied; `country`
   * must be a real ISO-3166-1 alpha-2 code. An all-empty object is
   * rejected; omit the field or send `null` instead.
   */
  billing_address?: BachsCustomerBillingAddress | null;
}

export interface BachsUpdateCustomerRequest {
  /**
   * The customer's email address. Used to identify the customer and
   * send receipts.
   */
  email?: string | null;
  /**
   * The customer's full name. Derived from `first_name` and
   * `last_name` when those are provided instead.
   */
  name?: string | null;
  /**
   * The customer's phone number in E.164 format, e.g.
   * `+2348012345678`.
   */
  phone_number?: string | null;
  /**
   * Your own key-value data attached to the customer, returned
   * unchanged.
   */
  metadata?: Record<string, unknown> | null;
  /**
   * Omit this field to leave the billing address untouched. Send
   * `null` to clear it. Send an object to replace it in full. This is
   * not a merge, so any component you leave out of the object becomes
   * `null`, even if a value was previously stored. `line1` and
   * `country` are required whenever an object is supplied, and an
   * all-empty object is rejected; use explicit `null` to clear the
   * address instead. `name` and `phone_number` do not behave this
   * way; updating those merges normally.
   */
  billing_address?: BachsCustomerBillingAddress | null;
}

export interface BachsCustomerDetailResponse {
  /**
   * Unique identifier for the customer, prefixed with `cust_`.
   */
  customer_id: string;
  /**
   * The customer's email address.
   */
  email: string;
  /**
   * The customer's full name. `null` when not set.
   */
  name?: string | null;
  /**
   * The customer's phone number in E.164 format, e.g.
   * `+2348012345678`.
   */
  phone_number?: string | null;
  /**
   * Your own key-value data attached to the customer.
   */
  metadata: Record<string, unknown>;
  /**
   * ISO 8601 timestamp when the customer was created.
   */
  created_at: string;
  /**
   * ISO 8601 timestamp when the customer was last updated.
   */
  updated_at: string;
  /**
   * The customer's billing address, or `null` if none is set.
   */
  billing_address?: BachsCustomerBillingAddress | null;
}

export interface BachsCustomerListItem {
  /**
   * Unique identifier for the customer, prefixed with `cust_`.
   */
  customer_id: string;
  /**
   * The customer's email address.
   */
  email: string;
  /**
   * The customer's full name. `null` when not set.
   */
  name?: string | null;
  /**
   * Your own key-value data attached to the customer.
   */
  metadata: Record<string, unknown>;
  /**
   * ISO 8601 timestamp when the customer was created.
   */
  created_at: string;
}

export interface BachsCustomerListResponse {
  /**
   * The customers on this page. Each item is a customer object.
   */
  items: BachsCustomerListItem[];
  /**
   * Pagination cursors and counts. See the Pagination guide.
   */
  pagination: {
    next_cursor: string | null;
    prev_cursor: string | null;
    has_more: boolean;
    limit: number;
    offset: number;
    returned: number;
    total: number;
  };
}

export interface BachsCustomer {
  /**
   * Unique identifier for the customer, prefixed with `cust_`.
   */
  customer_id: string;
  /**
   * The customer's email address.
   */
  email: string | null;
  /**
   * The customer's full name. `null` when not set.
   */
  name: string | null;
  /**
   * The customer's phone number in E.164 format, e.g.
   * `+2348012345678`.
   */
  phone_number: string | null;
  /**
   * Your own key-value data attached to the customer.
   */
  metadata: Record<string, unknown>;
  /**
   * ISO 8601 timestamp when the customer was created.
   */
  created_at: string | null;
  /**
   * ISO 8601 timestamp when the customer was last updated.
   */
  updated_at: string | null;
  /**
   * The customer's billing address, or `null` if none is set.
   */
  billing_address: BachsCustomerBillingAddress | null;
}

/**
 * A customer's billing address. Treated as one atomic value: on
 * update, a supplied object replaces every component rather than
 * merging with what's stored.
 */
export interface BachsCustomerBillingAddress {
  /**
   * Street address. Required whenever an address is supplied.
   */
  line1: string | null;
  /**
   * Apartment, suite, unit, etc. `null` when not set.
   */
  line2: string | null;
  /**
   * City, district, or suburb.
   */
  city: string | null;
  /**
   * State, province, or region.
   */
  state: string | null;
  /**
   * ZIP or postal code.
   */
  postal_code: string | null;
  /**
   * Two-letter ISO-3166-1 alpha-2 country code. Required whenever an
   * address is supplied.
   */
  country: string | null;
}

export interface BachsPortalSessionResponse {
  /**
   * The session identifier, prefixed with `psn_`. Use it to correlate
   * a session with your own logs; it is not a credential and cannot
   * be exchanged for access.
   */
  id: string;
  /**
   * The URL that opens the portal as this customer. It carries the
   * session credential, so it works on any device and must not be
   * logged or shared.
   */
  url: string;
}

/* Products */

export interface BachsPriceInput {
  /**
   * The product's primary currency, and the currency customers are
   * charged in by default. Any supported currency is allowed,
   * including one your account does not hold a balance in; those are
   * converted when the payment settles. It cannot be repeated in
   * `currency_options`.
   */
  currency:
    | 'USD'
    | 'NGN'
    | 'GHS'
    | 'KES'
    | 'MWK'
    | 'RWF'
    | 'TZS'
    | 'UGX'
    | 'XAF'
    | 'XOF'
    | 'ZMW';
  /**
   * How the product is priced. `fixed`: a set amount, given in
   * `amount`. `free`: no charge. `custom`: the customer pays what
   * they want, bounded by `minimum_amount` and `maximum_amount` with
   * an optional `preset_amount` suggestion.
   */
  price_type?: 'fixed' | 'free' | 'custom';
  /**
   * Price as a decimal string, e.g. `"29.00"`. Required when
   * `price_type` is `fixed`. Omit for `free` and `custom`.
   */
  amount?: string | null;
  /**
   * Suggested amount prefilled at checkout for a custom price, as a
   * decimal string. Only used when `price_type` is `custom`.
   */
  preset_amount?: string | null;
  /**
   * Least the customer can pay, as a decimal string. Only used when
   * `price_type` is `custom`. Set `"0.00"` to allow free (pay what
   * you want).
   */
  minimum_amount?: string | null;
  /**
   * Most the customer can pay, as a decimal string. Only used when
   * `price_type` is `custom`.
   */
  maximum_amount?: string | null;
  /**
   * Prices in other currencies. Each entry sets a price for one
   * additional currency, and cannot repeat the primary currency.
   */
  currency_options?: BachsCurrencyOptionInput[] | null;
}

export interface BachsUpdatePriceInput {
  /**
   * New price as a decimal in the major unit (e.g. `39.00`). Only
   * valid for fixed-price products.
   */
  amount?: string | null;
  /**
   * Full replacement of multi-currency prices. Omit to leave
   * unchanged.
   */
  currency_options?: BachsCurrencyOptionInput[] | null;
}

export interface BachsPriceResponse {
  currency: string;
  /**
   * How the product is priced. `fixed`: a set amount, given in
   * `amount`. `free`: no charge. `custom`: the customer pays what
   * they want, bounded by `minimum_amount` and `maximum_amount` with
   * an optional `preset_amount` suggestion.
   */
  price_type: 'fixed' | 'free' | 'custom';
  /**
   * Price in the primary currency as a decimal string.
   */
  amount: string;
  /**
   * Suggested amount prefilled at checkout for a custom price, as a
   * decimal string. Only used when `price_type` is `custom`.
   */
  preset_amount: string | null;
  /**
   * Minimum the customer must pay. Present only when `price_type` is
   * `custom`.
   */
  minimum_amount: string | null;
  /**
   * Maximum the customer may pay. Present only when `price_type` is
   * `custom`.
   */
  maximum_amount: string | null;
  currency_options: BachsCurrencyOptionResponse[];
}

export interface BachsCurrencyOptionInput {
  /**
   * An additional currency to price this product in (`USD`, `NGN`,
   * `GHS`, `KES`, `MWK`, `RWF`, `TZS`, `UGX`, `XAF`, `XOF`, `ZMW`).
   * Cannot be the primary currency.
   */
  currency: string;
  /**
   * Price as a decimal string, e.g. `"29.00"`. Required when
   * `price_type` is `fixed`. Omit for `free` and `custom`.
   */
  amount?: string | null;
  /**
   * Suggested amount prefilled at checkout for a custom price in this
   * currency, as a decimal string. Only used when `price_type` is
   * `custom`.
   */
  preset_amount?: string | null;
  /**
   * Least the customer can pay, as a decimal string. Only used when
   * `price_type` is `custom`. Set `"0.00"` to allow free (pay what
   * you want).
   */
  minimum_amount?: string | null;
  /**
   * Most the customer can pay, as a decimal string. Only used when
   * `price_type` is `custom`.
   */
  maximum_amount?: string | null;
}

export interface BachsCurrencyOptionResponse {
  currency: string;
  amount: string;
  minimum_amount: string | null;
  maximum_amount: string | null;
}

/**
 * The length of the free trial before the first charge, expressed as
 * a count of time units. For example, `{ "interval": "day",
 * "frequency": 14 }` is a 14-day trial.
 */
export interface BachsTrialPeriod {
  /**
   * The unit of time the trial is measured in: `day`, `week`,
   * `month`, or `year`.
   */
  interval: 'day' | 'week' | 'month' | 'year';
  /**
   * How many `interval` units the trial lasts. For example,
   * `interval` `day` with `frequency` `14` is a 14-day trial.
   */
  frequency: number;
}

export interface BachsCreateProductRequest {
  /**
   * Display name of the product. Shown to customers at checkout.
   */
  name: string;
  /**
   * Optional description of the product. Shown to customers at
   * checkout.
   */
  description?: string | null;
  /**
   * Primary price for the product. Provide an `amount` as a decimal
   * string and a `currency`.
   */
  price: BachsPriceInput;
  /**
   * Up to 20 key/value pairs for your own reference.
   */
  metadata?: Record<string, unknown> | null;
  /**
   * How often the product bills. Provide a cadence to make the
   * product recurring, or omit it for a one-time product.
   */
  billing_cycle?: BachsSubscriptionCadence | null;
  /**
   * A free trial before the first charge, given as a duration like `{
   * "interval": "day", "frequency": 14 }` for 14 days. The customer
   * isn't charged until the trial ends. Only valid on a recurring
   * product. Currently in beta.
   */
  trial_period?: BachsTrialPeriod | null;
}

export interface BachsUpdateProductRequest {
  /**
   * New display name for the product.
   */
  name?: string;
  /**
   * New description for the product.
   */
  description?: string | null;
  /**
   * Replace the product's key-value metadata.
   */
  metadata?: Record<string, unknown> | null;
  /**
   * Ordered list of upload IDs. Replaces existing media.
   */
  media?: string[];
  /**
   * Price fields to update. Omit to leave price unchanged.
   */
  price?: BachsUpdatePriceInput | null;
  /**
   * How often the product bills. Provide a cadence to make the
   * product recurring, or omit it for a one-time product.
   */
  billing_cycle?: BachsSubscriptionCadence | null;
  /**
   * A free trial before the first charge, given as a duration like `{
   * "interval": "day", "frequency": 14 }` for 14 days. The customer
   * isn't charged until the trial ends. Only valid on a recurring
   * product. Currently in beta.
   */
  trial_period?: BachsTrialPeriod | null;
}

export interface BachsProductResponse {
  /**
   * Unique identifier for the product, prefixed with `prod_`.
   */
  id: string;
  /**
   * The account that owns the product.
   */
  organization_id: string;
  /**
   * Display name of the product.
   */
  name: string;
  /**
   * Optional description of the product. `null` when not set.
   */
  description: string | null;
  /**
   * Primary price for the product, in the product's default currency.
   */
  price: BachsPriceResponse;
  /**
   * Status of the product. `active`: Live and available for use in
   * checkouts and subscriptions. `archived`: Retired. Kept for
   * reference but not available for new purchases.
   */
  status: 'active' | 'archived';
  /**
   * Your own key-value data attached to the product, returned
   * unchanged.
   */
  metadata: Record<string, unknown> | null;
  /**
   * Media items (images) attached to the product. Empty when none are
   * set.
   */
  media: BachsMediaItemResponse[];
  /**
   * Identifier of the user or key that created the product.
   */
  actor_id: string;
  /**
   * ISO 8601 timestamp when the product was created.
   */
  created_at: string;
  /**
   * ISO 8601 timestamp when the product was last updated.
   */
  updated_at: string;
  /**
   * When set, the product is archived and cannot be used in new
   * checkouts. `null` while the product is active.
   */
  archived_at: string | null;
  /**
   * How often the product bills. Provide a cadence to make the
   * product recurring, or omit it for a one-time product.
   */
  billing_cycle: BachsSubscriptionCadence | null;
  /**
   * A free trial before the first charge, given as a duration like `{
   * "interval": "day", "frequency": 14 }` for 14 days. The customer
   * isn't charged until the trial ends. Only valid on a recurring
   * product. Currently in beta.
   */
  trial_period: BachsTrialPeriod | null;
  /**
   * All prices configured on the product, one per currency. Each has
   * `currency`, `amount`, optional `minimum_amount` and
   * `maximum_amount`, and `is_default`.
   */
  prices: Array<Record<string, unknown>>;
  /**
   * Running count of completed payments for this product. Starts at
   * `0` and increments as customers pay.
   */
  total_payments: number;
  /**
   * Running total collected for this product, as a decimal string in
   * the product currency. Starts at `"0.00"`.
   */
  total_amount: string;
}

export interface BachsProductListResponse {
  /**
   * Pagination cursors and counts. See the Pagination guide.
   */
  pagination: BachsPaginationResponse;
  /**
   * The products on this page. Each item is a product object.
   */
  items: BachsProductResponse[];
}

export interface BachsCreateProductGroupRequest {
  /**
   * Label the customer sees above the plan choices when this bundle
   * is offered at checkout. 1 to 255 characters.
   */
  name: string;
  /**
   * The products to bundle, in the order you want them presented to
   * the customer. Every ID must be a product on your own account, and
   * at least one is required.
   */
  product_ids: string[];
}

export interface BachsUpdateProductGroupRequest {
  /**
   * Replacement label for the bundle, applied to every checkout that
   * offers it from the moment the request succeeds. Omit to leave the
   * current label alone.
   */
  name?: string;
  /**
   * Replacement membership for the bundle. What you send becomes the
   * complete list and the display order, so include every product you
   * want to keep, not only the ones you are adding.
   */
  product_ids?: string[];
}

export interface BachsProductGroupResponse {
  /**
   * Pass this wherever a bundle is referenced: retrieving, updating,
   * or deleting the group, and offering it at checkout.
   */
  id: string;
  /**
   * The account that owns the bundle. Only keys issued for that
   * account, and for the same environment, can read or change it.
   */
  organization_id: string;
  /**
   * The label currently shown to the customer above the plan choices
   * at checkout.
   */
  name: string;
  /**
   * Every member product in full, so you can render each plan choice
   * without a second call. The order matches the `product_ids` you
   * last sent.
   */
  products: BachsProductResponse[];
  /**
   * ISO 8601 timestamp, in UTC with milliseconds, of when the bundle
   * was first created.
   */
  created_at: string;
  /**
   * ISO 8601 timestamp of the most recent change to the label or the
   * membership. It equals `created_at` until the first update.
   */
  updated_at: string;
}

export interface BachsProductGroupListResponse {
  /**
   * Page counters and cursors for this result set. Send `next_cursor`
   * back as the `cursor` query parameter to fetch the following page,
   * and stop when `has_more` is `false`.
   */
  pagination: BachsPaginationResponse;
  /**
   * The bundles on this page, each returned with its member products
   * expanded in full.
   */
  items: BachsProductGroupResponse[];
}

/* Subscriptions */

export interface BachsSubscriptionCadence {
  /**
   * Unit of time for each billing cycle. `day`: billed daily. `week`:
   * billed weekly. `month`: billed monthly. `year`: billed yearly.
   */
  interval: 'day' | 'week' | 'month' | 'year';
  /**
   * Number of intervals per cycle. For example, `interval` `month`
   * with `frequency` `3` bills every three months.
   */
  frequency: number;
}

export interface BachsSubscriptionCatalogProduct {
  /**
   * Unique identifier for the product.
   */
  id: string;
  /**
   * The product's name, shown to customers at checkout.
   */
  name: string;
  /**
   * The product's description. `null` if none was set.
   */
  description: string | null;
  /**
   * Whether the product is active or archived.
   */
  status: string;
  billing_cycle: BachsSubscriptionCadence | null;
  trial_period: BachsTrialPeriod | null;
  /**
   * When the product was created, in UTC.
   */
  created_at: string;
  /**
   * When the product was last updated, in UTC.
   */
  updated_at: string;
}

export interface BachsSubscriptionItemPrice {
  /**
   * Unique identifier for the price.
   */
  id: string;
  /**
   * The product this price belongs to.
   */
  product_id: string;
  /**
   * How this line item is priced. `fixed`: a set price per cycle, the
   * same for every customer. `free`: no charge. `custom`: the
   * customer chose the amount at checkout, within the product's
   * bounds.
   */
  price_type: 'fixed' | 'free' | 'custom';
  /**
   * The currency of this price, as an ISO 4217 code.
   */
  currency: string;
  /**
   * Decimal string at the currency's precision
   */
  unit_amount: string;
  billing_cycle: BachsSubscriptionCadence | null;
  trial_period: BachsTrialPeriod | null;
  /**
   * Reserved for seat-based pricing. `null` for the standard pricing
   * available today.
   */
  seat_tiers: Record<string, unknown> | null;
  /**
   * Whether the price has been archived. Archived prices keep billing
   * existing subscribers but are not offered for new checkouts.
   */
  is_archived: boolean;
  /**
   * When the price was created, in UTC.
   */
  created_at: string;
  /**
   * When the price was last updated, in UTC.
   */
  updated_at: string;
}

export interface BachsSubscriptionItem {
  /**
   * Unique identifier for the line item.
   */
  id: string;
  /**
   * Lifecycle status of the item. Follows the parent subscription's
   * status.
   */
  status: string;
  /**
   * The billed quantity for this item.
   */
  quantity: number;
  /**
   * Whether this item recurs each billing cycle. Always `true` for
   * subscription items.
   */
  recurring: boolean;
  /**
   * How this line item is priced. `fixed`: a set price per cycle, the
   * same for every customer. `free`: no charge. `custom`: the
   * customer chose the amount at checkout, within the product's
   * bounds.
   */
  price_type: 'fixed' | 'free' | 'custom';
  /**
   * Price for one unit of this item, as a decimal string in the
   * item's currency.
   */
  unit_amount: string;
  /**
   * The currency this item is billed in, as an ISO 4217 code.
   */
  currency: string;
  /**
   * When this item was last billed, in UTC. `null` if it has not been
   * billed yet.
   */
  previously_billed_at: string | null;
  /**
   * When this item will next be billed, in UTC.
   */
  next_billed_at: string | null;
  price: BachsSubscriptionItemPrice | null;
  product: BachsSubscriptionCatalogProduct | null;
  /**
   * When the item was created, in UTC.
   */
  created_at: string;
  /**
   * When the item was last updated, in UTC.
   */
  updated_at: string;
}

export interface BachsSubscriptionResponse {
  /**
   * Unique identifier for the subscription.
   */
  id: string;
  /**
   * The customer billed on each renewal, expanded inline so you can
   * show who is being charged without a second call.
   */
  customer: BachsCustomer;
  /**
   * The saved payment method billed on each renewal. `null` until a
   * payment method is attached.
   */
  payment_method_id: string | null;
  /**
   * Status of the subscription. Set automatically by Bachs as
   * payments succeed or fail. `trialing`: In a free trial. No payment
   * has been collected yet. `trial_end` marks when billing begins.
   * `active`: Active and paid. Bachs is billing this subscription
   * automatically each cycle. `past_due`: A cycle payment failed.
   * Bachs is retrying the payment while access continues. `unpaid`:
   * Payment retries have been exhausted. Access should be restricted.
   * `canceled`: Canceled and will not renew. This is a terminal
   * state. `paused`: Temporarily suspended. Billing is halted until
   * the subscription resumes.
   */
  status: BachsSubscriptionStatus;
  /**
   * How renewals are collected. `charge_automatically` bills the
   * saved card each cycle.
   */
  collection_method: string;
  /**
   * The currency the subscription is billed in, as an ISO 4217 code.
   * Subscriptions are USD only today.
   */
  currency: string;
  /**
   * Recurring amount as a decimal string
   */
  amount: string;
  /**
   * How often the subscription renews, as an interval unit and a
   * frequency, for example `month` with a frequency of `1` for
   * monthly billing.
   */
  billing_cycle: BachsSubscriptionCadence;
  /**
   * Total billable quantity across the subscription's line items.
   */
  quantity: number;
  /**
   * Start of the period currently being billed for, in UTC.
   */
  current_period_start: string;
  /**
   * End of the period currently being billed for, in UTC. The next
   * charge lands at this time unless the subscription is canceled
   * first.
   */
  current_period_end: string;
  /**
   * Start of the period that was last billed
   */
  previously_billed_at: string | null;
  /**
   * Next scheduled charge date
   */
  next_billed_at: string | null;
  /**
   * When the free trial ends and billing begins, in UTC. `null` if
   * the subscription is not trialing.
   */
  trial_end: string | null;
  /**
   * When `true`, the subscription stays active until
   * `current_period_end` and is not renewed. When `false`, it renews
   * normally.
   */
  cancel_at_period_end: boolean;
  /**
   * When the subscription was canceled, in UTC. `null` if it has not
   * been canceled.
   */
  canceled_at: string | null;
  /**
   * When the subscription was created, in UTC.
   */
  created_at: string;
  /**
   * The catalog product this subscription bills for, or `null` when
   * the subscription is not tied to a single product.
   */
  product: BachsSubscriptionCatalogProduct | null;
  /**
   * The line items that make up the subscription. Each item ties a
   * product and its price to a billed quantity.
   */
  items: BachsSubscriptionItem[];
  /**
   * Your own key-value data attached to the subscription at creation,
   * returned unchanged.
   */
  metadata: Record<string, unknown>;
}

export interface BachsSubscriptionListResponse {
  /**
   * The subscriptions on this page, newest first. Each entry is a
   * [Subscription](/api-reference/subscriptions/get-subscription)
   * with the same shape the retrieve endpoint returns.
   */
  items: BachsSubscriptionResponse[];
  /**
   * Where this page sits in the full result set, so you know the
   * applied `limit` and `offset`, how many rows matched, and whether
   * another page exists.
   */
  pagination: BachsSubscriptionPagination;
}

/**
 * A single change to a subscription. Send exactly one intent per
 * request: change the plan (product_id), move a trial (trial_end),
 * change the payment method (payment_method_id), or update metadata
 * (metadata). Combining intents returns 400.
 */
export interface BachsUpdateSubscriptionRequest {
  /**
   * Move the subscription to this product (plan). The price is
   * resolved from the product for the subscription's currency.
   */
  product_id?: string;
  /**
   * Future = add/extend the trial; past-or-now = end it and bill now.
   */
  trial_end?: string;
  /**
   * Point the subscription at a different saved card. If
   * past_due/unpaid, retries immediately. Stands alone.
   */
  payment_method_id?: string;
  /**
   * Merge key-value metadata into the subscription (up to 20 keys
   * total). Sent keys are added or overwritten; a key sent with an
   * empty-string value is removed; send an empty string (`""`) to
   * clear all metadata. Stands alone: it cannot be combined with a
   * plan, trial, or payment-method change.
   */
  metadata?: Record<string, unknown> | '';
  /**
   * How a plan change is settled, and only meaningful alongside
   * `product_id`. `invoice_now`: the change is settled straight away
   * on a new invoice, and this is the default when you omit the
   * field. `next_cycle`: the proration is accrued and drains into the
   * next cycle's invoice. `none`: the plan changes with no proration
   * charged or credited.
   */
  proration_behavior?: 'invoice_now' | 'next_cycle' | 'none';
}

export interface BachsCancelSubscriptionRequest {
  /**
   * true = cancel at current_period_end; false = cancel immediately.
   */
  cancel_at_period_end?: boolean;
  /**
   * An optional free-text note recording why the subscription was
   * canceled. Max 255 characters.
   */
  reason?: string | null;
}

/* Payouts */

/**
 * Send money to a registered destination. Exactly one of `amount` or
 * `quote_id` is required — never both, never neither. `amount` funds
 * a same-currency payout; `quote_id` funds a cross-currency payout,
 * since the quote already fixes both sides.
 */
export interface BachsCreatePayoutRequest {
  /**
   * The ID of a payout destination belonging to your account. The
   * destination must be `approved`.
   */
  destination: string;
  /**
   * The amount the destination should receive, as a decimal string
   * (e.g. "5000.00"), in the destination's currency. The fee is
   * charged on top of this amount — it is not deducted from it. Omit
   * when supplying `quote_id`.
   */
  amount?: string | null;
  /**
   * A quote ID from Create Payout Quote. Required for cross-currency
   * payouts, where the source currency differs from the destination's
   * currency. Omit `amount` when supplying this field.
   */
  quote_id?: string | null;
  /**
   * Your own reference for this payout, up to 128 characters. Omit it
   * and the payout has none; use the payout's `id` to track it.
   */
  reference?: string | null;
  /**
   * Arbitrary key-value data to attach to the payout.
   */
  metadata?: Record<string, unknown> | null;
}

export type BachsCreatePayoutResponse = BachsPayoutResponse;

/**
 * The one shape a payout has on this API — create, retrieve and list.
 * `amount` is denominated in `currency`; `fee` and `total_debited`
 * are denominated in `source_currency`. The two differ on every
 * cross-currency payout, so the debit side must say which one it is
 * in. For a same-currency payout `source_currency` equals `currency`.
 */
export interface BachsPayoutResponse {
  /**
   * The payout ID. Use this to look it up with Get Payout.
   */
  id: string;
  /**
   * `pending` — accepted and queued; `processing` — submitted to the
   * payment rail; `completed` — delivered to the destination;
   * `failed` — could not be delivered, see `failure_reason`.
   */
  status: 'pending' | 'processing' | 'completed' | 'failed';
  /**
   * The net amount delivered to the destination, in `currency`.
   */
  amount: string;
  /**
   * The destination's currency. `amount` is denominated in this
   * currency.
   */
  currency: string;
  /**
   * The currency of the balance being debited. `fee` and
   * `total_debited` are denominated in this currency. Equal to
   * `currency` for a same-currency payout; different for a cross-
   * currency payout funded with a `quote_id`.
   */
  source_currency?: string | null;
  /**
   * The fee charged for this payout, in `source_currency`.
   */
  fee?: string | null;
  /**
   * The gross amount debited from your balance, in `source_currency`.
   * Equals `amount` + `fee` only for a same-currency payout — on a
   * cross-currency payout `amount` is in a different currency, so the
   * two do not add up.
   */
  total_debited?: string | null;
  /**
   * The payout destination ID this payout was sent to.
   */
  destination?: string | null;
  /**
   * The reference you set when you created the payout. `null` if you
   * set none.
   */
  reference?: string | null;
  /**
   * Populated only when `status` is `failed`.
   */
  failure_reason?: string | null;
  /**
   * ISO 8601 creation timestamp.
   */
  created_at?: string | null;
  /**
   * ISO 8601 timestamp of when the payout reached a terminal state.
   * `null` while `status` is `pending` or `processing`.
   */
  completed_at?: string | null;
}

/**
 * Response containing paginated list of payouts/withdrawals
 */
export interface BachsPayoutListResponse {
  /**
   * Total number of payouts matching the query criteria, across all
   * pages.
   */
  total: number;
  /**
   * Array of payout objects for the current page
   */
  items: BachsPayoutResponse[];
}

export interface BachsPayoutQuoteRequest {
  /**
   * Currency to debit from balance.
   */
  from_currency: string;
  /**
   * Destination payout currency.
   */
  to_currency: string;
  /**
   * Amount in `from_currency` to quote.
   */
  amount: string;
  /**
   * Optional payout method hint.
   */
  payout_method?: string | null;
}

/**
 * Response containing payout quote details.
 */
export interface BachsPayoutQuoteResponse {
  /**
   * Payout quote ID.
   */
  quote_id: string;
  /**
   * Debited currency.
   */
  from_currency: string;
  /**
   * Destination currency.
   */
  to_currency: string;
  /**
   * The amount debited from your balance in `from_currency`, before
   * the withdrawal fee is deducted.
   */
  from_amount: string;
  /**
   * The amount the destination will receive in `to_currency`, net of
   * the withdrawal fee. This is NOT a gross currency conversion of
   * `from_amount` — the fee is deducted from `from_amount` before the
   * exchange rate is applied, so `to_amount` already reflects what
   * lands on the other side.
   */
  to_amount: string;
  /**
   * Applied quote exchange rate.
   */
  exchange_rate: string;
  /**
   * Quote expiration timestamp.
   */
  expires_at: string;
}

/**
 * Register where money should land. Accepts both the field names this
 * surface has always used and newer aliases, so a caller never has to
 * know which generation of the API it is talking to — where a legacy
 * name and its alias overlap, the newer name wins.
 */
export interface BachsCreatePayoutDestinationRequest {
  /**
   * User-friendly name for this destination.
   */
  name?: string | null;
  /**
   * Alias for `name`. `name` wins if both are sent.
   */
  label?: string | null;
  /**
   * Currency code this destination accepts (e.g., 'NGN', 'USD',
   * 'USDT_TRC20').
   */
  currency: string;
  /**
   * Type of payout destination: `bank_account`, `mobile_money`, or
   * `crypto_wallet`. Inferred from `currency` when omitted.
   */
  type?: string | null;
  /**
   * Alias for `type`. `type` wins if both are sent.
   */
  destination_type?: string | null;
  /**
   * Bank account number. Required for bank_account destinations.
   */
  account_number?: string | null;
  /**
   * Bank code or routing number. Required for bank_account
   * destinations.
   */
  bank_code?: string | null;
  /**
   * Accepted for compatibility and ignored — the account holder name
   * is always resolved from the bank.
   */
  account_name?: string | null;
  /**
   * Accepted for compatibility and ignored — the bank name is always
   * resolved from the bank.
   */
  bank_name?: string | null;
  /**
   * Phone number for the mobile money account. Required for
   * mobile_money destinations.
   */
  phone_number?: string | null;
  /**
   * Mobile money provider (e.g., 'MTN', 'Vodafone'). Required for
   * mobile_money destinations.
   */
  mobile_provider?: string | null;
  /**
   * Cryptocurrency wallet address. Required for crypto_wallet
   * destinations.
   */
  wallet_address?: string | null;
  /**
   * Blockchain network. Optional when the currency already names its
   * network (e.g. USDT_TRC20).
   */
  network?: string | null;
  /**
   * Additional custom metadata to associate with this destination.
   */
  metadata?: Record<string, unknown> | null;
}

/**
 * The one update a destination allows. `name` and `is_default` alone
 * are safe — a rename touches no routing column, and the default can
 * only ever be one of your own approved destinations. Sending any
 * field below restates the destination in full, the same shape as
 * `POST`; omitted routing fields fall back to what is already stored.
 * Changing an account number, bank code, wallet, network or phone
 * number this way sends the destination back for review — the
 * approval it holds was granted for the details it is being asked to
 * leave behind.
 */
export interface BachsUpdatePayoutDestinationRequest {
  /**
   * The new name for this destination.
   */
  name?: string | null;
  /**
   * Make this the destination a payout schedule pays out to for its
   * currency. Setting it demotes the previous default; false clears
   * it. Ignored if this request also changes where money lands and
   * that change sends the destination back for review.
   */
  is_default?: boolean | null;
  /**
   * Currency code this destination accepts (e.g., 'NGN', 'USD',
   * 'USDT_TRC20').
   */
  currency?: string | null;
  /**
   * Type of payout destination: `bank_account`, `mobile_money`, or
   * `crypto_wallet`.
   */
  type?: string | null;
  /**
   * Alias for `type`. `type` wins if both are sent.
   */
  destination_type?: string | null;
  /**
   * Bank account number.
   */
  account_number?: string | null;
  /**
   * Account holder name. Unlike registration, an update trusts the
   * name it is given.
   */
  account_name?: string | null;
  /**
   * Bank code or routing number.
   */
  bank_code?: string | null;
  /**
   * Bank name.
   */
  bank_name?: string | null;
  /**
   * Phone number for the mobile money account.
   */
  phone_number?: string | null;
  /**
   * Mobile money provider (e.g., 'MTN', 'Vodafone').
   */
  mobile_provider?: string | null;
  /**
   * Cryptocurrency wallet address.
   */
  wallet_address?: string | null;
  /**
   * Blockchain network. Optional when the currency already names its
   * network (e.g. USDT_TRC20).
   */
  network?: string | null;
  /**
   * Additional custom metadata to associate with this destination.
   */
  metadata?: Record<string, unknown> | null;
}

/**
 * Response containing payout destination details (bank account,
 * mobile money, or crypto wallet).
 */
export interface BachsPayoutDestinationResponse {
  /**
   * Unique identifier for this payout destination. Use this ID when
   * creating payouts.
   */
  id: string;
  /**
   * User-friendly name for this destination. Helps you identify
   * destinations in your system.
   */
  name: string;
  /**
   * Type of payout destination: `bank_account`, `mobile_money`, or
   * `crypto_wallet`. Determines which fields are populated.
   */
  type: 'bank_account' | 'mobile_money' | 'crypto_wallet';
  /**
   * Currency code this destination accepts (e.g., 'NGN', 'USD',
   * 'USDT_TRC20'). Payouts to this destination must use this
   * currency.
   */
  currency: string;
  /**
   * Admin review status: `pending_review` — awaiting review, not
   * usable yet; `approved` — cleared for payouts; `rejected` —
   * permanently unusable, register a new destination instead.
   */
  status: 'pending_review' | 'approved' | 'rejected';
  /**
   * Free-text reason set by review, populated when the destination is
   * rejected. Null while pending or approved.
   */
  status_reason?: string | null;
  /**
   * Whether this destination can be used for a payout right now —
   * true only when `status` is `approved` and the destination has not
   * been deactivated.
   */
  is_usable?: boolean;
  /**
   * Whether a payout schedule pays out to this destination for its
   * currency. Set it with `PATCH
   * /v1/payouts/destinations/{destination_id}`.
   */
  is_default?: boolean;
  /**
   * Bank account number. Only populated for bank_account
   * destinations.
   */
  account_number?: string | null;
  /**
   * Account holder name as resolved from the bank. Only populated for
   * bank_account destinations.
   */
  account_name?: string | null;
  /**
   * Bank code or routing number. Only populated for bank_account
   * destinations.
   */
  bank_code?: string | null;
  /**
   * Full name of the bank. Only populated for bank_account
   * destinations.
   */
  bank_name?: string | null;
  /**
   * Phone number associated with the mobile money account. Only
   * populated for mobile_money destinations.
   */
  phone_number?: string | null;
  /**
   * Mobile money provider (e.g., 'MTN', 'Vodafone'). Only populated
   * for mobile_money destinations.
   */
  mobile_provider?: string | null;
  /**
   * Cryptocurrency wallet address. Only populated for crypto_wallet
   * destinations.
   */
  wallet_address?: string | null;
  /**
   * Blockchain network (e.g., 'TRC20', 'ERC20'). Only populated for
   * crypto_wallet destinations. May be included in currency code
   * (e.g., 'USDT_TRC20').
   */
  network?: string | null;
  /**
   * ISO 8601 timestamp when this destination was last reviewed by an
   * admin. Null until reviewed.
   */
  reviewed_at?: string | null;
  /**
   * ISO 8601 timestamp when this destination was created.
   */
  created_at?: string | null;
  /**
   * ISO 8601 timestamp when this destination was last updated.
   */
  updated_at?: string | null;
}

/**
 * Paginated list of configured payout destinations. `total` counts
 * every matching destination, not just the ones on this page.
 */
export interface BachsPayoutDestinationListResponse {
  /**
   * Array of payout destination objects.
   */
  destinations: BachsPayoutDestinationResponse[];
  /**
   * Total number of destinations matching the query, across all
   * pages.
   */
  total: number;
  /**
   * The `limit` used for this page of results.
   */
  limit: number;
  /**
   * The `offset` used for this page of results.
   */
  offset: number;
}

/**
 * Confirmation that a destination was deactivated.
 */
export interface BachsDeletePayoutDestinationResponse {
  /**
   * The ID of the destination that was deactivated.
   */
  id: string;
  /**
   * Always true. Payouts already sent against this destination are
   * unaffected.
   */
  deleted: boolean;
}

/**
 * Set when a currency pays out. Replaces the currency's schedule
 * rather than patching it: a field you omit is cleared, not kept.
 */
export interface BachsPayoutScheduleRequest {
  /**
   * How often this currency pays out. - `manual`: nothing is paid out
   * automatically. The balance stays put until you call Create
   * Payout. - `instant`: about a minute after funds settle, so
   * several times on a busy day and not at all on a quiet one.
   * Collections settling close together are paid out together, in one
   * payout carrying one fee. - `daily`: once a day, at
   * `anchor_hour_utc`. - `weekly`: once a week, on `weekly_anchor`,
   * at `anchor_hour_utc`. - `monthly`: once a month, on
   * `monthly_anchor`, at `anchor_hour_utc`.
   */
  interval: 'manual' | 'instant' | 'daily' | 'weekly' | 'monthly';
  /**
   * Weekdays a weekly payout lands on. Listing more than one means
   * more than one payout a week: `["monday", "thursday"]` pays twice.
   * Defaults to `["monday"]`. Sending it on any other interval is
   * rejected rather than ignored, so a schedule never quietly loses
   * the days you asked for.
   */
  weekly_payout_days?: Array<
    | 'monday'
    | 'tuesday'
    | 'wednesday'
    | 'thursday'
    | 'friday'
    | 'saturday'
    | 'sunday'
  > | null;
  /**
   * Days of the month a monthly payout lands on, each `1` to `31`.
   * Listing more than one means more than one payout a month. 29, 30
   * and 31 land on the last day of a shorter month, so `[31]` pays on
   * the 31st of January and the 28th of February. Defaults to `[1]`.
   * Sending it on any other interval is rejected.
   */
  monthly_payout_days?: number[] | null;
  /**
   * The UTC hour to run at, `0` to `23`. Defaults to `10`. Ignored by
   * `manual` and `instant`.
   */
  anchor_hour_utc?: number | null;
  /**
   * The currency to deliver the money in, in ISO 4217 format.
   * Defaults to the balance currency. Setting it to something else
   * converts each run at the rate of the day it runs, and is
   * available out of USD and stablecoin balances only. Converting out
   * of a local settlement currency is rejected here rather than at
   * run time.
   */
  payout_currency?: string | null;
  /**
   * A floor for a run, as a decimal string (e.g. "5000.00") in the
   * balance currency. A run whose eligible total is below it pays
   * nothing and the money rolls into the next run. Omit for no floor.
   */
  minimum_amount?: string | null;
}

/**
 * The payout schedule for one currency of one account.
 */
export interface BachsPayoutScheduleResponse {
  /**
   * The balance currency this schedule governs, in ISO 4217 format.
   * Each currency is scheduled independently.
   */
  currency: string;
  /**
   * The currency the money is delivered in. Equal to `currency`
   * unless the schedule converts, in which case each run is quoted at
   * the rate of the day it runs.
   */
  payout_currency: string;
  /**
   * How often this currency pays out. - `manual`: nothing is paid out
   * automatically. The balance stays put until you call Create
   * Payout. - `instant`: about a minute after funds settle, so
   * several times on a busy day and not at all on a quiet one.
   * Collections settling close together are paid out together, in one
   * payout carrying one fee. - `daily`: once a day, at
   * `anchor_hour_utc`. - `weekly`: once a week, on `weekly_anchor`,
   * at `anchor_hour_utc`. - `monthly`: once a month, on
   * `monthly_anchor`, at `anchor_hour_utc`.
   */
  interval: 'manual' | 'instant' | 'daily' | 'weekly' | 'monthly';
  /**
   * Weekdays a weekly payout lands on. Listing more than one means
   * more than one payout a week: `["monday", "thursday"]` pays twice.
   * Null on every other interval, because nothing else reads it.
   */
  weekly_payout_days: Array<
    | 'monday'
    | 'tuesday'
    | 'wednesday'
    | 'thursday'
    | 'friday'
    | 'saturday'
    | 'sunday'
  > | null;
  /**
   * Days of the month a monthly payout lands on, each `1` to `31`.
   * Listing more than one means more than one payout a month. 29, 30
   * and 31 land on the last day of a shorter month, so `[31]` pays on
   * the 31st of January and the 28th of February. Null on every other
   * interval.
   */
  monthly_payout_days: number[] | null;
  /**
   * The UTC hour a scheduled run happens, `0` to `23`. Defaults to
   * `10`. Null on `manual` and `instant`, which have no schedule.
   */
  anchor_hour_utc: number | null;
  /**
   * The floor a run has to reach before it pays anything, as a
   * decimal string in `currency`. A run below it pays nothing and the
   * money rolls into the next run. Null means no floor.
   */
  minimum_amount: string | null;
  /**
   * When the next scheduled run is due, in ISO 8601. Always null on
   * `manual` and `instant`: one pays out nothing and the other reacts
   * to funds settling rather than to a clock, so neither has a next
   * run to show.
   */
  next_run_at: string | null;
  /**
   * When a run last happened, in ISO 8601, whether or not it moved
   * money. Null until the first run.
   */
  last_run_at: string | null;
  /**
   * The payout created by the last run that moved money. Read it with
   * Get Payout. Null until a run has paid out.
   */
  last_withdrawal_id: string | null;
  /**
   * Why the currency was set back to `manual` by itself, including
   * the error from the run that tripped it. Null when that never
   * happened.
   */
  disabled_reason: string | null;
}

/**
 * The payout schedule to set, one call at a time.
 */
export interface BachsPayoutSettingsRequest {
  /**
   * Payout schedules to set, keyed by the balance currency each one
   * governs. A currency you leave out keeps the schedule it has, so
   * one call changes NGN without touching USD.
   */
  schedule_by_currency?: Record<
    string,
    BachsPayoutScheduleRequest
  > | null;
}

export interface BachsPayoutSettingsResponse {
  /**
   * Payout schedules, keyed by the balance currency each one governs.
   * A currency with no schedule is absent rather than present and
   * empty, so you can tell "never configured" from "pays out weekly".
   */
  schedule_by_currency: Record<string, BachsPayoutScheduleResponse>;
}

/**
 * Currencies currently supported for payout flows, grouped by type.
 */
export interface BachsPayoutSupportedCurrenciesResponse {
  /**
   * Payout-supported fiat currencies.
   */
  fiat: string[];
  /**
   * Payout-supported crypto currencies.
   */
  crypto: string[];
}

/**
 * Payout currencies supported for a specific method.
 */
export interface BachsSupportedPayoutCurrenciesByMethodResponse {
  /**
   * Requested payout method, normalized to uppercase.
   */
  method: string;
  /**
   * Currencies available for this payout method.
   */
  currencies: string[];
}

/* Transfers and platform fees */

export interface BachsTransferDataInput {
  /**
   * The account to transfer the sale to. Its presence, on its own, is
   * what makes this a destination charge. It must be one of your own
   * accounts; any other ID returns `404` so the response never
   * confirms that an unrelated account exists.
   */
  destination: string;
  /**
   * What the destination account receives, in the base currency of
   * the sale. Supply this instead of `platform_fee` to fix the
   * seller's share and let the platform absorb any variance in the
   * total. Mutually exclusive with `platform_fee`; a request setting
   * both is rejected with `400`.
   */
  amount?: string | null;
}

export interface BachsCreateTransferRequest {
  /**
   * The account to credit, or `self` to send funds back to your
   * platform when acting as an account you own with `X-Account-Id`.
   * The debited side is always whoever is authenticated, so there is
   * no source field.
   */
  destination: string;
  /**
   * Amount to move as a decimal string in `currency`, e.g. "7000.00".
   * Always two decimal places. Must be greater than zero.
   */
  amount: string;
  /**
   * Three-letter ISO 4217 currency code for the transfer, e.g. `NGN`.
   * Both balances must already hold this currency; a transfer never
   * converts.
   */
  currency: string;
  /**
   * An arbitrary string attached to the transfer and returned
   * unchanged. Useful for naming the order or invoice the share
   * belongs to.
   */
  description?: string | null;
  /**
   * Your own key-value data, returned unchanged on the transfer. Not
   * used by Bachs for processing.
   */
  metadata?: Record<string, unknown> | null;
  /**
   * Tags this transfer as part of a group, so several shares funded
   * by the same charge can be reconciled together. Reuse the same
   * value across every transfer for one charge, including a later
   * recovery.
   */
  transfer_group?: string | null;
}

export interface BachsTransferResponse {
  /**
   * Unique identifier for this transfer.
   */
  id: string;
  /**
   * Whoever was debited. Your platform when sending a share to an
   * account you own, the account when recovering one.
   */
  source: string;
  /**
   * Whoever was credited.
   */
  destination: string;
  /**
   * The amount moved, as a decimal string in `currency`.
   */
  amount: string;
  /**
   * Three-letter ISO 4217 currency code the transfer moved.
   */
  currency: string;
  /**
   * Whether the funds have moved. `paid`: the balances have been
   * updated. `pending`: the transfer exists but its movement has not
   * been recorded yet. Derived from the underlying movement, so it
   * never disagrees with the balances.
   */
  status: 'pending' | 'paid';
  /**
   * The description you supplied on creation.
   */
  description: string | null;
  /**
   * The metadata you supplied on creation, returned unchanged.
   */
  metadata: Record<string, unknown>;
  /**
   * The group you supplied on creation, or `null` when the transfer
   * was not tagged.
   */
  transfer_group: string | null;
  /**
   * What this movement is. `payout` is a seller's share of a sale you
   * made, and `manual` is a transfer you created yourself. The
   * platform's own cut of a sale is never a transfer; read it at
   * [Platform fees](/connect/platform-fees).
   */
  kind: 'payout' | 'manual';
  /**
   * The charge that funded this movement, when one did. Null on a
   * transfer you created yourself, which is tied to nothing.
   */
  source_charge_id: string | null;
  /**
   * When the transfer was created, ISO 8601 in UTC.
   */
  created_at: string;
}

export interface BachsTransferListResponse {
  /**
   * The transfers on this page, newest first.
   */
  items: BachsTransferResponse[];
  pagination: BachsPaginationResponse;
}

export interface BachsPlatformFeeResponse {
  /**
   * The platform fee's unique identifier, prefixed `pf_`.
   */
  id: string;
  /**
   * The charge that this fee was struck against, prefixed `ch_`.
   */
  charge: string;
  /**
   * The account the fee was collected from: the seller on a
   * destination charge, or the merchant itself on a direct charge.
   */
  collected_from: string;
  /**
   * The platform that earned the fee.
   */
  earned_by: string;
  /**
   * The fee amount, as a decimal string in `currency`.
   */
  amount: string;
  /**
   * The currency the sale was struck in, before any conversion, as an
   * ISO 4217 code.
   */
  currency: string;
  /**
   * How much of this fee has been reversed. Currently always
   * `"0.00"`: a platform fee is not reversed when its charge is
   * refunded.
   */
  amount_refunded: string;
  /**
   * Whether the fee has been fully reversed. Derived from
   * `amount_refunded` against `amount`, so it cannot disagree with
   * them.
   */
  refunded: boolean;
  /**
   * When the fee was recorded, ISO 8601 in UTC.
   */
  created_at: string;
}

export interface BachsPlatformFeeListResponse {
  /**
   * The platform fees on this page, newest first.
   */
  items: BachsPlatformFeeResponse[];
  /**
   * Pagination cursors and counts. See the Pagination guide.
   */
  pagination: BachsPaginationResponse;
}

/* Conversions and quotes */

export interface BachsConversionCreateRequest {
  /**
   * Currency to convert from (must match the quote)
   */
  from_currency: string;
  /**
   * Currency to convert to (must match the quote)
   */
  to_currency: string;
  /**
   * Amount to convert as a decimal string (must match the quote)
   */
  amount: string;
  /**
   * Quote ID from the create conversion quote endpoint
   */
  quote_id: string;
}

/**
 * Response containing executed conversion details
 */
export interface BachsConversionResponse {
  /**
   * Unique identifier for this conversion transaction
   */
  conversion_id: string;
  /**
   * Status of the conversion. `pending` = in progress (typically
   * seconds to minutes); `completed` = conversion successful and rate
   * is final; `failed` = conversion could not be completed.
   */
  status: 'pending' | 'completed' | 'failed';
  /**
   * Currency that was converted from
   */
  from_currency: string;
  /**
   * Currency that was converted to
   */
  to_currency: string;
  /**
   * Amount converted from as a decimal string
   */
  from_amount: string;
  /**
   * Amount converted to as a decimal string
   */
  to_amount: string;
  /**
   * Exchange rate that was applied
   */
  exchange_rate: string;
  /**
   * ISO 8601 timestamp when the conversion was executed
   */
  created_at: string;
  /**
   * Quote identifier used for this conversion, if conversion was
   * executed from a quote.
   */
  quote_id?: string | null;
  /**
   * Optional metadata associated with the conversion.
   */
  metadata?: Record<string, unknown> | null;
}

export interface BachsConversionListResponse {
  /**
   * Total number of conversions that match the filter criteria.
   */
  total: number;
  /**
   * Maximum number of conversion records returned in this page.
   */
  limit: number;
  /**
   * Number of conversion records skipped before this page.
   */
  offset: number;
  /**
   * Paginated conversion records.
   */
  items: BachsConversionResponse[];
}

export interface BachsConversionQuoteRequest {
  /**
   * Currency to convert from (must be a settlement currency: USD or
   * NGN)
   */
  from_currency: string;
  /**
   * Currency to convert to (must be a settlement currency: USD or
   * NGN)
   */
  to_currency: string;
  /**
   * Amount to convert as a decimal string
   */
  amount: string;
}

/**
 * Response containing conversion quote with exchange rate and amounts
 */
export interface BachsConversionQuoteResponse {
  /**
   * Unique identifier for this conversion quote. Use this ID when
   * executing the conversion.
   */
  quote_id: string;
  /**
   * Currency being converted from
   */
  from_currency: string;
  /**
   * Currency being converted to
   */
  to_currency: string;
  /**
   * Amount in from_currency as a decimal string
   */
  from_amount: string;
  /**
   * Amount in to_currency as a decimal string
   */
  to_amount: string;
  /**
   * Exchange rate applied (1 from_currency = X to_currency)
   */
  exchange_rate: string;
  /**
   * ISO 8601 timestamp when this quote expires
   */
  expires_at: string;
}

export interface BachsCreateQuoteRequest {
  pricing: BachsMerchantIntent;
  /**
   * Payment method (CARD, CRYPTO, BANK_TRANSFER, MOBILE_MONEY)
   */
  payment_method: string;
  /**
   * Currency code (e.g., 'USD', 'NGN', 'TZS', 'USDT_TRC20')
   */
  to_currency: string;
  /**
   * Selected payment rail identifier. Fetch available rails by
   * calling GET
   * /v1/payments/rails?payment_method={method}&currency={currency}.
   * Use the 'id' field from the response. Required when multiple
   * rails are available for the payment method and currency
   * combination.
   */
  payment_rail?: string;
  /**
   * Customer email address (optional; defaults to system identity for
   * provider-specific quotes)
   */
  customer_email?: string;
  /**
   * Customer name (optional; defaults to a system identity when
   * omitted)
   */
  customer_name?: string;
}

/**
 * External response for quote (all payment methods) - excludes
 * provider and gateway details
 */
export interface BachsQuoteResponse {
  /**
   * Quote ID (gateway-specific or internal)
   */
  quote_id: string;
  /**
   * Payment method used to generate quote
   */
  payment_method: string;
  /**
   * Payment rail used to generate quote
   */
  payment_rail: string;
  /**
   * Base USD amount before fees
   */
  base_amount_usd: string;
  /**
   * Amount in local currency (what customer pays)
   */
  amount_local_base: string;
  /**
   * Local currency code (e.g., 'NGN', 'TZS', 'USD')
   */
  currency: string;
  /**
   * Processing fee amount (as string)
   */
  processing_fee: string;
  /**
   * Exchange rate (Decimal as string, if applicable)
   */
  exchange_rate: string;
  /**
   * Total amount customer pays (base + fee)
   */
  total_amount: string;
  /**
   * Which direction this quote prices. `deposit`: money coming in
   * from a customer. `withdrawal`: money going out to a destination.
   */
  payment_type: 'deposit' | 'withdrawal';
  /**
   * Quote expiration time (ISO datetime)
   */
  expires_at: string;
  /**
   * Whether customer bears the fee
   */
  customer_bears_fee: boolean;
}

/**
 * Response containing all supported currencies organized by type
 * (fiat and cryptocurrency)
 */
export interface BachsSupportedCurrenciesResponse {
  /**
   * List of supported fiat (traditional) currencies. These are
   * government-issued currencies like USD, NGN, GHS.
   */
  fiat: string[];
  /**
   * List of supported cryptocurrency codes. These may include network
   * identifiers (e.g., 'USDT_TRC20' for Tron network, 'USDT_ERC20'
   * for Ethereum network).
   */
  crypto: string[];
}

/* Balances */

/**
 * Organization balance snapshot across currencies, including
 * spendable and in-flight amounts.
 */
export interface BachsAccountBalanceResponse {
  /**
   * Organization ID the returned balances belong to.
   */
  account_id: string;
  /**
   * One balance object per currency bucket.
   */
  balances: Array<{
    /**
     * Currency code for this bucket (ISO 4217 or configured crypto
     * code).
     */
    currency: string;
    /**
     * Amount currently available for new operations in this currency.
     */
    available_balance: string;
    /**
     * In-flight amount not yet available for spending.
     */
    pending_balance: string;
  }>;
  /**
   * Aggregate of available and pending balances converted to USD.
   */
  total_balance_usd: string;
  /**
   * Upcoming settlements grouped by day. Empty when no settlements
   * are pending. Each entry describes settlements expected to become
   * available on a given date.
   */
  pending_settlements_by_day?: Array<Record<string, unknown>>;
}

/* Disputes */

/**
 * Summary representation of a dispute record.
 */
export interface BachsDisputeSummary {
  /**
   * Unique dispute identifier.
   */
  dispute_id: string;
  /**
   * Associated payment/charge identifier, if linked.
   */
  charge_id?: string | null;
  /**
   * Disputed amount as a decimal string.
   */
  amount: string;
  /**
   * ISO 4217 currency code for the disputed amount.
   */
  currency: string;
  /**
   * Current dispute status.
   */
  status:
    | 'needs_response'
    | 'under_review'
    | 'won'
    | 'lost'
    | 'closed';
  /**
   * Whether evidence can still be updated and submitted.
   */
  is_response_editable: boolean;
  /**
   * Dispute reason code reported by the payment network.
   */
  reason?: string | null;
  /**
   * Evidence submission deadline in ISO 8601 format.
   */
  response_deadline_at?: string | null;
  /**
   * Dispute creation timestamp.
   */
  created_at: string;
  /**
   * Most recent update timestamp.
   */
  updated_at: string;
}

/**
 * Evidence fields attached to a dispute response.
 */
export interface BachsDisputeEvidence {
  /**
   * An access or activity log showing the customer used what they
   * paid for.
   */
  access_activity_log: string;
  /**
   * Customer's billing address.
   */
  billing_address: string | null;
  /**
   * Upload id of your cancellation policy document.
   */
  cancellation_policy_attachment_id: string;
  /**
   * Cancellation policy shown to the customer.
   */
  cancellation_policy_disclosure: string | null;
  /**
   * Uploaded customer communication document identifier.
   */
  customer_communication_attachment_id: string | null;
  /**
   * Email address of the customer.
   */
  customer_email_address: string | null;
  /**
   * Full name of the customer.
   */
  customer_name: string | null;
  /**
   * Additional context supporting the dispute response.
   */
  notes: string | null;
  /**
   * Description of delivered goods or services.
   */
  product_description: string | null;
  /**
   * Upload id of your refund policy document.
   */
  refund_policy_attachment_id: string;
  /**
   * Refund policy shown to the customer.
   */
  refund_policy_disclosure: string | null;
  /**
   * Reason a refund was not granted.
   */
  refund_refusal_explanation: string | null;
  /**
   * Date the service was delivered.
   */
  service_date: string | null;
  /**
   * Uploaded supporting document identifier.
   */
  uncategorized_attachment_id: string | null;
}

/**
 * Metadata for a dispute evidence submission attempt.
 */
export interface BachsDisputeSubmission {
  /**
   * Unique identifier for this submission attempt.
   */
  submission_id: string;
  /**
   * Submission delivery status.
   */
  status: string;
  /**
   * What triggered the submission attempt.
   */
  trigger_source: string;
  /**
   * Timestamp when submission was delivered.
   */
  submitted_at?: string | null;
  /**
   * Timestamp when submission failed, if applicable.
   */
  failed_at?: string | null;
  /**
   * Submission attempt sequence number.
   */
  attempt_sequence: number;
}

/**
 * Detailed dispute payload including evidence and latest submission
 * metadata.
 */
export interface BachsDisputeResponse {
  /**
   * Unique dispute identifier.
   */
  dispute_id: string;
  /**
   * Associated payment/charge identifier, if linked.
   */
  charge_id?: string | null;
  /**
   * Disputed amount as a decimal string.
   */
  amount: string;
  /**
   * ISO 4217 currency code for the disputed amount.
   */
  currency: string;
  /**
   * The current state of the dispute. A flat dispute fee is debited
   * from your balance as soon as the dispute record is created,
   * whichever of these states it starts in, and it is not charged
   * again or refunded at resolution. `needs_response`: the dispute is
   * open against you and you must submit evidence before
   * `response_deadline_at`; no further funds have moved beyond that
   * fee. `under_review`: your evidence has been submitted and the
   * outcome is being decided; no further funds have moved beyond that
   * fee. `won`: the dispute was decided in your favour and you keep
   * the funds, and this state is terminal. `lost`: the dispute was
   * decided against you, and the disputed amount is additionally
   * debited from your balance, and this state is terminal. `closed`:
   * the dispute was closed with no further action available to you,
   * and this state is terminal.
   */
  status:
    | 'needs_response'
    | 'under_review'
    | 'won'
    | 'lost'
    | 'closed';
  /**
   * Whether evidence is still editable for this dispute.
   */
  is_response_editable: boolean;
  /**
   * Dispute reason code reported by the payment network.
   */
  reason?: string | null;
  /**
   * Evidence submission deadline in ISO 8601 format.
   */
  response_deadline_at?: string | null;
  evidence: BachsDisputeEvidence;
  /**
   * Most recent submission attempt for this dispute.
   */
  latest_submission?: BachsDisputeSubmission | null;
  /**
   * Dispute creation timestamp.
   */
  created_at: string;
  /**
   * Most recent update timestamp.
   */
  updated_at: string;
}

/**
 * Paginated dispute list response.
 */
export interface BachsDisputeListResponse {
  /**
   * Total number of disputes matching the query.
   */
  total: number;
  /**
   * Dispute records for the requested page.
   */
  items: BachsDisputeSummary[];
}

/**
 * Fields used to create or update dispute evidence. Include only
 * fields that should change.
 */
export interface BachsDisputeEvidenceUpdateRequest {
  /**
   * An access or activity log showing the customer used what they
   * paid for.
   */
  access_activity_log?: string;
  /**
   * Customer's billing address.
   */
  billing_address?: string;
  /**
   * Upload id of your cancellation policy document.
   */
  cancellation_policy_attachment_id?: string;
  /**
   * Cancellation policy shown to the customer.
   */
  cancellation_policy_disclosure?: string;
  /**
   * Uploaded customer communication document identifier.
   */
  customer_communication_attachment_id?: string;
  /**
   * Email address of the customer.
   */
  customer_email_address?: string;
  /**
   * Full name of the customer.
   */
  customer_name?: string;
  /**
   * Additional context supporting the dispute response.
   */
  notes?: string;
  /**
   * Description of delivered goods or services.
   */
  product_description?: string;
  /**
   * Upload id of your refund policy document.
   */
  refund_policy_attachment_id?: string;
  /**
   * Refund policy shown to the customer.
   */
  refund_policy_disclosure?: string;
  /**
   * Reason a refund was not granted.
   */
  refund_refusal_explanation?: string;
  /**
   * Date the service was delivered.
   */
  service_date?: string;
  /**
   * Uploaded supporting document identifier.
   */
  uncategorized_attachment_id?: string;
}

/**
 * Response after saving dispute evidence fields.
 */
export interface BachsDisputeEvidenceUpdateResponse {
  /**
   * The dispute that was updated.
   */
  dispute_id: string;
  /**
   * Current dispute status after update.
   */
  status: string;
  /**
   * Whether the dispute is still editable after update.
   */
  is_response_editable: boolean;
  /**
   * Timestamp when evidence was last updated.
   */
  evidence_updated_at: string;
}

/**
 * Response returned after submitting dispute evidence for review.
 */
export interface BachsDisputeSubmitResponse {
  /**
   * The dispute that was submitted.
   */
  dispute_id: string;
  /**
   * Updated dispute status after submission.
   */
  status: string;
  /**
   * Whether the dispute remains editable after submission.
   */
  is_response_editable: boolean;
  /**
   * Metadata for the submission attempt created by this request.
   */
  submission: {
    /**
     * Unique identifier for this submission attempt.
     */
    submission_id: string;
    /**
     * Submission delivery outcome.
     */
    submission_status: string;
    /**
     * Source of submission trigger.
     */
    trigger_source: string;
    /**
     * Timestamp when submission was delivered.
     */
    submitted_at?: string | null;
  };
}

/**
 * Successful dispute document upload response.
 */
export interface BachsDisputeDocumentUploadResponse {
  /**
   * Uploaded document identifier.
   */
  document_id: string;
  /**
   * Original uploaded filename.
   */
  file_name: string;
  /**
   * Detected MIME type of the uploaded file.
   */
  mime_type: string;
  /**
   * Uploaded file size in bytes.
   */
  file_size_bytes: number;
  /**
   * Upload completion timestamp.
   */
  uploaded_at: string;
}

/* Uploads */

/**
 * A stored file and its metadata.
 */
export interface BachsUploadResponse {
  /**
   * Unique identifier for this upload. Pass it wherever an endpoint
   * accepts a file reference.
   */
  upload_id: string;
  /**
   * The file name you uploaded, preserved unchanged.
   */
  file_name: string;
  /**
   * The media type detected from the file's contents, which may
   * differ from what its extension suggests.
   */
  mime_type: string;
  /**
   * Size of the stored file in bytes.
   */
  file_size_bytes: number;
  /**
   * URL the file can be fetched from. `null` for a private upload,
   * which is served only through the API.
   */
  url?: string | null;
  /**
   * The kind of resource this upload is attached to, for example
   * `product`. `null` while the upload is unattached.
   */
  linked_resource_type?: string | null;
  /**
   * ID of the resource this upload is attached to. `null` while the
   * upload is unattached.
   */
  linked_resource_id?: string | null;
  /**
   * ISO 8601 timestamp of when the file was uploaded.
   */
  created_at: string;
  /**
   * ISO 8601 timestamp of when the upload was last changed, which
   * includes being attached to a resource.
   */
  updated_at: string;
}

/**
 * Confirmation that an upload was deleted.
 */
export interface BachsUploadDeleteResponse {
  /**
   * The upload that was deleted. It can no longer be attached to a
   * resource.
   */
  upload_id: string;
  /**
   * Always `true` on a successful delete. A file that was already
   * gone returns `404` instead.
   */
  deleted: boolean;
}

/* Connect: accounts */

export interface BachsOrganizationResponse {
  /**
   * Unique identifier for the account.
   */
  id: string;
  /**
   * The account's display name.
   */
  name: string | null;
  /**
   * The user that owns the account. For an account you own this is a
   * service user Bachs created; you never authenticate as it.
   */
  owner_user_id: string;
  /**
   * The platform this account is connected to, or `null` when it is a
   * platform in its own right.
   */
  parent_organization_id: string | null;
  /**
   * Two-letter ISO 3166-1 country code. Decides which requirements
   * the account is given.
   */
  country: string | null;
  /**
   * What kind of legal person the account is, which together with
   * `country` decides the requirements it is given. `company`: a
   * registered entity, asked for registration and ownership details.
   * `individual`: a natural person, asked only for their own
   * identity.
   */
  entity_type: ('company' | 'individual') | null;
  /**
   * Who absorbs processing fees at checkout. `account_pays_fee`:
   * deducted from the amount you receive. `customer_pays_fee`: added
   * to what the customer pays.
   */
  fee_handling: 'account_pays_fee' | 'customer_pays_fee';
  /**
   * One entry per exact corridor (`USD_CARD`, `NGN_CARD`,
   * `NGN_BANK_TRANSFER`, `MOMO_GHS` to `MOMO_ZMW`, `CRYPTO`). See
   * [payment method support](/guides/payments/payment-method-
   * support). Each value has an `enabled` boolean; `CRYPTO`
   * additionally carries a `currencies` map since it covers several
   * asset/network pairs.
   */
  enabled_payment_methods: Record<string, unknown> | null;
  /**
   * When `true`, customers are shown prices in their local currency
   * where one is available.
   */
  adaptive_pricing: boolean;
  /**
   * Currencies this account is configured to hold a balance in.
   */
  balance_currencies: string[];
  /**
   * Contact phone number, including country code.
   */
  phone_number: string | null;
  /**
   * Registered company name, when the account is a company.
   */
  company_name: string | null;
  /**
   * Names of the capabilities currently active on this account. A
   * convenience view of `capabilities`.
   */
  enabled_capabilities: string[] | null;
  /**
   * Each capability's status, keyed by capability name. Populated on
   * single-account reads only; `null` on list items.
   */
  capabilities: Record<string, BachsAccountCapabilityStatus> | null;
  /**
   * Outstanding requirements for this account. Populated on single-
   * account reads only; `null` on list items.
   */
  requirements: BachsAccountRequirements | null;
  /**
   * When `false`, the account is deactivated and cannot authenticate
   * or move funds.
   */
  is_active: boolean;
  /**
   * When the account was created, ISO 8601 in UTC.
   */
  created_at: string;
  /**
   * When the account was last updated, ISO 8601 in UTC.
   */
  updated_at: string;
  /**
   * Fee arrangement for an account you own. `null` when this object
   * is not an account you own.
   */
  responsibilities: BachsResponsibilitiesResponse | null;
  /**
   * Personas applied to this account, keyed by name (`merchant`,
   * `recipient`), each with an empty object as its value. Populated
   * on single-account reads, where it is `{}` when none apply; `null`
   * on list items.
   */
  configuration: Record<
    string,
    BachsAccountConfigurationOptions
  > | null;
}

export interface BachsCreateConnectedAccountRequest {
  /**
   * Email address of the person or business behind the account.
   * Trimmed and lowercased before it is stored.
   */
  contact_email: string;
  /**
   * Name you want the account listed under. Becomes the account's
   * `name`, and is `null` until the account holder sets one during
   * onboarding if you omit it.
   */
  display_name?: string | null;
  /**
   * Given name of the person you are onboarding, used to label the
   * account before verification collects a legal name. Whitespace-
   * only values are stored as `null`.
   */
  first_name?: string | null;
  /**
   * Family name of the person you are onboarding. Whitespace-only
   * values are stored as `null`.
   */
  last_name?: string | null;
  /**
   * Two-letter ISO 3166-1 country code for the account. Decides which
   * requirements the account is given, so set it when you already
   * know it. Falls back to your own platform's country.
   */
  country?: string | null;
  /**
   * What kind of legal person the account is, which together with
   * `country` decides the requirements it is given. `company`: a
   * registered entity, asked for registration and ownership details.
   * `individual`: a natural person, asked only for their own
   * identity.
   */
  entity_type?: ('company' | 'individual') | null;
  /**
   * Personas the account is being created for, keyed by name
   * (`merchant`, `recipient`). No persona is ever applied
   * automatically, `recipient` included — an account created with no
   * `configuration` holds neither and cannot hold any capability.
   * Sending an empty object is rejected with `422 VALIDATION_ERROR`;
   * omit the field entirely for a persona-less account instead. A
   * capability is only ever named inside the persona object it
   * belongs to, in its `capabilities`, so naming one always names its
   * persona in the same request; there is no way to name a capability
   * without also naming a persona, and no way to infer one from a
   * bare capability name. A capability nested under the wrong persona
   * for it is rejected with `400 capability_configuration_mismatch`.
   * There is no field to apply a configuration after creation other
   * than naming it again on update, so decide every persona the
   * account will ever need up front, or add one later on `POST
   * /v1/accounts/{account_id}`. An unrecognised key is rejected with
   * `400 invalid_configuration`.
   */
  configuration?: Record<
    string,
    BachsAccountConfigurationOptions
  > | null;
  /**
   * Fee arrangement for the account. Defaults to Bachs collecting its
   * fee out of the charge.
   */
  responsibilities?: BachsResponsibilitiesRequest;
}

/**
 * The one account write. Set contact details, request capabilities
 * and satisfy requirement fields in a single call. Anything you leave
 * out is unchanged.
 */
export interface BachsUpdateAccountRequest {
  /**
   * Personas to apply, and capabilities to request under them, the
   * same nested shape as creation. Naming a persona here — with or
   * without a capability nested under its `capabilities` — is what
   * applies it if the account does not already have it: an account
   * can start recipient-only and be given `merchant` later this way.
   * Unlike creation, an omitted `capabilities` here never blanket-
   * requests; it only applies the persona. A capability nested under
   * the wrong persona for it is rejected with `400
   * capability_configuration_mismatch`. Only names set to `true` are
   * acted on; any name set to `false` fails the whole request with
   * `400 capability_unrequest_unsupported`. Capabilities the account
   * already holds are unaffected, and an omitted map changes nothing.
   */
  configuration?: Record<string, BachsAccountConfigurationOptions>;
  /**
   * The account's public name. Omit to leave it unchanged.
   */
  display_name?: string;
  /**
   * Where onboarding correspondence for the account is sent. Omit to
   * leave it unchanged.
   */
  contact_email?: string;
  /**
   * Requirement values, keyed by the field keys the account's
   * requirements name: `persons`, `company.*`, `business_profile.*`,
   * `payout_destination`, `tos_acceptance.*`. Omit to change nothing.
   */
  fields?: Record<string, unknown>;
  /**
   * Which currencies the account holds, keyed by currency code.
   * Holding a currency decides what the account settles in; a one-
   * time checkout can be priced in any supported currency regardless.
   * A recurring checkout is the exception and must be priced in a
   * held currency, so set this before the account sells subscriptions
   * in its own market. A new account holds only USD. Send `true` to
   * add a currency and `false` to remove one. Omitthe field and
   * nothing changes. USD is always held and cannot be removed. A
   * currency Bachs cannot settle in is rejected with `400`.
   */
  balance_currencies?: Record<string, boolean> | null;
}

export interface BachsConnectedAccountListResponse {
  /**
   * The accounts on this page. Items never carry `capabilities` or
   * `requirements`; read a single account for those.
   */
  items: BachsOrganizationResponse[];
  /**
   * Total accounts, across all pages.
   */
  total: number;
  /**
   * The page size used for this response.
   */
  limit: number;
  /**
   * The offset used for this response.
   */
  offset: number;
}

/**
 * A named persona, and the capabilities requested under it.
 * `capabilities` omitted requests every capability that persona
 * allows on create (never on update); `{}` requests none.
 */
export interface BachsAccountConfigurationOptions {
  /**
   * Capabilities requested under this persona, keyed by name.
   * Omitting this on create requests every capability the persona
   * allows; omitting it on update just applies the persona and
   * requests nothing. Send `{}` to apply the persona and request
   * nothing, on either endpoint. An unrecognised or inactive
   * capability name is rejected with `400 unknown_capability`.
   */
  capabilities: Record<string, BachsCapabilityRequest> | null;
}

export interface BachsAccountCapabilityStatus {
  /**
   * Whether the account may perform this action. `active`: enabled,
   * and the only value that authorizes anything. `pending`: requested
   * or submitted, awaiting review. `restricted`: not enabled, and the
   * default. `unrequested`: the account has no record for this
   * capability, which differs from `restricted` in that it was never
   * asked for. `unsupported`: the account is not eligible for this
   * capability.
   */
  status:
    | 'active'
    | 'pending'
    | 'restricted'
    | 'unrequested'
    | 'unsupported';
  /**
   * Whether the account ever requested this capability. A
   * `restricted` capability that was requested is in progress; one
   * that was never requested is outside the account's setup.
   */
  requested: boolean;
  /**
   * Why the capability is not active. `null` when the capability is
   * `active`, meaning there is nothing to explain.
   */
  status_details: BachsCapabilityStatusDetail[] | null;
}

export interface BachsCapabilityRequest {
  /**
   * Set to `true` to request this capability for the account, which
   * applies the configuration the capability belongs to and surfaces
   * the requirements it needs. Requesting authorizes nothing on its
   * own. `false` is rejected with `400
   * capability_unrequest_unsupported`, because there is no path to
   * withdraw a capability once it has been requested.
   */
  requested?: boolean;
}

export interface BachsCapabilityStatusDetail {
  /**
   * Machine-readable reason the capability is not active. Branch on
   * this rather than on `message`.
   */
  code: string;
  /**
   * What has to happen for the capability to become active.
   */
  resolution: string | null;
  /**
   * Human-readable explanation, safe to show the account holder.
   */
  message: string | null;
}

export interface BachsConnectedAccountCapability {
  /**
   * The action this entry governs. `payouts`: withdraw from the
   * account's balance to a bank or wallet. `transfers`: move funds
   * between your balance and the account's. `conversions`: convert
   * between currencies the account holds. `connect`: create and
   * onboard accounts of its own.
   */
  name: 'payouts' | 'transfers' | 'conversions' | 'connect';
  /**
   * Whether the account may perform this action. `active`: enabled,
   * and the only value that authorizes anything. `pending`: requested
   * or submitted, awaiting review. `restricted`: not enabled, and the
   * default. `unrequested`: no record exists for this capability,
   * which differs from `restricted` in that it was never asked for.
   * `unsupported`: the account is not eligible for this capability at
   * all.
   */
  status:
    | 'active'
    | 'pending'
    | 'restricted'
    | 'unrequested'
    | 'unsupported';
  /**
   * Whether the account ever requested this capability. A
   * `restricted` capability that was requested is in progress; one
   * that was never requested is outside the account's setup.
   */
  requested: boolean;
  /**
   * Why the capability is not active. `null` when the capability is
   * `active`, meaning there is nothing to explain.
   */
  status_details: BachsCapabilityStatusDetail[] | null;
}

export interface BachsConnectedAccountCapabilitiesResponse {
  /**
   * Every capability applicable to the account, including ones it has
   * never requested. Capabilities the account is not eligible to hold
   * at all are omitted rather than returned as `unsupported`.
   */
  items: BachsConnectedAccountCapability[];
}

/**
 * The account-wide roll-up of outstanding requirements. Populated on
 * single-account reads only.
 */
export interface BachsAccountRequirements {
  /**
   * Field keys required now.
   */
  currently_due: string[];
  /**
   * Field keys required later, once a threshold or stage is reached.
   */
  eventually_due: string[];
  /**
   * Field keys that were required by a date now passed.
   */
  past_due: string[];
  /**
   * Field keys provided and being checked.
   */
  pending_verification: string[];
  /**
   * Fields that were provided and then rejected, as distinct from
   * fields that are missing.
   */
  errors: BachsRequirementError[];
  /**
   * Per-field view of the same requirements, each carrying the
   * capabilities it blocks.
   */
  entries: BachsRequirementEntry[];
  /**
   * Only present with `include=requirements.values`. Account-level
   * fields and their current values, for reading back what was
   * submitted and prefilling an edit. Sensitive fields are listed as
   * provided and never echoed. People are returned separately under
   * `persons`.
   */
  values: BachsTaskValueItem[];
  /**
   * One entry per person on the account, rolled up rather than split
   * into fields. Each entry carries `id`, `first_name`, `last_name`,
   * `dob`, `address`, `address_reference_data`, `relationship`,
   * `id_document_provided`, and `verification_status`. Identity
   * documents are summarised by the `id_document_provided` flag and
   * never returned. Only present with `include=requirements.values`.
   */
  persons: Array<Record<string, unknown>>;
  /**
   * The soonest deadline across everything outstanding, for a single
   * banner. Null when no outstanding field carries one.
   */
  current_deadline: string | null;
}

/**
 * One outstanding requirement and what it holds up. The buckets say
 * what is missing; this says what breaks while it is. Prefer this
 * over the buckets when an account holds more than one capability.
 */
export interface BachsRequirementEntry {
  /**
   * Canonical field key.
   */
  field: string;
  /**
   * The bucket this entry is in.
   */
  status:
    | 'currently_due'
    | 'eventually_due'
    | 'past_due'
    | 'pending_verification';
  /**
   * Capabilities this field blocks. Empty when no capability the
   * account holds requires it.
   */
  restricts_capabilities: string[];
  /**
   * Verification or rejection errors for this field.
   */
  errors: Array<{
    code: string | null;
    reason: string | null;
  }>;
  /**
   * Who can act on this field. `api`: yours to supply, through the
   * account update or the persons subresource. `review`: already
   * provided and sitting with us, so re-sending it achieves nothing.
   * Treat an unrecognized value as not yours to resolve.
   */
  resolution: 'api' | 'review';
  /**
   * When this field must be resolved by, if a deadline was set.
   */
  deadline: string | null;
}

export interface BachsRequirementError {
  /**
   * The field key that was rejected.
   */
  field: string;
  /**
   * Machine-readable rejection reason.
   */
  code: string | null;
  /**
   * Human-readable rejection reason, safe to show the account holder.
   */
  reason: string | null;
}

/**
 * Fee arrangement for the account. Set once at creation and immutable
 * afterwards.
 */
export interface BachsResponsibilitiesRequest {
  /**
   * Who collects the Bachs processing fee on this account's charges.
   * Defaults to `bachs`.
   */
  fees?: {
    /**
     * `bachs`: the fee comes out of the charge and the account
     * settles net. `platform`: the platform absorbs the fee on this
     * account's charges and the account settles gross.
     */
    collector?: 'platform' | 'bachs';
  };
}

export interface BachsResponsibilitiesResponse {
  /**
   * Who collects the Bachs processing fee on this account's charges.
   */
  fees: {
    /**
     * `bachs`: the fee comes out of the charge and the account
     * settles net. `platform`: the platform absorbs the fee and the
     * account settles gross. Set when the account is created and
     * immutable afterwards.
     */
    collector: 'platform' | 'bachs';
  };
}

export interface BachsCreateAccountLinkRequest {
  /**
   * What the account holder is being sent to do. `onboarding`:
   * collect everything the account still owes for the first time.
   * `update`: revisit information already collected, which requires
   * the account to have requirements already and otherwise fails with
   * `400 CONNECTED_ACCOUNT_REQUIREMENTS_NOT_FOUND`.
   */
  type: 'onboarding' | 'update';
  /**
   * Where the account holder is sent when the link is no longer
   * usable, for example after it expired. Issue a fresh link from the
   * page you point at, because the original URL cannot be revived.
   */
  refresh_url: string;
  /**
   * Where the account holder is sent when they finish or abandon the
   * flow. Arriving here is not proof that onboarding completed, so
   * confirm from the `account.updated` event rather than from the
   * redirect.
   */
  return_url: string;
  /**
   * Options carried through to the hosted flow and handed back
   * unchanged when the link is opened. Omit it unless you were given
   * specific keys to send.
   */
  collection_options?: Record<string, unknown> | null;
}

export interface BachsAccountLinkResponse {
  /**
   * Unique identifier for the account link.
   */
  id: string;
  /**
   * Always `connected_account_link`, so a mixed webhook or log stream
   * can be routed on type.
   */
  object: 'connected_account_link';
  /**
   * The account this link onboards.
   */
  account: string;
  /**
   * What the link was issued for, echoing the `type` you sent.
   * `onboarding`: the account holder is walked through everything the
   * account still owes, for the first time. `update`: the account
   * holder revisits information already collected, which only works
   * once the account has requirements and otherwise fails with `400
   * CONNECTED_ACCOUNT_REQUIREMENTS_NOT_FOUND`.
   */
  type: 'onboarding' | 'update';
  /**
   * When the link was issued, ISO 8601 in UTC.
   */
  created: string;
  /**
   * When the link stops working, ISO 8601 in UTC. After this the
   * account holder lands on your `refresh_url` instead. Read this
   * value rather than assuming a fixed lifetime.
   */
  expires_at: string;
  /**
   * Send the account holder here. The URL carries a single-use
   * credential, so deliver it over a channel you trust and keep it
   * out of logs and analytics. It is returned only on this response
   * and cannot be read back.
   */
  url: string;
  /**
   * `true` when issuing this link invalidated an outstanding active
   * link of the same `type` for the account. Generating a link on
   * every page render keeps invalidating the one you already sent, so
   * create a link when you are about to redirect and not before.
   */
  previous_link_superseded: boolean;
}

/* Connect: persons */

/**
 * On edit, omitted keys are left alone and an explicit `null` clears
 * the field. Naming one relationship flag leaves the others as they
 * were.
 */
export interface BachsPersonWriteRequest {
  /**
   * The person's given name as it appears on their government ID,
   * since a mismatch against the document is the most common reason
   * identity verification is rejected. On an update, omitting this
   * key leaves the stored value alone and sending it as `null` clears
   * it.
   */
  first_name?: string;
  /**
   * The person's family name as it appears on their government ID,
   * checked against the document alongside `first_name`. On an
   * update, omitting this key leaves the stored value alone and
   * sending it as `null` clears it.
   */
  last_name?: string;
  /**
   * ISO-8601 date, `YYYY-MM-DD`.
   */
  dob?: string;
  /**
   * The person's residential address, as an object with `line1`,
   * `city`, `state` and `country` (two-letter ISO 3166-1), plus an
   * optional `postal_code`. It is written whole rather than merged,
   * so send every key you want kept; on an update, omitting this key
   * leaves the stored address alone and sending it as `null` clears
   * it.
   */
  address?: Record<string, unknown>;
  /**
   * A contact number for this person, kept with their identity record
   * and passed on when their identity is checked, 32 characters or
   * fewer. On an update, omitting this key leaves the stored value
   * alone and sending it as `null` clears it.
   */
  phone?: string;
  /**
   * This person's own email address, separate from the account's
   * `contact_email`, and used for correspondence about their
   * verification rather than the account's. It must be a valid
   * address or the request fails with `422`; on an update, omitting
   * this key leaves the stored value alone and sending it as `null`
   * clears it.
   */
  email?: string;
  /**
   * The person's government ID number. It is write-only: it is never
   * echoed back, and the response reports `id_number_provided`
   * instead. On an update, omitting this key leaves the stored number
   * alone and sending it as `null` clears it.
   */
  id_number?: string;
  relationship?: BachsPersonRelationship;
}

export interface BachsPersonResponse {
  /**
   * The person's identifier, prefixed `per_`. Requirement keys are
   * anchored to it, so `persons.per_3a91c0d7.id_document` names
   * exactly who owes a document.
   */
  id: string;
  /**
   * The person's given name as recorded, or `null` when it has not
   * been supplied yet. It is the name their identity document is
   * checked against.
   */
  first_name: string | null;
  /**
   * The person's family name as recorded, or `null` when it has not
   * been supplied yet. It is checked against the identity document
   * alongside `first_name`.
   */
  last_name: string | null;
  /**
   * ISO-8601 date, `YYYY-MM-DD`.
   */
  dob: string | null;
  /**
   * The person's residential address, carrying the `line1`, `city`,
   * `state`, `postal_code` and `country` keys that were written, or
   * `null` when no address has been supplied. It is stored whole, so
   * a later write replaces it rather than merging into it.
   */
  address: Record<string, unknown> | null;
  /**
   * The contact number recorded for this person, returned exactly as
   * it was sent, or `null` when none has been supplied.
   */
  phone: string | null;
  /**
   * The email address recorded for this person, or `null` when none
   * has been supplied. It belongs to the person, not to the account,
   * so it differs from the account's `contact_email`.
   */
  email: string | null;
  /**
   * `true` when a government ID number is held for this person,
   * `false` when none has been supplied. The number itself is write-
   * only and never returned, so this flag is how you tell whether you
   * still need to collect one.
   */
  id_number_provided: boolean;
  relationship: BachsPersonRelationship;
  verification: BachsPersonVerification;
  /**
   * When the person was added to the account, ISO 8601 in UTC.
   */
  created_at: string;
  /**
   * When the person record last changed, ISO 8601 in UTC. A
   * verification outcome we record moves it as well as your own
   * writes, so do not read it as the time of your last edit.
   */
  updated_at: string;
}

export interface BachsPersonListResponse {
  /**
   * The account's persons for this page, oldest first, each carrying
   * the same shape as [reading one
   * person](/connect/accounts#persons). The order is stable, so
   * paging with `offset` neither repeats nor skips anyone.
   */
  items: BachsPersonResponse[];
  /**
   * How many persons the account has in total, not how many came back
   * on this page. Compare it against `offset` plus the length of
   * `items` to know whether another page is waiting.
   */
  total: number;
  /**
   * How many persons a page returns at most, echoing the `limit` you
   * sent. It defaults to 50 and is capped at 100; anything outside 1
   * to 100 is rejected with `422`.
   */
  limit: number;
  /**
   * How many persons were skipped before this page, echoing the
   * `offset` you sent. Add `limit` to it to ask for the next page,
   * and stop once it reaches `total`.
   */
  offset: number;
}

/**
 * Role flags. One person is commonly several of these at once, which
 * is why they are flags on one person rather than separate
 * collections.
 */
export interface BachsPersonRelationship {
  /**
   * The person who controls the account and acts for it.
   */
  representative: boolean;
  /**
   * A beneficial owner at or above the ownership threshold.
   */
  owner: boolean;
  /**
   * `true` when the person sits on the board of the company behind
   * the account. It is independent of the other flags, so setting it
   * does not clear `representative`, `owner` or `executive`.
   */
  director: boolean;
  /**
   * `true` when the person is a senior manager of the company behind
   * the account. It is independent of the other flags, so setting it
   * does not clear `representative`, `owner` or `director`.
   */
  executive: boolean;
  /**
   * Percentage owned, when known.
   */
  percent_ownership: number | null;
  /**
   * The person's job title at the company behind the account, for
   * example `Founder` or `Chief Financial Officer`, or `null` when
   * none was given.
   */
  title: string | null;
}

/**
 * What has been established about this person. How it was established
 * is not reported.
 */
export interface BachsPersonVerification {
  status: 'unverified' | 'pending' | 'verified' | 'failed';
  /**
   * Whether an identity document is held.
   */
  document_provided: boolean;
  /**
   * Written for display to the account holder.
   */
  failure_reason: string | null;
}

/* Onboarding tasks and reference data */

/**
 * One field's current value, for reading back what the account
 * already provided and prefilling an edit form.
 */
export interface BachsTaskValueItem {
  /**
   * Canonical key for the field, the same key you submit it under.
   */
  field: string;
  /**
   * Human-readable name for the field, safe to show the account
   * holder verbatim.
   */
  label: string;
  /**
   * Which onboarding section the field is shown in:
   * `identity_verification`, `business_ownership`,
   * `product_information`, or `bank_verification`. Note this is a
   * coarser grouping than the `group` on a checklist field. `null`
   * when the field maps to no section.
   */
  group: string | null;
  /**
   * Whether the account has a value for this field. A sensitive field
   * reports `provided: true` with no `value`.
   */
  provided: boolean;
  /**
   * When `true`, the value is never echoed back: `value` stays `null`
   * and `display` reads `Provided`. Identity documents and bank
   * account numbers are sensitive, so an edit form has to collect
   * them again rather than prefill them.
   */
  sensitive: boolean;
  /**
   * The raw value, suitable for prefilling an edit form. Always
   * `null` when `sensitive` is `true`.
   */
  value: unknown | null;
  /**
   * One-line summary of the value for a review card. `Provided` for a
   * sensitive field, and `null` when nothing has been provided.
   */
  display: string | null;
  /**
   * Resolved labels for a value that is stored as a code, such as the
   * name behind a bank code, so a review card does not have to look
   * them up. `null` when the field has nothing to resolve.
   */
  reference_data: Record<string, unknown> | null;
}

export interface BachsTaskBankListResponse {
  /**
   * Two-letter ISO 3166-1 country the list was resolved for,
   * uppercased.
   */
  country: string;
  /**
   * Banks you can submit as a payout destination for this country.
   */
  banks: Array<{
    /**
     * Bank name to show the account holder.
     */
    name: string;
    /**
     * Code to send as `bank_code` when resolving an account or
     * submitting a payout destination.
     */
    code: string;
  }>;
}

export interface BachsTaskMobileMoneyListResponse {
  /**
   * Two-letter ISO 3166-1 country the list was resolved for,
   * uppercased.
   */
  country: string;
  /**
   * Mobile money provider names available in this country,
   * deduplicated and in display order. Empty when the country has
   * none.
   */
  providers: string[];
}

export interface BachsResolveTaskBankAccountRequest {
  /**
   * The account number to look up, digits only and exactly as the
   * account holder typed it.
   */
  account_number: string;
  /**
   * Code of the bank holding the account, taken from `code` on the
   * bank list.
   */
  bank_code: string;
  /**
   * Two-letter ISO 3166-1 country to resolve in. Falls back to the
   * account's country, and a country outside `NG` and `GH` comes back
   * as `resolved: false` rather than an error.
   */
  country?: string | null;
}

export interface BachsResolveTaskBankAccountResponse {
  /**
   * Whether the account number was matched. `false` covers a wrong
   * number, an unsupported country, and a lookup that could not be
   * completed, so read `message` to tell them apart. A `false` here
   * is not an HTTP error.
   */
  resolved: boolean;
  /**
   * Name registered on the account. Show it back for confirmation
   * before you submit the payout destination. `null` when `resolved`
   * is `false`.
   */
  account_name: string | null;
  /**
   * The account number as it is held on record, which can be
   * normalised from what you sent. `null` when `resolved` is `false`.
   */
  account_number: string | null;
  /**
   * Why the lookup did not resolve, safe to show the account holder.
   * `null` on a successful match.
   */
  message: string | null;
}

export interface BachsBankAccountResolveRequest {
  /**
   * Bank code (e.g., '033')
   */
  bank_code: string;
  /**
   * Account number to resolve
   */
  account_number: string;
}

/**
 * Response containing bank account validation and resolution details
 */
export interface BachsBankAccountResolveResponse {
  /**
   * Whether the bank account was successfully resolved. true if
   * account details are valid, false if invalid.
   */
  status: boolean;
  /**
   * Human-readable message describing the resolution result.
   */
  message: string;
  /**
   * Resolved bank account details. Only present when status is true.
   * Contains account_name, bank_name, and other validated
   * information.
   */
  data: Record<string, unknown> | null;
  /**
   * Error message if account resolution failed. Only present when
   * status is false.
   */
  error: string | null;
}

/**
 * Response containing bank list results.
 */
export interface BachsBankListResponse {
  /**
   * Whether the request succeeded.
   */
  status: boolean;
  /**
   * Human-readable response message.
   */
  message: string;
  /**
   * Bank records when available.
   */
  data?: Array<{
    /**
     * Bank display name.
     */
    name: string;
    /**
     * Provider-specific stable slug for the bank.
     */
    slug: string;
    /**
     * Bank code used for payout account resolution.
     */
    code: string;
    /**
     * NIBSS bank code where applicable.
     */
    nibss_bank_code?: string | null;
    /**
     * Country code where the bank operates.
     */
    country: string;
  }> | null;
  /**
   * Error details when request fails.
   */
  error?: string | null;
}

/* Webhook endpoints and events */

/**
 * A webhook endpoint: a URL Bachs delivers events to, and the events
 * it is subscribed to.
 */
export interface BachsWebhookEndpoint {
  /**
   * Use this identifier to fetch, update, delete, or rotate the
   * secret on this endpoint, and to scope event listings to it.
   */
  endpoint_id: string;
  /**
   * The label you gave the endpoint. It is never sent to the endpoint
   * itself.
   */
  name: string;
  /**
   * The HTTPS URL we POST each subscribed event to. It must be
   * reachable from the public internet and should return a 2xx
   * quickly, since a slow or non-2xx response is recorded as a failed
   * attempt and retried.
   */
  url: string;
  /**
   * When `true`, matching events are delivered here. When `false`,
   * events still occur on your account but nothing is sent to this
   * URL.
   */
  enabled: boolean;
  /**
   * The event types this endpoint receives, stored lowercase.
   * Anything not listed is never delivered here, so add a type before
   * you rely on it.
   */
  event_types: BachsWebhookEventType[];
  /**
   * When the endpoint was created, as an ISO 8601 timestamp in UTC.
   */
  created_at: string;
  /**
   * When the endpoint was last changed, as an ISO 8601 timestamp in
   * UTC. Rotating the signing secret updates this.
   */
  updated_at: string;
  /**
   * Which account's events reach this endpoint. `account`: only
   * events that happened on your own account. `connect`: only events
   * that happened on accounts you own. `all`: both.
   */
  event_source?: 'account' | 'connect' | 'all';
}

/**
 * Parameters for creating a webhook endpoint.
 */
export interface BachsCreateWebhookEndpointRequest {
  /**
   * A label you choose to tell this endpoint apart from your others
   * in the dashboard and in list responses. It is never sent to the
   * endpoint.
   */
  name: string;
  /**
   * The HTTPS URL we POST each subscribed event to. It must be
   * reachable from the public internet and should return a 2xx
   * quickly, since a slow or non-2xx response is recorded as a failed
   * attempt and retried.
   */
  url: string;
  /**
   * The event types this endpoint receives. Send at least one;
   * anything not listed is never delivered here, so add a type before
   * you rely on it. Values are matched case-insensitively and stored
   * lowercase.
   */
  event_types: BachsWebhookEventType[];
  /**
   * Which account's events reach this endpoint. `account`: only
   * events that happened on your own account. `connect`: only events
   * that happened on accounts you own. `all`: both. Defaults to
   * `account` when you omit it.
   */
  event_source?: 'account' | 'connect' | 'all';
}

/**
 * Fields to update on a webhook endpoint. Only the fields you send
 * are changed.
 */
export interface BachsUpdateWebhookEndpointRequest {
  /**
   * Replaces the endpoint's label. Omit it to leave the current label
   * unchanged.
   */
  name?: string | null;
  /**
   * Moves delivery to a different HTTPS URL. Events already queued
   * for the old URL are retried against the new one, so cut over only
   * once the new receiver is live.
   */
  url?: string | null;
  /**
   * Replaces the whole subscription list rather than adding to it, so
   * send every type you still want. Omit the field to leave the
   * current list untouched; sending an empty array is rejected.
   */
  event_types?: BachsWebhookEventType[] | null;
  /**
   * Changes which account's events reach this endpoint. `account`:
   * only your own account's events. `connect`: only the events of
   * accounts you own. `all`: both. Omit it to leave the current
   * setting unchanged.
   */
  event_source?: 'account' | 'connect' | 'all';
}

/**
 * The created endpoint, plus its signing secret. The secret is
 * returned only once, on creation. Store it securely.
 */
export interface BachsCreateWebhookEndpointResponse {
  /**
   * Use this identifier to fetch, update, delete, or rotate the
   * secret on this endpoint, and to scope event listings to it.
   */
  endpoint_id: string;
  /**
   * The label you gave the endpoint. It is never sent to the endpoint
   * itself.
   */
  name: string;
  /**
   * The HTTPS URL we POST each subscribed event to.
   */
  url: string;
  /**
   * When `true`, matching events are delivered here. A new endpoint
   * is enabled straight away, so have your receiver deployed before
   * you create it.
   */
  enabled: boolean;
  /**
   * The event types this endpoint now receives, stored lowercase.
   * Anything not listed is never delivered here.
   */
  event_types: BachsWebhookEventType[];
  /**
   * When the endpoint was created, as an ISO 8601 timestamp in UTC.
   */
  created_at: string;
  /**
   * When the endpoint was last changed, as an ISO 8601 timestamp in
   * UTC. Rotating the signing secret updates this.
   */
  updated_at: string;
  /**
   * Use this to verify the `X-Bachs-Signature` header on every
   * delivery to this endpoint and reject anything that does not
   * match. It is shown in full only in this response, so store it in
   * your secret manager now; afterwards you can only read it back
   * from [Get Endpoint Secret](/api-reference/webhooks/get-webhook-
   * endpoint-secret) or replace it by rotating.
   */
  signing_secret: string;
  /**
   * Which account's events reach this endpoint. `account`: only your
   * own account's events. `connect`: only the events of accounts you
   * own. `all`: both.
   */
  event_source?: 'account' | 'connect' | 'all';
}

/**
 * An endpoint with its current signing secret.
 */
export interface BachsWebhookEndpointSecretResponse {
  /**
   * Use this identifier to fetch, update, delete, or rotate the
   * secret on this endpoint, and to scope event listings to it.
   */
  endpoint_id: string;
  /**
   * The label you gave the endpoint. It is never sent to the endpoint
   * itself.
   */
  name?: string;
  /**
   * The HTTPS URL we POST each subscribed event to.
   */
  url?: string;
  /**
   * When `true`, matching events are delivered here. When `false`,
   * events still occur on your account but nothing is sent to this
   * URL.
   */
  enabled?: boolean;
  /**
   * The event types this endpoint receives, stored lowercase.
   * Anything not listed is never delivered here.
   */
  event_types?: BachsWebhookEventType[];
  /**
   * When the endpoint was created, as an ISO 8601 timestamp in UTC.
   */
  created_at?: string;
  /**
   * When the endpoint was last changed, as an ISO 8601 timestamp in
   * UTC. Rotating the signing secret updates this.
   */
  updated_at?: string;
  /**
   * Use this to verify the `X-Bachs-Signature` header on every
   * delivery to this endpoint and reject anything that does not
   * match. This response and the create response are the only places
   * it is shown in full, so treat it like a password: never log it,
   * never put it in client-side code, and rotate it if it leaks.
   */
  secret: string;
  /**
   * Which account's events reach this endpoint. `account`: only your
   * own account's events. `connect`: only the events of accounts you
   * own. `all`: both.
   */
  event_source?: 'account' | 'connect' | 'all';
}

export interface BachsWebhookEndpointListResponse {
  /**
   * The webhook endpoints registered on this account, newest first.
   * One page of them, bounded by `limit`.
   */
  items: BachsWebhookEndpoint[];
  /**
   * Where this page sits in the full set, and the cursor for the next
   * one. See [Pagination](/guides/pagination).
   */
  pagination: BachsPaginationResponse;
}

/**
 * Confirmation that an endpoint was deleted.
 */
export interface BachsDeleteWebhookEndpointResponse {
  /**
   * Always `deleted` on success. The endpoint stops receiving events
   * immediately and its signing secret can no longer be read.
   */
  status: string;
  /**
   * Echoes the endpoint you deleted so you can reconcile the call
   * against your own records.
   */
  endpoint_id: string;
}

/**
 * Delivery counts for one period.
 */
export interface BachsWebhookMetricsDataPoint {
  /**
   * The first day of the bucket, as a `YYYY-MM-DD` date in UTC. For
   * `week` and `month` periods this is the day the bucket starts, not
   * a range.
   */
  date: string;
  /**
   * How many attempts in this bucket got a 2xx from your endpoint. A
   * retry that eventually succeeds counts here as well as counting
   * its earlier failures in `failed`.
   */
  success: number;
  /**
   * How many attempts in this bucket got a non-2xx response or never
   * connected. A sustained non-zero value means your receiver is
   * rejecting or timing out and events are being retried.
   */
  failed: number;
}

/**
 * Delivery metrics for an endpoint over a time range.
 */
export interface BachsWebhookMetricsResponse {
  /**
   * The number of delivery attempts across the whole range, as a
   * string. It equals the sum of `success` and `failed` over every
   * entry in `data`, so use it to compute a success rate without re-
   * adding the series.
   */
  total: string;
  /**
   * How the series is bucketed. `day`: one entry per calendar day
   * (the default, over the last 30 days when you send no dates).
   * `week`: one entry per week. `month`: one entry per month. An
   * unrecognised value falls back to `day`.
   */
  period: string;
  /**
   * One entry per bucket in the range, in ascending time order.
   * Buckets with no attempts are still returned with zero counts, so
   * the series is safe to plot without filling gaps yourself.
   */
  data: BachsWebhookMetricsDataPoint[];
}

/**
 * A summary of a webhook event across all endpoints.
 */
export interface BachsWebhookEventListItem {
  /**
   * Pass this to [Get Event](/api-reference/webhooks/get-webhook-
   * event) for the full payload and attempt history. It is also the
   * `id` inside the delivered payload, so you can use it to
   * deduplicate on your side.
   */
  event_id: string;
  /**
   * What happened, in `resource.action` form, for example
   * `customer.created` or `payout.paid`. Branch on this before
   * reading the payload.
   */
  event_type: string;
  /**
   * The kind of resource the event is about, for example `customer`,
   * `charge`, `payout`, `refund`, or `checkout`. It is `null` when
   * the event carries no identifiable resource.
   */
  entity_type?: string | null;
  /**
   * The identifier of the resource named by `entity_type`, so you can
   * correlate the event with your own records without opening the
   * payload. It is `null` when the event carries no identifiable
   * resource.
   */
  entity_id?: string | null;
  /**
   * When the event was recorded, as an ISO 8601 timestamp in UTC.
   * Events are returned newest first by this value, not by when they
   * were delivered.
   */
  created_at: string;
  /**
   * How many delivery attempts your endpoints have made for this
   * event in total. It is `0` when no endpoint was subscribed to this
   * event type at the time.
   */
  attempts: number;
  /**
   * How many of those attempts were answered with a 2xx. Anything
   * above zero means you have received this event at least once and
   * should have handled it idempotently.
   */
  success: number;
  /**
   * How many of those attempts were rejected or never connected. A
   * non-zero value with `success` at zero means this event has not
   * reached you yet.
   */
  failed: number;
  /**
   * When the most recent attempt was made, as an ISO 8601 timestamp
   * in UTC. It is `null` when the event has never been attempted.
   */
  last_attempt_at?: string | null;
  /**
   * How the most recent attempt ended. `pending`: queued and not yet
   * sent. `succeeded`: your endpoint answered with a 2xx. `failed`:
   * your endpoint answered with a non-2xx or could not be reached. It
   * is `null` when the event has never been attempted.
   */
  last_attempt_status?: ('pending' | 'succeeded' | 'failed') | null;
  /**
   * The HTTP status code your endpoint returned on the most recent
   * attempt. It is `null` when the connection never completed, for
   * example on a DNS failure or a timeout, which is what
   * distinguishes a transport failure from a rejection.
   */
  last_attempt_http_status?: number | null;
  /**
   * Why the most recent attempt failed, as a short diagnostic string
   * you can act on, for example a timeout or a TLS failure. It is
   * `null` when the attempt succeeded or none has been made.
   */
  last_attempt_error?: string | null;
  /**
   * The account the event happened on. It is your own account for
   * your own activity, and the id of the account when the event came
   * from one of the accounts you own, so use it to route the event to
   * the right tenant.
   */
  account?: string | null;
}

/**
 * A paginated list of webhook events.
 */
export interface BachsWebhookEventsListResponse {
  /**
   * Your account's events plus those of any accounts you own, newest
   * first, whether or not they were ever delivered. Each entry is a
   * summary; fetch the full payload and attempt history with [Get
   * Event](/api-reference/webhooks/get-webhook-event).
   */
  items: BachsWebhookEventListItem[];
  /**
   * How many events exist across your account and the accounts you
   * own, ignoring `limit` and `offset`. Use it to decide whether
   * another page is worth requesting.
   */
  total: number;
  /**
   * The page size actually applied, which is clamped to between 1 and
   * 100 whatever you request.
   */
  limit: number;
  /**
   * How many events were skipped before this page. Add `limit` to it
   * to request the next page.
   */
  offset: number;
}

/**
 * A summary of an event's delivery to one endpoint.
 */
export interface BachsWebhookEndpointEventListItem {
  /**
   * Pass this to [Get Endpoint Event](/api-reference/webhooks/get-
   * webhook-endpoint-event) for the full payload and attempt history,
   * or to the resend endpoint to try delivery again.
   */
  event_id: string;
  /**
   * What happened, in `resource.action` form, for example
   * `customer.created` or `payout.paid`. Branch on this before
   * reading the payload.
   */
  event_type: string;
  /**
   * The identifier of the resource the event is about, so you can
   * correlate the event with your own records without opening the
   * payload. It is `null` when the event carries no identifiable
   * resource.
   */
  entity_id?: string | null;
  /**
   * How many times we have tried to deliver this event to this
   * endpoint, including the original send and every retry.
   */
  attempts: number;
  /**
   * How many of those attempts your endpoint answered with a 2xx.
   * Anything above zero means you have received this event at least
   * once and should have handled it idempotently.
   */
  success: number;
  /**
   * How many of those attempts were rejected or never connected. A
   * non-zero value with `success` at zero means this event has not
   * reached you yet.
   */
  failed: number;
  /**
   * How the most recent attempt ended. `pending`: queued and not yet
   * sent. `succeeded`: your endpoint answered with a 2xx. `failed`:
   * your endpoint answered with a non-2xx or could not be reached. It
   * is `null` when no attempt has been recorded yet.
   */
  last_attempt_status?: string | null;
  /**
   * The HTTP status code your endpoint returned on the most recent
   * attempt. It is `null` when the connection never completed, for
   * example on a DNS failure or a timeout, which is what
   * distinguishes a transport failure from a rejection.
   */
  last_attempt_http_status?: number | null;
  /**
   * When the most recent attempt was made, as an ISO 8601 timestamp
   * in UTC. It is `null` when no attempt has been recorded yet.
   */
  last_attempt_at?: string | null;
  /**
   * Why the most recent attempt failed, as a short diagnostic string
   * you can act on, for example a timeout or a TLS failure. It is
   * `null` when the attempt succeeded.
   */
  last_attempt_error?: string | null;
}

/**
 * A paginated list of events delivered to an endpoint.
 */
export interface BachsWebhookEndpointEventsListResponse {
  /**
   * The events this endpoint has been sent, newest attempt first.
   * Each entry summarises delivery to this one endpoint; fetch the
   * full payload and every attempt with [Get Endpoint Event](/api-
   * reference/webhooks/get-webhook-endpoint-event).
   */
  items: BachsWebhookEndpointEventListItem[];
  /**
   * How many distinct events this endpoint has delivery attempts for,
   * ignoring `limit` and `offset`. Use it to decide whether another
   * page is worth requesting.
   */
  total: number;
  /**
   * The page size actually applied, which is clamped to between 1 and
   * 100 whatever you request.
   */
  limit: number;
  /**
   * How many events were skipped before this page. Add `limit` to it
   * to request the next page.
   */
  offset: number;
}

/**
 * A single delivery attempt for an event.
 */
export interface BachsWebhookEventAttempt {
  /**
   * Identifies this single delivery attempt. Quote it when you
   * contact support about a delivery you cannot account for.
   */
  attempt_id: string;
  /**
   * Where this attempt sits in the retry sequence for the event,
   * starting at `1` for the original send. A high number means the
   * event has been retried repeatedly and your endpoint has been
   * rejecting it.
   */
  attempt_no: number;
  /**
   * How this attempt ended. `pending`: queued and not yet sent.
   * `succeeded`: your endpoint answered with a 2xx. `failed`: your
   * endpoint answered with a non-2xx or could not be reached, and the
   * event is retried on a backoff.
   */
  status: string;
  /**
   * The URL this attempt was sent to, captured at send time, so an
   * attempt made before you changed the endpoint's `url` still shows
   * where it actually went. It is `null` on attempts recorded without
   * a resolved destination.
   */
  callback_url?: string | null;
  /**
   * The HTTP status code your endpoint returned. It is `null` when
   * the request never completed, for example on a DNS failure or a
   * timeout, which is how you tell a transport failure from a
   * rejection.
   */
  http_status?: number | null;
  /**
   * The first part of your endpoint's response body, kept so you can
   * see what your own handler replied without adding logging on your
   * side. It is `null` when no response body was received.
   */
  response_snippet?: string | null;
  /**
   * Why this attempt failed, as a short diagnostic string you can act
   * on, for example a timeout, a TLS failure, or the rejecting status
   * code. It is `null` when the attempt succeeded.
   */
  last_error?: string | null;
  /**
   * When the attempt was queued, as an ISO 8601 timestamp in UTC.
   */
  created_at: string;
  /**
   * When the attempt reached its final status, as an ISO 8601
   * timestamp in UTC. Subtract `created_at` from it to see how long
   * your endpoint took to answer.
   */
  updated_at: string;
}

/**
 * A webhook event with its full payload and delivery attempts.
 */
export interface BachsWebhookEventDetail {
  /**
   * Identifies this event everywhere it appears, including as `id`
   * inside the delivered payload, so you can use it as your
   * deduplication key when you process a redelivery.
   */
  event_id: string;
  /**
   * What happened, in `resource.action` form, for example
   * `customer.created` or `payout.paid`. Branch on this before
   * reading `payload`.
   */
  event_type: string;
  /**
   * The kind of resource the event is about, for example `customer`,
   * `charge`, `payout`, `refund`, or `checkout`. It is `null` when
   * the event carries no identifiable resource.
   */
  entity_type?: string | null;
  /**
   * The identifier of the resource named by `entity_type`, matching
   * the id you would use to fetch that resource from its own
   * endpoint. It is `null` when the event carries no identifiable
   * resource.
   */
  entity_id?: string | null;
  /**
   * When the event was recorded, as an ISO 8601 timestamp in UTC.
   * This is the moment the change happened, not the moment it was
   * delivered.
   */
  created_at: string;
  /**
   * The exact JSON body sent to your endpoint, byte for byte. It
   * wraps the resource in an envelope of `id`, `type`, `created_at`,
   * `organization_id`, and `data`, and adds `account` when the event
   * came from an account you own. Replay this against your handler to
   * reproduce a delivery.
   */
  payload: Record<string, unknown>;
  /**
   * Every delivery attempt made for this event, newest attempt number
   * first. Read the first entry to see the current state and the rest
   * to see what your endpoint returned on earlier tries.
   */
  attempts: BachsWebhookEventAttempt[];
}

/**
 * The result of re-delivering an event.
 */
export interface BachsResendWebhookEventResponse {
  /**
   * Always `queued` on success. The redelivery is asynchronous, so a
   * `queued` response means the attempt was accepted, not that your
   * endpoint has received it; poll the event's `attempts` to see the
   * outcome.
   */
  status: string;
  /**
   * The new delivery attempt created by this call. Match it against
   * the `attempts` array on [Get Event](/api-reference/webhooks/get-
   * webhook-event) to see whether the redelivery succeeded.
   */
  attempt_id: string;
}

/* Webhook delivery envelope, event payloads and event names */

/**
 * The wrapper Bachs POSTs to your endpoint. `data` carries the
 * payload for the event named by `type`.
 */
export interface BachsWebhookEnvelope<T = Record<string, unknown>> {
  /**
   * The event's unique identifier, prefixed `evt_`. Use it to
   * deduplicate deliveries.
   */
  id: string;
  /**
   * The event name, for example `collection.succeeded`.
   */
  type: string;
  /**
   * When the event occurred, in UTC.
   */
  created_at: string;
  /**
   * The account the event happened on.
   */
  organization_id: string;
  /**
   * The event payload. See BachsEventPayloadMap for the shape each
   * event name carries.
   */
  data: T;
}

/**
 * Payload of a `checkout.completed` event.
 */
export interface BachsCheckoutCompletedEventData {
  /**
   * The checkout session that completed.
   */
  checkout_id: string;
  /**
   * Always `completed`.
   */
  status: 'completed';
  /**
   * The checkout's mode: `payment`, `setup`, or `subscription`.
   */
  mode: string;
  /**
   * Whether a payment was collected at checkout. `paid` when a charge
   * was made, `no_payment_required` when nothing was due, which
   * covers a free ($0) checkout, a `setup`-mode checkout, or a
   * subscription on a free trial (billed at trial end).
   */
  payment_status: string;
  /**
   * The checkout amount, as a decimal string. `"0"` for a free
   * checkout.
   */
  amount: string;
  /**
   * The checkout currency code.
   */
  currency: string | null;
  /**
   * Checkout reference you supplied, when available.
   */
  reference: string | null;
  /**
   * The customer who completed the checkout, or `null` if none was
   * attached.
   */
  customer: BachsCustomerDetailResponse | null;
  /**
   * The resulting charge, in the same shape as `GET
   * /v1/payments/charges/{charge_id}`. `null` for a free checkout,
   * since no charge is created when nothing is collected.
   */
  charge: BachsChargeStatusResponse | null;
  /**
   * `{ subscription_id }` for a `subscription`-mode checkout. `null`
   * for `payment` and `setup` modes.
   */
  subscription: { subscription_id: string } | null;
  /**
   * Where the customer was redirected after completing.
   */
  success_url: string | null;
  /**
   * Where the customer would have been redirected had they canceled.
   */
  cancel_url: string | null;
  /**
   * Public metadata stored on the checkout.
   */
  metadata: Record<string, unknown>;
  /**
   * When the checkout completed, in UTC.
   */
  completed_at: string;
  /**
   * The checkout's original expiry time, in UTC.
   */
  expires_at: string | null;
  /**
   * When the checkout session was created, in UTC.
   */
  created_at: string;
}

/**
 * Payload of a `checkout.expired` event.
 */
export interface BachsCheckoutExpiredEventData {
  /**
   * The checkout session that expired.
   */
  checkout_id: string;
  /**
   * Always `expired`.
   */
  status: 'expired';
  /**
   * The checkout's mode: `payment`, `setup`, or `subscription`.
   */
  mode: string;
  /**
   * Always `null`. An expired checkout never collected payment.
   */
  payment_status: null;
  /**
   * The amount the checkout would have collected, as a decimal
   * string.
   */
  amount: string;
  /**
   * The checkout currency code.
   */
  currency: string | null;
  /**
   * Checkout reference you supplied, when available.
   */
  reference: string | null;
  /**
   * The customer attached to the checkout, or `null` if none was
   * attached.
   */
  customer: BachsCustomerDetailResponse | null;
  /**
   * Always `null`. An expired checkout has no charge.
   */
  charge: null;
  /**
   * Always `null`. An expired checkout never started a subscription.
   */
  subscription: null;
  /**
   * Where the customer would have been redirected on success.
   */
  success_url: string | null;
  /**
   * Where the customer would have been redirected had they canceled.
   */
  cancel_url: string | null;
  /**
   * Public metadata stored on the checkout.
   */
  metadata: Record<string, unknown>;
  /**
   * Always `null`. The checkout was never completed.
   */
  completed_at: null;
  /**
   * When the checkout's expiry lapsed, in UTC.
   */
  expires_at: string;
  /**
   * When the checkout session was created, in UTC.
   */
  created_at: string;
}

/**
 * Payload of a `collection.succeeded` event.
 */
export interface BachsCollectionSucceededEventData {
  /**
   * Charge ID for reconciliation and retrieval calls. May be `null`,
   * see note above.
   */
  charge_id: string | null;
  /**
   * Checkout that originated the charge, when applicable.
   */
  checkout_id: string | null;
  /**
   * Checkout reference you supplied, when available.
   */
  reference: string | null;
  /**
   * Successful charge state. Typical values: `succeeded`, `accepted`,
   * `overpaid`.
   */
  status: BachsChargeStatus;
  /**
   * Original charged amount in `data.currency`.
   */
  amount: string;
  /**
   * Customer payment currency code.
   */
  currency: string;
  /**
   * Amount credited in `data.settlement_currency`.
   */
  settlement_amount: string;
  /**
   * Currency used for settlement credit.
   */
  settlement_currency: string;
  /**
   * Payment method used to process this charge, e.g. `BANK_TRANSFER`,
   * `CARD`, `MOBILE_MONEY`.
   */
  payment_method: string;
  /**
   * Platform processing fee in `data.processing_fee_currency`. Null
   * when the final settlement value has not yet been determined
   * (deferred settlement).
   */
  processing_fee: string | null;
  /**
   * Currency of `data.processing_fee`, typically the settlement
   * currency. Null when `processing_fee` is null.
   */
  processing_fee_currency: string | null;
  /**
   * Who absorbed the processing fee. Either `customer` (fee added on
   * top of the charge amount) or `merchant` (fee deducted from
   * settlement).
   */
  fee_bearer: string;
  /**
   * Products purchased in a one-time checkout session. Each item
   * contains `product_id`, `quantity`, and `amount` (present only for
   * custom-priced products).
   */
  product_cart: BachsProductItemRequest[] | null;
  /**
   * The customer who made the payment, with `id`, `email`, and
   * `name`.
   */
  customer: BachsCheckoutCustomer;
  /**
   * Public metadata stored with the charge.
   */
  metadata: Record<string, unknown>;
}

/**
 * Payload of a `collection.failed` event.
 */
export interface BachsCollectionFailedEventData {
  /**
   * Charge ID for support and reconciliation workflows.
   */
  charge_id: string;
  /**
   * Checkout that originated the charge, when available.
   */
  checkout_id: string | null;
  /**
   * Checkout reference, when available.
   */
  reference: string | null;
  /**
   * Failed terminal state, typically `failed` or `expired`.
   */
  status: BachsChargeStatus;
  /**
   * Original charge amount in `data.currency`.
   */
  amount: string;
  /**
   * Customer payment currency code.
   */
  currency: string;
  /**
   * Settlement amount, `0.00` for a failed charge.
   */
  settlement_amount: string;
  /**
   * Settlement currency.
   */
  settlement_currency: string;
  /**
   * Payment method attempted.
   */
  payment_method: string;
  /**
   * A human-readable reason for the failure, when available.
   */
  reason: string | null;
  /**
   * The customer, with `id`, `email`, and `name`.
   */
  customer: BachsCheckoutCustomer;
  /**
   * Public metadata stored with the charge.
   */
  metadata: Record<string, unknown>;
}

/**
 * Payload of a `collection.underpaid` event.
 */
export interface BachsCollectionUnderpaidEventData {
  /**
   * The underpaid charge's ID.
   */
  charge_id: string;
  /**
   * Checkout reference, when available.
   */
  reference: string | null;
  /**
   * The checkout that originated the charge.
   */
  checkout_id: string | null;
  /**
   * Amount the customer actually paid, in `data.currency`.
   */
  amount_paid: string;
  /**
   * Amount that was due.
   */
  amount_expected: string;
  /**
   * The shortfall: `amount_expected` minus `amount_paid`.
   */
  amount_remaining: string;
  /**
   * Customer payment currency code.
   */
  currency: string;
  /**
   * Always `underpaid`.
   */
  status: BachsChargeStatus;
  /**
   * Public metadata stored with the charge.
   */
  metadata: Record<string, unknown>;
}

/**
 * Payload shared by the `customer.subscription.created`,
 * `customer.subscription.updated` and `customer.subscription.deleted`
 * events.
 */
export interface BachsSubscriptionEventData {
  /**
   * The subscription's ID.
   */
  subscription_id: string;
  /**
   * The full customer object: `customer_id`, `email`, `name`,
   * `phone_number`, `metadata`, `billing_address`, `created_at`, and
   * `updated_at`.
   */
  customer: BachsCustomerDetailResponse;
  /**
   * The product the subscription bills.
   */
  product_id: string;
  /**
   * Subscription status: `trialing`, `active`, `past_due`, `unpaid`,
   * `canceled`, or `paused`.
   */
  status: BachsSubscriptionStatus;
  /**
   * How renewals are collected, e.g. `charge_automatically`.
   */
  collection_method: string;
  /**
   * The billing currency, as an ISO 4217 code.
   */
  currency: string;
  /**
   * The recurring amount, as a decimal string.
   */
  amount: string;
  /**
   * The cadence: `{ interval, frequency }`.
   */
  billing_cycle: BachsSubscriptionCadence;
  /**
   * Start of the current billing period, in UTC.
   */
  current_period_start: string;
  /**
   * End of the current billing period, in UTC.
   */
  current_period_end: string;
  /**
   * When the subscription next renews, in UTC.
   */
  next_billed_at: string | null;
  /**
   * When the trial ends, or `null` if not trialing.
   */
  trial_end: string | null;
  /**
   * Whether the subscription is set to end at the period end.
   */
  cancel_at_period_end: boolean;
  /**
   * When the subscription was canceled, or `null`.
   */
  canceled_at: string | null;
  /**
   * The line items being billed.
   */
  items: BachsSubscriptionItem[];
  /**
   * Your own key-value data on the subscription.
   */
  metadata: Record<string, unknown>;
}

/**
 * Payload shared by the `invoice.created`, `invoice.paid` and
 * `invoice.payment_failed` events.
 */
export interface BachsInvoiceEventData {
  /**
   * The invoice's ID.
   */
  invoice_id: string;
  /**
   * The subscription this invoice belongs to, or `null` for a one-
   * off.
   */
  subscription: { subscription_id: string } | null;
  /**
   * The customer the invoice is for.
   */
  customer: {
    customer_id: string;
    email: string;
    name: string | null;
  };
  /**
   * The payment that collected the invoice, once collection is
   * attempted.
   */
  charge: BachsChargeStatusResponse | null;
  /**
   * Invoice status: `draft`, `open`, `paid`, `uncollectible`, or
   * `void`.
   */
  status: string;
  /**
   * How the invoice is collected, e.g. `charge_automatically`.
   */
  collection_method: string;
  /**
   * The invoice currency, as an ISO 4217 code.
   */
  currency: string;
  /**
   * The subtotal before credits, as a decimal string.
   */
  subtotal: string;
  /**
   * The total due, as a decimal string.
   */
  total: string;
  /**
   * Amount paid so far.
   */
  amount_paid: string;
  /**
   * Amount still due.
   */
  amount_remaining: string;
  /**
   * Start of the billing period, in UTC.
   */
  period_start: string;
  /**
   * End of the billing period, in UTC.
   */
  period_end: string;
  /**
   * Number of collection attempts made.
   */
  attempt_count: number;
  /**
   * When the next collection attempt is scheduled.
   */
  next_payment_attempt: string | null;
  /**
   * Your own key-value data on the invoice.
   */
  metadata: Record<string, unknown>;
}

/**
 * Payload shared by the `payout.created`, `payout.paid` and
 * `payout.failed` events.
 */
export interface BachsPayoutEventData {
  /**
   * The withdrawal's ID.
   */
  withdrawal_id: string;
  /**
   * The reference you set when you created the payout. `null` if you
   * set none.
   */
  reference: string | null;
  /**
   * Withdrawal status, `pending` on this event.
   */
  status: string;
  /**
   * The withdrawal amount in `data.currency`.
   */
  amount: string;
  /**
   * The source currency, as an ISO 4217 code.
   */
  currency: string;
  /**
   * The currency debited from your balance.
   */
  from_currency: string | null;
  /**
   * The currency delivered to the destination.
   */
  to_currency: string | null;
  /**
   * The FX rate applied, when a conversion occurred.
   */
  exchange_rate: string | null;
  /**
   * The amount delivered in `data.to_currency`.
   */
  to_amount: string | null;
  /**
   * The withdrawal fee, when applicable.
   */
  withdrawal_fee: string | null;
  /**
   * The net amount debited after fees.
   */
  net_from_amount: string | null;
}

/**
 * Payload shared by the `refund.created`, `refund.paid` and
 * `refund.failed` events.
 */
export interface BachsRefundEventData {
  /**
   * The refund's ID.
   */
  refund_id: string;
  /**
   * The charge being refunded.
   */
  charge_id: string;
  /**
   * The reference you set when you requested the refund. Required, so
   * it is always present.
   */
  reference: string;
  /**
   * Refund status, e.g. `processing`, `paid`, `failed`.
   */
  status: string;
  /**
   * The amount requested to refund, as a decimal string.
   */
  requested_amount: string;
  /**
   * The amount actually refunded so far.
   */
  refunded_amount: string | null;
  /**
   * The fee charged on the refund, if any.
   */
  refund_fee_amount: string;
  /**
   * Who absorbs the refund fee, `customer` or `merchant`.
   */
  fee_bearer: string;
  /**
   * The reason for the refund, when provided.
   */
  reason: string | null;
}

/**
 * Payload shared by the `dispute.created` and `dispute.updated`
 * events.
 */
export interface BachsDisputeEventData {
  /**
   * The dispute's ID.
   */
  dispute_id: string;
  /**
   * The disputed charge.
   */
  charge_id: string;
  /**
   * The disputed amount, as a decimal string.
   */
  amount: string;
  /**
   * The dispute currency, as an ISO 4217 code.
   */
  currency: string;
  /**
   * Dispute status, e.g. `needs_response`, `under_review`, `won`,
   * `lost`, `closed`.
   */
  status: string;
  /**
   * Whether you can still submit or update evidence.
   */
  is_response_editable: boolean;
  /**
   * The reason the dispute was raised.
   */
  reason: string | null;
  /**
   * When your evidence is due, in UTC.
   */
  response_deadline_at: string | null;
  /**
   * When the dispute was created, in UTC.
   */
  created_at: string | null;
  /**
   * When the dispute was last updated, in UTC.
   */
  updated_at: string | null;
  /**
   * The charge's full amount, as a decimal string in
   * `data.charge_currency`. A dispute can cover less than the full
   * charge when only part of an order is disputed, so this is not
   * always equal to `data.amount`.
   */
  charge_amount: string | null;
  /**
   * The charge's currency, as an ISO 4217 code.
   */
  charge_currency: string | null;
}

/**
 * Payload shared by the `conversion.completed` and
 * `conversion.failed` events.
 */
export interface BachsConversionEventData {
  /**
   * The conversion's ID.
   */
  conversion_id: string;
  /**
   * The quote the conversion was executed against.
   */
  quote_id: string;
  /**
   * The source currency, as an ISO 4217 code.
   */
  from_currency: string;
  /**
   * The target currency, as an ISO 4217 code.
   */
  to_currency: string;
  /**
   * The amount converted from, as a decimal string.
   */
  from_amount: string;
  /**
   * The amount received in the target currency.
   */
  to_amount: string;
  /**
   * The FX rate applied.
   */
  exchange_rate: string;
  /**
   * Conversion status, e.g. `completed`, `failed`.
   */
  status: string;
}

/**
 * Payload of an `account.updated` event.
 */
export interface BachsAccountUpdatedEventData {
  /**
   * The account's id. Matches `organization_id`.
   */
  account: string;
  /**
   * The field keys still being asked for, for example
   * `company.registration_number` or
   * `persons.per_3a91c0d7.id_document`. An empty array means nothing
   * is left for the account to provide. It does not mean a capability
   * is enabled.
   */
  outstanding: string[];
}

/**
 * Payload of a `capability.updated` event.
 */
export interface BachsCapabilityUpdatedEventData {
  /**
   * The account's id. Matches `organization_id`.
   */
  account: string;
  /**
   * The capability that changed, for example `payouts`, `transfers`,
   * `conversions`, or a payment method capability such as
   * `card_collection`. See [Capabilities](/connect/capabilities) for
   * the full list.
   */
  capability: string;
  /**
   * The capability's new status. In this event, always one of
   * `active` (enabled, the account can perform the action) or
   * `restricted` (not enabled). The status read API also defines
   * `pending` and `unsupported`, but nothing in this codebase writes
   * either today, so this event never carries them; do not build
   * handling for them.
   */
  status: string;
  /**
   * Whether the account ever requested this capability. A
   * `restricted` capability that was requested is in progress; one
   * that was never requested is outside the account's setup.
   */
  requested: boolean;
}

/**
 * Payload of a `transfer.created` event.
 */
export interface BachsTransferCreatedEventData {
  /**
   * The transfer's id, prefixed `tr_`.
   */
  transfer_id: string;
  /**
   * Whoever was debited. Your platform on a transfer out, the account
   * on a transfer back.
   */
  source: string;
  /**
   * Whoever was credited.
   */
  destination: string;
  /**
   * The amount moved, as a decimal string in `data.currency`.
   */
  amount: string;
  /**
   * The currency moved, as an ISO 4217 code. Both balances hold it; a
   * transfer never converts.
   */
  currency: string;
  /**
   * The description set on the transfer.
   */
  description: string | null;
  /**
   * The metadata set on the transfer, returned unchanged.
   */
  metadata: Record<string, unknown>;
  /**
   * What this movement is. `payout` is a seller's share of a sale you
   * made, and `manual` is a transfer you created yourself. The
   * platform's own cut of a sale is never a transfer, see [Platform
   * fees](/connect/platform-fees).
   */
  kind: string;
  /**
   * The charge that funded this movement, prefixed `ch_`, when one
   * did. Null on a transfer you created yourself, which is tied to no
   * charge.
   */
  source_charge_id: string | null;
  /**
   * When the transfer was created, in UTC.
   */
  created_at: string | null;
}

/**
 * Payload shared by the `customer.created` and `customer.updated`
 * events, which carry the customer object itself.
 */
export type BachsCustomerEventData = BachsCustomerDetailResponse;

export interface BachsEventPayloadMap {
  'checkout.completed': BachsCheckoutCompletedEventData;
  'checkout.expired': BachsCheckoutExpiredEventData;
  'collection.succeeded': BachsCollectionSucceededEventData;
  'collection.failed': BachsCollectionFailedEventData;
  'collection.underpaid': BachsCollectionUnderpaidEventData;
  'customer.subscription.created': BachsSubscriptionEventData;
  'customer.subscription.updated': BachsSubscriptionEventData;
  'customer.subscription.deleted': BachsSubscriptionEventData;
  'invoice.created': BachsInvoiceEventData;
  'invoice.paid': BachsInvoiceEventData;
  'invoice.payment_failed': BachsInvoiceEventData;
  'payout.created': BachsPayoutEventData;
  'payout.paid': BachsPayoutEventData;
  'payout.failed': BachsPayoutEventData;
  'refund.created': BachsRefundEventData;
  'refund.paid': BachsRefundEventData;
  'refund.failed': BachsRefundEventData;
  'dispute.created': BachsDisputeEventData;
  'dispute.updated': BachsDisputeEventData;
  'conversion.completed': BachsConversionEventData;
  'conversion.failed': BachsConversionEventData;
  'customer.created': BachsCustomerEventData;
  'customer.updated': BachsCustomerEventData;
  'account.updated': BachsAccountUpdatedEventData;
  'capability.updated': BachsCapabilityUpdatedEventData;
  'transfer.created': BachsTransferCreatedEventData;
}
