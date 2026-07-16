import {
  Subscription as PaykitSubscription,
  Checkout as PaykitCheckout,
  Customer as PaykitCustomer,
  Invoice as PaykitInvoice,
  PaykitMetadata,
  SubscriptionStatus,
  BillingMode,
  Payment,
  PaymentStatus,
  Refund as PaykitRefund,
  omitInternalMetadata,
  PAYKIT_METADATA_KEY,
} from '@paykit-sdk/core';
import { Checkout } from '@polar-sh/sdk/models/components/checkout';
import { CheckoutStatus } from '@polar-sh/sdk/models/components/checkoutstatus.js';
import { Customer } from '@polar-sh/sdk/models/components/customer';
import { Order } from '@polar-sh/sdk/models/components/order';
import { Refund } from '@polar-sh/sdk/models/components/refund.js';
import { Subscription } from '@polar-sh/sdk/models/components/subscription';
import { SubscriptionBillingInterval } from '@paykit-sdk/core';

/**
 * @internal
 */
export const Checkout$inboundSchema = (
  checkout: Checkout,
): PaykitCheckout => {
  return {
    id: checkout.id,
    payment_url: checkout.url,
    customer: checkout.customerId
      ? { id: checkout.customerId }
      : checkout.customerEmail
        ? { email: checkout.customerEmail }
        : null,
    session_type: checkout.subscriptionId ? 'recurring' : 'one_time',
    products: checkout.products.map(product => ({
      id: product.id,
      quantity: 1,
    })),
    metadata:
      omitInternalMetadata(checkout.metadata as PaykitMetadata) ??
      null,
    currency: checkout.currency,
    amount: checkout.amount,
  };
};

/**
 * @internal
 */
export const Customer$inboundSchema = (
  customer: Customer,
): PaykitCustomer => {
  const phone =
    JSON.parse(
      (customer.metadata?.[PAYKIT_METADATA_KEY] as string) ?? '{}',
    ).phone ?? null;

  return {
    id: customer.id,
    email: customer.email ?? '',
    name: customer.name ?? '',
    phone,
    metadata: omitInternalMetadata(customer.metadata ?? {}),
    created_at: customer.createdAt,
    updated_at: customer.modifiedAt ?? null,
    custom_fields: {
      emailVerified: customer.emailVerified,
      taxId: customer.taxId,
      avatarUrl: customer.avatarUrl,
      billingAddress: customer.billingAddress,
    },
  };
};

/**
 * @internal
 */
export const Subscription$inboundSchema = (
  subscription: Subscription,
): PaykitSubscription => {
  const subscriptionStatusMap: Record<
    Subscription['status'],
    SubscriptionStatus
  > = {
    active: 'active',
    past_due: 'past_due',
    incomplete: 'past_due',
    canceled: 'canceled',
    unpaid: 'past_due',
    incomplete_expired: 'expired',
    trialing: 'trialing',
  };

  const status = subscriptionStatusMap[subscription.status];

  return {
    id: subscription.id,
    customer: subscription.customerId
      ? { id: subscription.customerId }
      : subscription.customer.email
        ? { email: subscription.customer.email }
        : null,
    status,
    current_period_start: new Date(subscription.currentPeriodStart),
    current_period_end: new Date(subscription.currentPeriodEnd!),
    metadata: omitInternalMetadata(subscription.metadata ?? {}),
    custom_fields: subscription.customFieldData ?? null,
    item_id: subscription.productId,
    billing_interval:
      subscription.recurringInterval as SubscriptionBillingInterval,
    currency: subscription.currency,
    amount: subscription.amount,
    requires_action: false,
    payment_url: null,
  };
};

type InvoicePayload = Order & { billingMode: BillingMode };

/**
 * @internal
 */
export const Invoice$inboundSchema = (
  invoice: InvoicePayload,
): PaykitInvoice => {
  const status = (() => {
    if (invoice.status == 'paid') return 'paid';
    return 'open';
  })();

  return {
    id: invoice.id,
    amount_paid: invoice.totalAmount,
    currency: invoice.currency,
    metadata: omitInternalMetadata(invoice.metadata ?? {}),
    customer: invoice.customerId
      ? { id: invoice.customerId }
      : invoice.customer.email
        ? { email: invoice.customer.email }
        : null,
    billing_mode: invoice.billingMode,
    custom_fields: invoice.customFieldData ?? null,
    status,
    subscription_id: invoice.subscription?.id ?? null,
    paid_at: new Date(invoice.createdAt).toISOString(),
    line_items: invoice.items.map(({ productPriceId }) => ({
      id: productPriceId ?? '',
      quantity: invoice.items.length,
    })),
  };
};

/**
 * @internal
 */
export const Payment$inboundSchema = (
  checkout: Checkout,
): Payment => {
  const statusMap: Record<CheckoutStatus, PaymentStatus> = {
    open: 'pending',
    expired: 'canceled',
    confirmed: 'requires_capture',
    succeeded: 'succeeded',
    failed: 'failed',
  } as const;

  return {
    id: checkout.id,
    amount: checkout.amount,
    currency: checkout.currency,
    customer: checkout.customerId
      ? { id: checkout.customerId }
      : checkout.customerEmail
        ? { email: checkout.customerEmail }
        : null,
    status: statusMap[checkout.status],
    metadata:
      omitInternalMetadata(checkout.metadata as PaykitMetadata) ?? {},
    item_id:
      checkout.products.length > 0 ? checkout.products[0].id : null,
    requires_action: checkout.status === 'open' ? true : false,
    payment_url: checkout.status === 'open' ? checkout.url : null,
  };
};

/**
 * @internal
 */
export const Refund$inboundSchema = (
  refund: Refund,
): PaykitRefund => {
  return {
    id: refund.id,
    amount: refund.amount,
    currency: refund.currency,
    reason: refund.reason,
    metadata: omitInternalMetadata(refund.metadata ?? {}),
  };
};
