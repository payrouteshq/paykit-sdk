// Lemon Squeezy JSON:API resource shapes.
// Docs: https://docs.lemonsqueezy.com/api

export interface LemonSqueezyResource<TAttrs> {
  type: string;
  id: string;
  attributes: TAttrs;
}

export interface LemonSqueezyCustomerAttributes {
  store_id: number;
  name: string;
  email: string;
  status: 'subscribed' | 'unsubscribed' | 'archived' | 'requires_verification' | 'invalid_email';
  city: string | null;
  region: string | null;
  country: string | null;
  total_revenue_currency: number;
  mrr: number;
  status_formatted: string;
  country_formatted: string;
  urls: { customer_portal: string | null };
  created_at: string;
  updated_at: string;
  test_mode: boolean;
}

export type LemonSqueezyCustomer = LemonSqueezyResource<LemonSqueezyCustomerAttributes>;

export interface LemonSqueezySubscriptionAttributes {
  store_id: number;
  customer_id: number;
  order_id: number;
  order_item_id: number;
  product_id: number;
  variant_id: number;
  product_name: string;
  variant_name: string;
  user_name: string;
  user_email: string;
  status: 'on_trial' | 'active' | 'paused' | 'past_due' | 'unpaid' | 'cancelled' | 'expired';
  status_formatted: string;
  card_brand: string | null;
  card_last_four: string | null;
  payment_processor: 'stripe' | 'paypal';
  pause: { mode: 'void' | 'free'; resumes_at: string | null } | null;
  cancelled: boolean;
  trial_ends_at: string | null;
  billing_anchor: number;
  ends_at?: string | null;
  renews_at?: string | null;
  created_at: string;
  updated_at: string;
}

export type LemonSqueezySubscription = LemonSqueezyResource<LemonSqueezySubscriptionAttributes>;

export interface LemonSqueezyOrderAttributes {
  store_id: number;
  customer_id: number;
  identifier: string;
  order_number: number;
  user_name: string;
  user_email: string;
  currency: string;
  subtotal: number;
  discount_total: number;
  tax: number;
  total: number;
  status: 'pending' | 'failed' | 'paid' | 'refunded' | 'partial_refund' | 'fraudulent';
  status_formatted: string;
  refunded: boolean;
  refunded_at: string | null;
  created_at: string;
  updated_at: string;
}

export type LemonSqueezyOrder = LemonSqueezyResource<LemonSqueezyOrderAttributes>;

// Webhook envelope: { meta: { event_name, custom_data? }, data: <resource> }
export interface LemonSqueezyWebhookPayload<TResource = LemonSqueezyOrder | LemonSqueezySubscription> {
  meta: {
    event_name: LemonSqueezyRawEventName;
    custom_data?: Record<string, unknown>;
  };
  data: TResource;
}

export type LemonSqueezyRawEventName =
  | 'order_created'
  | 'order_refunded'
  | 'subscription_created'
  | 'subscription_updated'
  | 'subscription_cancelled'
  | 'subscription_resumed'
  | 'subscription_expired'
  | 'subscription_paused'
  | 'subscription_unpaused'
  | 'subscription_payment_success'
  | 'subscription_payment_failed'
  | 'subscription_payment_recovered'
  | 'subscription_payment_refunded'
  | 'license_key_created'
  | 'license_key_updated'
  | 'customer_updated';

// paykit's normalized event names — adjust to match what stripe-provider.ts actually exports
export type PaykitEventType =
  | 'customer.created'
  | 'customer.updated'
  | 'payment.succeeded'
  | 'payment.failed'
  | 'payment.refunded'
  | 'subscription.created'
  | 'subscription.updated'
  | 'subscription.cancelled'
  | 'subscription.expired'
  | 'unknown';

export const LEMONSQUEEZY_EVENT_MAP: Record<LemonSqueezyRawEventName, PaykitEventType> = {
  order_created: 'payment.succeeded',
  order_refunded: 'payment.refunded',
  subscription_created: 'subscription.created',
  subscription_updated: 'subscription.updated',
  subscription_cancelled: 'subscription.cancelled',
  subscription_resumed: 'subscription.updated',
  subscription_expired: 'subscription.expired',
  subscription_paused: 'subscription.updated',
  subscription_unpaused: 'subscription.updated',
  subscription_payment_success: 'payment.succeeded',
  subscription_payment_failed: 'payment.failed',
  subscription_payment_recovered: 'payment.succeeded',
  subscription_payment_refunded: 'payment.refunded',
  license_key_created: 'unknown',
  license_key_updated: 'unknown',
  customer_updated: 'customer.updated',
};

export function mapEventType(eventName: string): PaykitEventType {
  return LEMONSQUEEZY_EVENT_MAP[eventName as LemonSqueezyRawEventName] ?? 'unknown';
}