import {
  AbstractPayKitProvider,
  Checkout,
  createCheckoutSchema,
  CreateCheckoutSchema,
  createCustomerSchema,
  CreateCustomerParams,
  Customer,
  HTTPClient,
  NotImplementedError,
  PayKitProvider,
  PaykitProviderOptions,
  ProviderMetadataRegistry,
  ProviderNotSupportedError,
  retrieveCheckoutSchema,
  schema,
  UpdateCheckoutSchema,
  UpdateCustomerParams,
  ValidationError,
  WebhookEventPayload,
  WebhookHandlerConfig,
} from '@paykit-sdk/core';
import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';

interface LemonSqueezyMetadata extends ProviderMetadataRegistry {}

type LemonSqueezyRawEvents = {
  [K in string as `lemonsqueezy.${K}`]: any;
};

export interface LemonSqueezyOptions extends PaykitProviderOptions {
  /** Lemon Squeezy API key (Settings > API) */
  apiKey: string;
  /** Signing secret set when creating the webhook */
  webhookSecret?: string;
  /** Your Lemon Squeezy store ID, required on checkout creation */
  storeId: string;
}

const lemonSqueezyOptionsSchema = schema<LemonSqueezyOptions>()(
  z.object({
    apiKey: z.string().min(1, 'API key is required'),
    webhookSecret: z.string().optional(),
    storeId: z.string().min(1, 'Store ID is required'),
    isSandbox: z.boolean(),
  }),
);

const providerName = 'lemonsqueezy';

