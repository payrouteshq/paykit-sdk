import {
  AbstractPayKitProvider,
  CapturePaymentSchema,
  Checkout,
  ConfigurationError,
  CreateCheckoutSchema,
  CreateCustomerParams,
  CreatePaymentSchema,
  CreateRefundSchema,
  CreateSubscriptionSchema,
  Customer,
  HTTPClient,
  OperationFailedError,
  PayKitProvider,
  PaykitProviderOptions,
  Payment,
  ProviderMetadataRegistry,
  ProviderNotSupportedError,
  Refund,
  Subscription,
  UpdateCheckoutSchema,
  UpdateCustomerParams,
  UpdatePaymentSchema,
  UpdateSubscriptionSchema,
  WebhookEventPayload,
  WebhookHandlerConfig,
  hashWebhookPayload,
  parseCustomerName,
  paykitEvent$InboundSchema,
} from '@paykit-sdk/core';
import * as crypto from 'crypto';
import { z } from 'zod';
import {
  LemonSqueezyCheckout,
  LemonSqueezyCustomer,
  LemonSqueezyOrder,
  LemonSqueezyResponse,
  LemonSqueezySubscription,
  LemonSqueezyWebhookEvent,
} from './schema';
import {
  Checkout$inboundSchema,
  Customer$inboundSchema,
  Payment$inboundSchema,
  Subscription$inboundSchema,
  Refund$inboundSchema,
} from './utils/mapper';

export interface LemonSqueezyOptions extends PaykitProviderOptions {
  apiKey: string;
}

const optionsSchema = z.object({
  apiKey: z.string().min(1, 'API key is required'),
});

