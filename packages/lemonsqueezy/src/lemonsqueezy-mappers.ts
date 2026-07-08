import type { LemonSqueezyCustomer, LemonSqueezySubscription } from './lemonsqueezy-types';

export function mapCustomerToPaykit(ls: LemonSqueezyCustomer) {
  const a = ls.attributes;
  return {
    id: ls.id,
    email: a.email,
    name: a.name,
    metadata: {
      city: a.city,
      region: a.region,
      country: a.country,
    },
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}

// Adjust field names to match paykit's actual Subscription type in packages/core
export function mapSubscriptionToPaykit(ls: LemonSqueezySubscription) {
  const a = ls.attributes;
  return {
    id: ls.id,
    customerId: String(a.customer_id),
    status: a.status,
    productId: String(a.product_id),
    variantId: String(a.variant_id),
    cancelAtPeriodEnd: a.cancelled,
    currentPeriodEnd: a.renews_at ?? a.ends_at ?? null,
    trialEnd: a.trial_ends_at,
    createdAt: a.created_at,
    updatedAt: a.updated_at,
  };
}