export class LemonSqueezyProvider
  extends AbstractPayKitProvider
  implements PayKitProvider<LemonSqueezyMetadata, any, LemonSqueezyRawEvents>
{
  private _client: HTTPClient;
  readonly providerName = providerName;
  readonly isSandbox: boolean;

  constructor(protected readonly opts: LemonSqueezyOptions) {
    super(lemonSqueezyOptionsSchema, opts, providerName);

    this.isSandbox = opts.isSandbox;

    this._client = new HTTPClient({
      baseUrl: 'https://api.lemonsqueezy.com/v1',
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        Accept: 'application/vnd.api+json',
        'Content-Type': 'application/vnd.api+json',
      },
      retryOptions: { max: 3, baseDelay: 1000, debug: opts.debug ?? true },
    });
  }

  get _native() {
    return this._client;
  }

  private _ni(m: string): Promise<never> {
    return Promise.reject(new NotImplementedError(m, this.providerName, { futureSupport: true }));
  }
  private _ns(m: string, r: string): Promise<never> {
    return Promise.reject(new ProviderNotSupportedError(m, this.providerName, { reason: r }));
  }

  createCheckout = async (
    params: CreateCheckoutSchema<LemonSqueezyMetadata['checkout']>,
  ): Promise<Checkout> => {
    const { error, data } = createCheckoutSchema.safeParse(params);
    if (error) throw ValidationError.fromZodError(error, this.providerName, 'createCheckout');

    // Lemon Squeezy uses JSON:API — checkout requires the variant + store relationships
    const body = {
      data: {
        type: 'checkouts',
        attributes: {
          checkout_data: { email: data.customer, custom: data.metadata },
        },
        relationships: {
          store: { data: { type: 'stores', id: this.opts.storeId } },
          variant: { data: { type: 'variants', id: data.metadata?.variantId } },
        },
      },
    };

    const res = await this._client.post<Record<string, unknown>>('/checkouts', {
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Failed to create Lemon Squeezy checkout');
    return res.value as unknown as Checkout;
  };

  retrieveCheckout = async (id: string): Promise<Checkout> => {
    const { error } = retrieveCheckoutSchema.safeParse({ id });
    if (error) throw ValidationError.fromZodError(error, this.providerName, 'retrieveCheckout');

    const res = await this._client.get<Record<string, unknown>>(`/checkouts/${id}`);
    if (!res.ok) throw new Error('Failed to retrieve Lemon Squeezy checkout');
    return res.value as unknown as Checkout;
  };

  updateCheckout = (id: string, params: UpdateCheckoutSchema): Promise<Checkout> =>
    this._ns('updateCheckout', 'Lemon Squeezy checkouts cannot be updated once created.');

  deleteCheckout = (id: string): Promise<null> => this._ni('deleteCheckout');

  createCustomer = async (
    params: CreateCustomerParams<LemonSqueezyMetadata['customer']>,
  ): Promise<Customer> => {
    const { error, data } = createCustomerSchema.safeParse(params);
    if (error) throw ValidationError.fromZodError(error, this.providerName, 'createCustomer');

    const body = {
      data: {
        type: 'customers',
        attributes: { email: data.email, name: data.name },
        relationships: { store: { data: { type: 'stores', id: this.opts.storeId } } },
      },
    };

    const res = await this._client.post<Record<string, unknown>>('/customers', {
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error('Failed to create Lemon Squeezy customer');
    return res.value as unknown as Customer;
  };

  retrieveCustomer = async (id: string): Promise<Customer> => {
    const res = await this._client.get<Record<string, unknown>>(`/customers/${id}`);
    if (!res.ok) throw new Error('Failed to retrieve Lemon Squeezy customer');
    return res.value as unknown as Customer;
  };

  updateCustomer = (id: string, params: UpdateCustomerParams): Promise<Customer> =>
    this._ni('updateCustomer');
  deleteCustomer = (id: string): Promise<null> => this._ni('deleteCustomer');

  // Lemon Squeezy has no standalone Payment resource distinct from Orders — flag it honestly
  createPayment = () => this._ns('createPayment', 'Use createCheckout; Lemon Squeezy settles via checkout + order webhooks.');
  retrievePayment = () => this._ni('retrievePayment');
  updatePayment = () => this._ni('updatePayment');
  deletePayment = () => this._ni('deletePayment');
  capturePayment = () => this._ni('capturePayment');
  cancelPayment = () => this._ni('cancelPayment');

  createSubscription = () => this._ni('createSubscription');
  retrieveSubscription = async (id: string) => {
    const res = await this._client.get<Record<string, unknown>>(`/subscriptions/${id}`);
    if (!res.ok) throw new Error('Failed to retrieve subscription');
    return res.value as any;
  };
  updateSubscription = () => this._ni('updateSubscription');
  deleteSubscription = () => this._ni('deleteSubscription');
  cancelSubscription = async (id: string) => {
    const res = await this._client.delete<Record<string, unknown>>(`/subscriptions/${id}`);
    if (!res.ok) throw new Error('Failed to cancel subscription');
    return res.value as any;
  };

  createRefund = () => this._ni('createRefund');

  /**
   * Lemon Squeezy signs webhooks with HMAC-SHA256 over the raw body,
   * sent in the X-Signature header. Verified against their own docs:
   * https://docs.lemonsqueezy.com/help/webhooks/signing-requests
   */
  handleWebhook = async (
    payload: WebhookHandlerConfig,
    webhookSecret: string | null,
  ): Promise<Array<WebhookEventPayload<LemonSqueezyRawEvents>>> => {
    const { headersAsObject, rawBody } = payload;
    const secret = webhookSecret ?? this.opts.webhookSecret;
    if (!secret) throw new Error('Webhook secret is required');

    const headers = new Headers(headersAsObject);
    const signature = headers.get('X-Signature');
    if (!signature || !rawBody) throw new Error('Missing signature or body');

    const expected = createHmac('sha256', secret).update(rawBody).digest('hex');
    const sigBuf = Buffer.from(signature, 'hex');
    const expBuf = Buffer.from(expected, 'hex');

    if (sigBuf.length !== expBuf.length || !timingSafeEqual(sigBuf, expBuf)) {
      throw new Error('Invalid Lemon Squeezy webhook signature');
    }

    const event = JSON.parse(rawBody.toString());
    const eventName = event.meta?.event_name ?? 'unknown';

    return [
      {
        id: event.data?.id,
        type: `lemonsqueezy.${eventName}` as any,
        data: event.data,
      },
    ];
  };
}