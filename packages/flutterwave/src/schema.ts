/**
 * Friendly aliases over the types generated from Flutterwave's v4
 * OpenAPI spec (`openapi.json`, via `pnpm generate:types`).
 *
 * The spec leaves `required` off most response fields. Where a field is
 * always present in practice, the response aliases below mark it
 * required so callers don't have to null-check it.
 *
 * Flutterwave v4 has no hosted checkout and no subscription API. A
 * payment is a `charge`, or an `order` when it is authorized first and
 * captured later. Both are created against a `customer` and a
 * `payment_method`, either by id or inline through the orchestrator.
 */
import type { components } from './generated/schema';

type Schemas = components['schemas'];

type WithRequired<T, K extends keyof T> = T & { [P in K]-?: T[P] };

/* Response envelope */

export interface FlutterwaveEnvelope<T> {
  status?: Schemas['status'];
  message?: string;
  data?: T;
}

/* Resources */

export type FlutterwaveCustomer = WithRequired<
  Schemas['customer'],
  'id' | 'email' | 'created_datetime'
>;

export type FlutterwaveCharge = WithRequired<
  Schemas['charge'],
  'id' | 'amount' | 'currency' | 'status' | 'created_datetime'
>;

export type FlutterwaveOrder = WithRequired<
  Schemas['order'],
  'id' | 'amount' | 'currency' | 'status' | 'created_datetime'
>;

export type FlutterwaveRefund = WithRequired<
  Schemas['refund'],
  'id' | 'status'
>;

/* Status unions */

export type FlutterwaveChargeStatus = Schemas['charge_status'];
export type FlutterwaveOrderStatus = Schemas['order_status'];
export type FlutterwaveRefundStatus = NonNullable<
  Schemas['refund']['status']
>;
export type FlutterwaveRefundReason = NonNullable<
  Schemas['refund']['reason']
>;
export type FlutterwaveNextAction = Schemas['next_action'];

/* Requests */

export type FlutterwaveCreateCustomerRequest = Schemas['customer_in'];
export type FlutterwaveUpdateCustomerRequest =
  Schemas['customer_update_in'];
export type FlutterwaveCreateChargeRequest = Schemas['charge_in'];
export type FlutterwaveUpdateChargeRequest = Schemas['charge_update_in'];
export type FlutterwaveCreateOrderRequest = Schemas['order_in'];
export type FlutterwaveUpdateOrderRequest = Schemas['order_update_in'];
export type FlutterwaveDirectChargeRequest = Schemas['direct_charge_in'];
export type FlutterwaveDirectOrderRequest = Schemas['direct_order_in'];
export type FlutterwaveCreateRefundRequest = Schemas['refund_in'];
export type FlutterwavePaymentMethodRequest = Schemas['payment_method_in'];
export type FlutterwaveChargeAuthorization = Schemas['authorization_in'];
export type FlutterwaveCustomerInput = Schemas['customer_in'];

/* Webhooks */

export interface FlutterwaveWebhookEnvelope<T = unknown> {
  /** Webhook id, e.g. `wbk_...`. The spec calls it `webhook_id`, the docs `id`. */
  id?: string;
  webhook_id?: string;
  /** Epoch milliseconds. */
  timestamp: number;
  type: string;
  data: T;
}

export type FlutterwaveChargeCompletedEventData = NonNullable<
  Schemas['charge_completed_webhook_payload']['data']
>;

export type FlutterwaveOrderAuthorizationEventData = NonNullable<
  Schemas['order_authorization_webhook_payload']['data']
>;

export type FlutterwaveRefundCompletedEventData = NonNullable<
  Schemas['refund_completed_webhook_payload']['data']
>;

export type FlutterwaveTransferDisburseEventData = NonNullable<
  Schemas['transfer_disburse_webhook_payload']['data']
>;

export type FlutterwaveTransferReversalEventData = NonNullable<
  Schemas['transfer_reversal_webhook_payload']['data']
>;

export interface FlutterwaveEventPayloadMap {
  'charge.completed': FlutterwaveChargeCompletedEventData;
  'order.authorization': FlutterwaveOrderAuthorizationEventData;
  'refund.completed': FlutterwaveRefundCompletedEventData;
  'transfer.disburse': FlutterwaveTransferDisburseEventData;
  'transfer.reversal': FlutterwaveTransferReversalEventData;
}