export class LemonSqueezyProvider
  extends AbstractPayKitProvider
  implements PayKitProvider
{
  readonly providerName = 'lemonsqueezy';
  readonly isSandbox = false; // LemonSqueezy has test mode per request/store, not globally on the key like Stripe

  private readonly _client: HTTPClient;
  readonly _native: HTTPClient;

  constructor(options: LemonSqueezyOptions) {
    super(optionsSchema, options, 'lemonsqueezy');

    this._client = new HTTPClient({
      baseUrl: 'https://api.lemonsqueezy.com/v1',
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
      retryOptions: { max: 3, baseDelay: 1000, debug: false },
    });
    this._native = this._client;
  }

  private _throwIfFailed<T>(
    result: {
      ok: boolean;
      value?: LemonSqueezyResponse<T>;
      error?: unknown;
    },
    operation: string,
  ): T {
    if (!result.ok || !result.value?.data) {
      throw new OperationFailedError(operation, this.providerName, {
        cause: new Error(
          result.error
            ? JSON.stringify(result.error)
            : 'Unknown LemonSqueezy error',
        ),
      });
    }
    return result.value.data;
  }

  // --- Checkout ---

  async createCheckout(
    params: CreateCheckoutSchema<
      ProviderMetadataRegistry['checkout']
    >,
  ): Promise<Checkout> {
    const payload = {
      data: {
        type: 'checkouts',
        attributes: {
          custom_price: params.provider_metadata?.custom_price,
          checkout_data: {
            email:
              params.customer && 'email' in params.customer
                ? params.customer.email
                : undefined,
            custom: params.metadata,
          },
        },
        relationships: {
          store: {
            data: {
              type: 'stores',
              id: String(params.provider_metadata?.store_id),
            },
          },
          variant: {
            data: {
              type: 'variants',
              id: String(params.provider_metadata?.variant_id),
            },
          },
        },
      },
    };

    const response = await this._client.post<
      LemonSqueezyResponse<LemonSqueezyCheckout>
    >('/checkouts', { body: JSON.stringify(payload) });

    const checkoutData = this._throwIfFailed<LemonSqueezyCheckout>(
      response,
      'createCheckout',
    );
    return Checkout$inboundSchema(checkoutData);
  }

  async retrieveCheckout(id: string): Promise<Checkout | null> {
    const response = await this._client.get<
      LemonSqueezyResponse<LemonSqueezyCheckout>
    >(`/checkouts/${id}`);
    if (!response.ok) return null;
    return Checkout$inboundSchema(response.value!.data);
  }

  async updateCheckout(
    id: string,
    params: UpdateCheckoutSchema,
  ): Promise<Checkout> {
    throw new Error(
      'updateCheckout not natively supported by LemonSqueezy API',
    );
  }

  async deleteCheckout(id: string): Promise<null> {
    throw new ProviderNotSupportedError(
      'deleteCheckout',
      this.providerName,
      {
        reason:
          'deleteCheckout not natively supported by LemonSqueezy API',
      },
    );
  }

  // --- Customer ---

  async createCustomer(
    params: CreateCustomerParams<
      ProviderMetadataRegistry['customer']
    >,
  ): Promise<Customer> {
    const payload = {
      data: {
        type: 'customers',
        attributes: {
          name: parseCustomerName(params).fullName,
          email: params.email,
        },
        relationships: {
          store: {
            data: {
              type: 'stores',
              id: String(params.provider_metadata?.store_id),
            },
          },
        },
      },
    };

    const response = await this._client.post<
      LemonSqueezyResponse<LemonSqueezyCustomer>
    >('/customers', { body: JSON.stringify(payload) });
    const customerData = this._throwIfFailed<LemonSqueezyCustomer>(
      response,
      'createCustomer',
    );
    return Customer$inboundSchema(customerData);
  }

  async retrieveCustomer(id: string): Promise<Customer | null> {
    const response = await this._client.get<
      LemonSqueezyResponse<LemonSqueezyCustomer>
    >(`/customers/${id}`);
    if (!response.ok) return null;
    return Customer$inboundSchema(response.value!.data);
  }

  async updateCustomer(
    id: string,
    params: UpdateCustomerParams,
  ): Promise<Customer> {
    const payload = {
      data: {
        type: 'customers',
        id,
        attributes: {
          name: params.name,
          email: params.email,
        },
      },
    };

    const response = await this._client.patch<
      LemonSqueezyResponse<LemonSqueezyCustomer>
    >(`/customers/${id}`, { body: JSON.stringify(payload) });
    const customerData = this._throwIfFailed<LemonSqueezyCustomer>(
      response,
      'updateCustomer',
    );
    return Customer$inboundSchema(customerData);
  }

  async deleteCustomer(id: string): Promise<null> {
    throw new ProviderNotSupportedError(
      'deleteCustomer',
      this.providerName,
      {
        reason:
          'deleteCustomer not natively supported by LemonSqueezy API',
      },
    );
  }

  // --- Subscription ---

  async createSubscription(
    params: CreateSubscriptionSchema<
      ProviderMetadataRegistry['subscription']
    >,
  ): Promise<Subscription> {
    // Usually created via Checkout in LemonSqueezy
    throw new ProviderNotSupportedError(
      'createSubscription',
      this.providerName,
      {
        reason:
          'createSubscription is generally handled via Checkout in LemonSqueezy',
      },
    );
  }

  async retrieveSubscription(
    id: string,
  ): Promise<Subscription | null> {
    const response = await this._client.get<
      LemonSqueezyResponse<LemonSqueezySubscription>
    >(`/subscriptions/${id}`);
    if (!response.ok) return null;
    return Subscription$inboundSchema(response.value!.data);
  }

  async updateSubscription(
    id: string,
    params: UpdateSubscriptionSchema,
  ): Promise<Subscription> {
    const payload = {
      data: {
        type: 'subscriptions',
        id,
        attributes: {
          variant_id: params.provider_metadata?.variant_id,
        },
      },
    };
    const response = await this._client.patch<
      LemonSqueezyResponse<LemonSqueezySubscription>
    >(`/subscriptions/${id}`, { body: JSON.stringify(payload) });
    const subData = this._throwIfFailed<LemonSqueezySubscription>(
      response,
      'updateSubscription',
    );
    return Subscription$inboundSchema(subData);
  }

  async cancelSubscription(id: string): Promise<Subscription> {
    const response = await this._client.delete<
      LemonSqueezyResponse<LemonSqueezySubscription>
    >(`/subscriptions/${id}`);
    const subData = this._throwIfFailed<LemonSqueezySubscription>(
      response,
      'cancelSubscription',
    );
    return Subscription$inboundSchema(subData);
  }

  async deleteSubscription(id: string): Promise<null> {
    await this.cancelSubscription(id);
    return null;
  }

  // --- Payment (Order) ---

  async createPayment(
    params: CreatePaymentSchema<ProviderMetadataRegistry['payment']>,
  ): Promise<Payment> {
    throw new ProviderNotSupportedError(
      'createPayment',
      this.providerName,
      {
        reason:
          'createPayment directly is not supported. Use createCheckout for LemonSqueezy',
      },
    );
  }

  async retrievePayment(id: string): Promise<Payment | null> {
    const response = await this._client.get<
      LemonSqueezyResponse<LemonSqueezyOrder>
    >(`/orders/${id}`);
    if (!response.ok) return null;
    return Payment$inboundSchema(response.value!.data);
  }

  async updatePayment(
    id: string,
    params: UpdatePaymentSchema,
  ): Promise<Payment> {
    throw new ProviderNotSupportedError(
      'updatePayment',
      this.providerName,
    );
  }

  async deletePayment(id: string): Promise<null> {
    throw new ProviderNotSupportedError(
      'deletePayment',
      this.providerName,
    );
  }

  async capturePayment(
    id: string,
    params: CapturePaymentSchema,
  ): Promise<Payment> {
    throw new ProviderNotSupportedError(
      'capturePayment',
      this.providerName,
    );
  }

  async cancelPayment(id: string): Promise<Payment> {
    throw new ProviderNotSupportedError(
      'cancelPayment',
      this.providerName,
    );
  }

  // --- Refund ---

  async createRefund(params: CreateRefundSchema): Promise<Refund> {
    const payload: {
      data: {
        type: string;
        id: string;
        attributes?: { amount: number };
      };
    } = {
      data: {
        type: 'orders',
        id: params.payment_id,
      },
    };

    if (params.amount) {
      payload.data.attributes = {
        amount: params.amount,
      };
    }

    const response = await this._client.post<
      LemonSqueezyResponse<LemonSqueezyOrder>
    >(`/orders/${params.payment_id}/refund`, {
      body: JSON.stringify(payload),
    });

    const orderData = this._throwIfFailed<LemonSqueezyOrder>(
      response,
      'createRefund',
    );
    return Refund$inboundSchema(orderData);
  }

  // --- Webhooks ---

  async handleWebhook(
    payload: WebhookHandlerConfig,
    webhookSecret: string | null,
  ): Promise<Array<WebhookEventPayload>> {
    if (!webhookSecret) {
      throw new ConfigurationError(
        'Webhook secret is required for LemonSqueezy',
      );
    }

    const signature = payload.headersAsObject['x-signature'];
    if (!signature) {
      throw new OperationFailedError(
        'handleWebhook',
        this.providerName,
        {
          cause: new Error('Missing x-signature header'),
        },
      );
    }

    const hmac = crypto.createHmac('sha256', webhookSecret);
    const digest = Buffer.from(
      hmac.update(payload.body).digest('hex'),
      'utf8',
    );
    const signatureBuffer = Buffer.from(
      Array.isArray(signature) ? signature[0] : signature,
      'utf8',
    );

    if (
      digest.length !== signatureBuffer.length ||
      !crypto.timingSafeEqual(digest, signatureBuffer)
    ) {
      throw new OperationFailedError(
        'handleWebhook',
        this.providerName,
        {
          cause: new Error('Invalid webhook signature'),
        },
      );
    }

    const event = JSON.parse(
      payload.body,
    ) as LemonSqueezyWebhookEvent;

    const results: Array<WebhookEventPayload> = [];

    const contentHash = hashWebhookPayload(
      event.meta.event_name,
      payload.body,
    );

    results.push({
      id: `lemonsqueezy:${event.meta.event_name}:${contentHash}`,
      type: `lemonsqueezy.${event.meta.event_name}`,
      created: Math.floor(Date.now() / 1000),
      data: event.data,
      is_raw: true,
    } as WebhookEventPayload);

    const standardEvents = this.mapToStandardEvents(
      event,
      contentHash,
    );
    if (standardEvents) results.push(...standardEvents);

    return results;
  }

  private mapToStandardEvents(
    event: LemonSqueezyWebhookEvent,
    contentHash: string,
  ): Array<WebhookEventPayload> | null {
    const created = Math.floor(Date.now() / 1000);
    const id = `paykit:${event.meta.event_name}:${contentHash}`;

    switch (event.meta.event_name) {
      case 'order_created': {
        const order = Payment$inboundSchema(
          event.data as LemonSqueezyOrder,
        );
        return [
          paykitEvent$InboundSchema({
            type: 'payment.updated',
            created,
            id,
            data: order,
          }),
        ];
      }
      case 'subscription_created':
      case 'subscription_updated':
      case 'subscription_cancelled': {
        const sub = Subscription$inboundSchema(
          event.data as LemonSqueezySubscription,
        );
        const action = event.meta.event_name.split('_')[1];
        const paykitType =
          `subscription.${action === 'cancelled' ? 'canceled' : action}` as const;

        return [
          paykitEvent$InboundSchema({
            type: paykitType as
              | 'subscription.created'
              | 'subscription.updated'
              | 'subscription.canceled',
            created,
            id,
            data: sub,
          }),
        ];
      }
      default:
        return null;
    }
  }
}
