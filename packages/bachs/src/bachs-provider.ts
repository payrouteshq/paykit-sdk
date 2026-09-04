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
  isIdCustomer,
  OperationFailedError,
  parseCustomerName,
  PayKitProvider,
  PaykitProviderOptions,
  Payment,
  Payee,
  paykitEvent$InboundSchema,
  ProviderMetadataRegistry,
  ProviderNotSupportedError,
  Refund,
  ResourceNotFoundError,
  Schema,
  Subscription,
  UpdateCheckoutSchema,
  UpdateCustomerParams,
  UpdatePaymentSchema,
  UpdateSubscriptionSchema,
  ValidationError,
  WebhookError,
  WebhookEventPayload,
  WebhookHandlerConfig,
  createCheckoutSchema,
  createCustomerSchema,
  createPaymentSchema,
  createRefundSchema,
  hashWebhookPayload,
  schema,
  stringifyMetadataValues,
  validateRequiredKeys,
} from '@paykit-sdk/core';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  BachsCancelSubscriptionRequest,
  BachsCheckoutSessionApiResponse,
  BachsCollectionFailedEventData,
  BachsCollectionSucceededEventData,
  BachsCollectionUnderpaidEventData,
  BachsCreateCheckoutSessionRequest,
  BachsCreateCheckoutSessionResponse,
  BachsCreateCustomerRequest,
  BachsCreateRefundRequest,
  BachsCustomerDetailResponse,
  BachsCustomerEventData,
  BachsEventPayloadMap,
  BachsPaymentResponse,
  BachsProductItemRequest,
  BachsRefundEventData,
  BachsRefundResponse,
  BachsSubscriptionEventData,
  BachsSubscriptionResponse,
  BachsUpdateCustomerRequest,
  BachsUpdateSubscriptionRequest,
  BachsWebhookEnvelope,
} from './schema';
import {
  Checkout$fromSession,
  Customer$inboundSchema,
  Payment$fromSession,
  Refund$inboundSchema,
  Subscription$inboundSchema,
} from './utils/mapper';

interface BachsCheckoutMetadata {
  billing_currency?: string;
  allowed_payment_method_types?: Array<
    'card' | 'crypto' | 'bank_transfer' | 'mobile_money'
  >;
  reference?: string;
  expires_in_minutes?: number;
  idempotencyKey?: string;
}

interface BachsPaymentMetadata extends BachsCheckoutMetadata {
  success_url?: string;
  cancel_url?: string;
}

interface BachsCustomerMetadata {
  idempotencyKey?: string;
}

interface BachsRefundMetadata {
  fee_bearer?: 'org' | 'customer';
  refund_address?: string;
  idempotencyKey?: string;
}

interface BachsSubscriptionMetadata {
  product_id?: string;
  trial_end?: string;
  payment_method_id?: string;
  proration_behavior?: 'invoice_now' | 'next_cycle' | 'none';
}

interface BachsMetadata extends ProviderMetadataRegistry {
  checkout: BachsCheckoutMetadata;
  customer: BachsCustomerMetadata;
  payment: BachsPaymentMetadata;
  refund: BachsRefundMetadata;
  subscription: BachsSubscriptionMetadata;
}

type PayKitBachsRawEvents = {
  [K in keyof BachsEventPayloadMap as `bachs.${K}`]: BachsEventPayloadMap[K];
} & Record<string, any>;

export interface BachsOptions extends PaykitProviderOptions {
  /** Secret key issued by Bachs: `sk_sandbox_...` or `sk_live_...`. */
  apiKey: string;
}

const bachsOptionsSchema = schema<BachsOptions>()(
  Schema.object({
    apiKey: Schema.string(),
    isSandbox: Schema.boolean(),
    debug: Schema.boolean().optional(),
  }),
);

const providerName = 'bachs';

const SANDBOX_BASE_URL = 'https://sandbox-api.bachs.io';
const PRODUCTION_BASE_URL = 'https://api.bachs.io';

const WEBHOOK_TOLERANCE_SECONDS = 300;

export class BachsProvider
  extends AbstractPayKitProvider
  implements
    PayKitProvider<BachsMetadata, HTTPClient, PayKitBachsRawEvents>
{
  readonly providerName = providerName;
  readonly isSandbox: boolean;
  private readonly _client: HTTPClient;

  get _native(): HTTPClient {
    return this._client;
  }

  constructor(private readonly opts: BachsOptions) {
    super(bachsOptionsSchema, opts, providerName);

    this.isSandbox = opts.apiKey.startsWith('sk_sandbox_')
      ? true
      : opts.apiKey.startsWith('sk_live_')
        ? false
        : opts.isSandbox;

    this._client = new HTTPClient({
      baseUrl: this.isSandbox
        ? SANDBOX_BASE_URL
        : PRODUCTION_BASE_URL,
      headers: {
        Authorization: `Bearer ${opts.apiKey}`,
        'Content-Type': 'application/json',
      },
      retryOptions: {
        max: 3,
        baseDelay: 1000,
        debug: opts.debug ?? false,
      },
    });
  }

  private idempotencyHeaders(key?: string): Record<string, string> {
    return { 'Idempotency-Key': key ?? crypto.randomUUID() };
  }

  private async unwrap<T>(
    result: { ok: boolean; value?: T; error?: unknown },
    operation: string,
  ): Promise<T> {
    if (
      !result.ok ||
      result.value === undefined ||
      result.value === null
    ) {
      throw new OperationFailedError(operation, this.providerName, {
        cause: new Error(
          JSON.stringify(
            result.error ?? result.value ?? 'Unknown error',
          ),
        ),
      });
    }

    return result.value;
  }

  private toCustomerRequest(
    customer: Payee,
  ): { customer_id: string } | { email: string; name: string } {
    if (isIdCustomer(customer)) {
      return { customer_id: String(customer.id) };
    }

    const email = (customer as { email: string }).email;

    return {
      email,
      name: parseCustomerName({ email }).fullName,
    };
  }

  private getCheckoutSession = async (
    id: string,
  ): Promise<BachsCheckoutSessionApiResponse | null> => {
    const response =
      await this._client.get<BachsCheckoutSessionApiResponse>(
        `/v1/checkout-sessions/${encodeURIComponent(id)}`,
      );

    if (!response.ok || !response.value) return null;

    return response.value;
  };

  /**
   * The one place a checkout session is created. Shared by
   * createCheckout and createPayment - the only difference between
   * them is input validation and the response mapper. Bachs resolves
   * pricing from the product server-side and doesn't echo it back on
   * creation, so this always re-fetches the session immediately after
   * to get the resolved amount/currency/products for the return value.
   */
  private runCheckoutFlow = async (input: {
    customer: Payee;
    productCart: BachsProductItemRequest[];
    successUrl: string;
    cancelUrl?: string;
    metadata: Record<string, string> | null;
    pm?: BachsCheckoutMetadata;
    operation: string;
  }): Promise<{
    create: BachsCreateCheckoutSessionResponse;
    session: BachsCheckoutSessionApiResponse;
  }> => {
    const body: BachsCreateCheckoutSessionRequest = {
      customer: this.toCustomerRequest(input.customer),
      product_cart: input.productCart,
      success_url: input.successUrl,
      ...(input.cancelUrl && { cancel_url: input.cancelUrl }),
      ...(input.metadata && { metadata: input.metadata }),
      ...(input.pm?.billing_currency && {
        billing_currency: input.pm.billing_currency,
      }),
      ...(input.pm?.allowed_payment_method_types && {
        allowed_payment_method_types:
          input.pm.allowed_payment_method_types,
      }),
      ...(input.pm?.reference && { reference: input.pm.reference }),
      ...(input.pm?.expires_in_minutes && {
        expires_in_minutes: input.pm.expires_in_minutes,
      }),
    };

    const response =
      await this._client.post<BachsCreateCheckoutSessionResponse>(
        '/v1/checkout-sessions',
        {
          body: JSON.stringify(body),
          headers: this.idempotencyHeaders(input.pm?.idempotencyKey),
        },
      );

    const create = await this.unwrap(response, input.operation);
    const session = await this.getCheckoutSession(create.checkout_id);

    if (!session) {
      throw new OperationFailedError(
        input.operation,
        this.providerName,
        {
          cause: new Error(
            'Checkout session was created but could not be retrieved',
          ),
        },
      );
    }

    return { create, session };
  };

  createCheckout = async (
    params: CreateCheckoutSchema<BachsMetadata['checkout']>,
  ): Promise<Checkout> => {
    const { error, data } = createCheckoutSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createCheckout',
      );
    }

    const pm = data.provider_metadata as
      | BachsCheckoutMetadata
      | undefined;

    const { create, session } = await this.runCheckoutFlow({
      customer: data.customer,
      productCart: [
        { product_id: data.item_id, quantity: data.quantity },
      ],
      successUrl: data.success_url,
      cancelUrl: data.cancel_url ?? undefined,
      metadata: data.metadata
        ? (stringifyMetadataValues(data.metadata) as Record<
            string,
            string
          >)
        : null,
      pm,
      operation: 'createCheckout',
    });

    return {
      ...Checkout$fromSession(session),
      payment_url: create.checkout_url,
      session_type: data.session_type,
    };
  };

  retrieveCheckout = async (id: string): Promise<Checkout | null> => {
    const session = await this.getCheckoutSession(id);

    if (!session) return null;

    return Checkout$fromSession(session);
  };

  updateCheckout = async (
    _id: string,
    _params: UpdateCheckoutSchema<BachsMetadata['checkout']>,
  ): Promise<Checkout> => {
    throw new ProviderNotSupportedError('updateCheckout', 'Bachs', {
      reason:
        'Bachs has no endpoint to amend a checkout session after creation.',
      alternative: 'Create a new checkout session instead.',
    });
  };

  deleteCheckout = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deleteCheckout', 'Bachs', {
      reason:
        'Bachs has no endpoint to delete or void a checkout session.',
      alternative:
        'Let it expire, or ignore it - unpaid sessions expire on their own.',
    });
  };

  createCustomer = async (
    params: CreateCustomerParams<BachsMetadata['customer']>,
  ): Promise<Customer> => {
    const { error, data } = createCustomerSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createCustomer',
      );
    }

    const { idempotencyKey, ...restProviderMetadata } =
      (data.provider_metadata ?? {}) as BachsCustomerMetadata &
        Record<string, unknown>;

    const body: BachsCreateCustomerRequest = {
      email: data.email,
      ...(data.name && { name: data.name }),
      ...(data.phone && { phone_number: data.phone }),
      ...(data.metadata && {
        metadata: stringifyMetadataValues(data.metadata),
      }),
      ...restProviderMetadata,
    };

    const response =
      await this._client.post<BachsCustomerDetailResponse>(
        '/v1/customers',
        {
          body: JSON.stringify(body),
          headers: this.idempotencyHeaders(idempotencyKey),
        },
      );

    const customer = await this.unwrap(response, 'createCustomer');

    return Customer$inboundSchema(customer);
  };

  retrieveCustomer = async (id: string): Promise<Customer | null> => {
    const response =
      await this._client.get<BachsCustomerDetailResponse>(
        `/v1/customers/${encodeURIComponent(id)}`,
      );

    if (!response.ok || !response.value) return null;

    return Customer$inboundSchema(response.value);
  };

  updateCustomer = async (
    id: string,
    params: UpdateCustomerParams<BachsMetadata['customer']>,
  ): Promise<Customer> => {
    const body: BachsUpdateCustomerRequest = {
      ...(params.email && { email: params.email }),
      ...(params.name && { name: params.name }),
      ...(params.phone && { phone_number: params.phone }),
      ...(params.metadata && {
        metadata: stringifyMetadataValues(params.metadata),
      }),
      ...params.provider_metadata,
    };

    const response =
      await this._client.patch<BachsCustomerDetailResponse>(
        `/v1/customers/${encodeURIComponent(id)}`,
        { body: JSON.stringify(body) },
      );

    const customer = await this.unwrap(response, 'updateCustomer');

    return Customer$inboundSchema(customer);
  };

  deleteCustomer = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deleteCustomer', 'Bachs', {
      reason: 'Bachs has no endpoint to delete customers.',
    });
  };

  createSubscription = async (
    _params: CreateSubscriptionSchema<BachsMetadata['subscription']>,
  ): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'createSubscription',
      'Bachs',
      {
        reason:
          'Bachs has no direct create-subscription endpoint - a subscription is created automatically when a checkout for a product configured with a billing_cycle completes.',
        alternative:
          'Use createCheckout() with a recurring-configured product_id, then listen for the customer.subscription.created webhook.',
      },
    );
  };

  retrieveSubscription = async (
    id: string,
  ): Promise<Subscription | null> => {
    const response =
      await this._client.get<BachsSubscriptionResponse>(
        `/v1/subscriptions/${encodeURIComponent(id)}`,
      );

    if (!response.ok || !response.value) return null;

    return Subscription$inboundSchema(response.value);
  };

  updateSubscription = async (
    id: string,
    params: UpdateSubscriptionSchema<BachsMetadata['subscription']>,
  ): Promise<Subscription> => {
    const pm = (params.provider_metadata ??
      {}) as BachsSubscriptionMetadata;

    const body: BachsUpdateSubscriptionRequest = {
      ...(pm.product_id && { product_id: pm.product_id }),
      ...(pm.trial_end && { trial_end: pm.trial_end }),
      ...(pm.payment_method_id && {
        payment_method_id: pm.payment_method_id,
      }),
      ...(pm.proration_behavior && {
        proration_behavior: pm.proration_behavior,
      }),
    };

    const response =
      await this._client.patch<BachsSubscriptionResponse>(
        `/v1/subscriptions/${encodeURIComponent(id)}`,
        { body: JSON.stringify(body) },
      );

    const subscription = await this.unwrap(
      response,
      'updateSubscription',
    );

    return Subscription$inboundSchema(subscription);
  };

  /**
   * Cancels immediately (`cancel_at_period_end: false`). PayKit's
   * cancelSubscription(id) takes no params to route
   * cancel_at_period_end/reason through - use updateSubscription's
   * provider_metadata beforehand if you need a period-end cancellation.
   */
  cancelSubscription = async (id: string): Promise<Subscription> => {
    const body: BachsCancelSubscriptionRequest = {
      cancel_at_period_end: false,
    };

    const response =
      await this._client.delete<BachsSubscriptionResponse>(
        `/v1/subscriptions/${encodeURIComponent(id)}`,
        { body: JSON.stringify(body) },
      );

    const subscription = await this.unwrap(
      response,
      'cancelSubscription',
    );

    return Subscription$inboundSchema(subscription);
  };

  deleteSubscription = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deleteSubscription',
      'Bachs',
      {
        reason:
          "Bachs' DELETE /v1/subscriptions/{id} cancels rather than erases a subscription.",
        alternative: 'Use cancelSubscription() instead.',
      },
    );
  };

  createPayment = async (
    params: CreatePaymentSchema<BachsMetadata['payment']>,
  ): Promise<Payment> => {
    const { error, data } = createPaymentSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createPayment',
      );
    }

    if (!data.item_id) {
      throw new ConfigurationError(
        'item_id is required for createPayment',
        {
          provider: this.providerName,
          missingKeys: ['item_id'],
        },
      );
    }

    if (!data.customer) {
      throw new ConfigurationError(
        'customer is required for createPayment',
        {
          provider: this.providerName,
          missingKeys: ['customer'],
        },
      );
    }

    const { success_url } = validateRequiredKeys(
      ['success_url'],
      (data.provider_metadata as Record<string, string>) ?? {},
      'The following fields must be present in the provider_metadata of createPayment: {keys}',
    );

    const pm = data.provider_metadata as
      | BachsPaymentMetadata
      | undefined;

    const { create, session } = await this.runCheckoutFlow({
      customer: data.customer,
      productCart: [{ product_id: data.item_id, quantity: 1 }],
      successUrl: success_url,
      cancelUrl: pm?.cancel_url,
      metadata: data.metadata
        ? (stringifyMetadataValues(data.metadata) as Record<
            string,
            string
          >)
        : null,
      pm,
      operation: 'createPayment',
    });

    return {
      ...Payment$fromSession(session),
      payment_url: create.checkout_url,
    };
  };

  retrievePayment = async (id: string): Promise<Payment | null> => {
    const session = await this.getCheckoutSession(id);

    if (!session) return null;

    return Payment$fromSession(session);
  };

  updatePayment = async (
    _id: string,
    _params: UpdatePaymentSchema<BachsMetadata['payment']>,
  ): Promise<Payment> => {
    throw new ProviderNotSupportedError('updatePayment', 'Bachs', {
      reason:
        'Bachs has no endpoint to amend a payment after creation.',
    });
  };

  deletePayment = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deletePayment', 'Bachs', {
      reason: 'Bachs has no endpoint to delete a payment.',
      alternative:
        'Use createRefund() once the payment has succeeded.',
    });
  };

  capturePayment = async (
    _id: string,
    _params: CapturePaymentSchema,
  ): Promise<Payment> => {
    throw new ProviderNotSupportedError('capturePayment', 'Bachs', {
      reason:
        'Bachs charges are captured automatically - there is no manual capture step.',
    });
  };

  cancelPayment = async (_id: string): Promise<Payment> => {
    throw new ProviderNotSupportedError('cancelPayment', 'Bachs', {
      reason:
        'Bachs has no endpoint to cancel an in-flight payment or checkout session.',
      alternative:
        'Let the checkout session expire, or refund it with createRefund() once paid.',
    });
  };

  createRefund = async (
    params: CreateRefundSchema<BachsMetadata['refund']>,
  ): Promise<Refund> => {
    const { error, data } = createRefundSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createRefund',
      );
    }

    // data.payment_id is a checkout_id (see retrievePayment) - Bachs'
    // refund API needs the underlying charge_id nested under it.
    const session = await this.getCheckoutSession(data.payment_id);

    if (!session || !session.charge) {
      throw new ResourceNotFoundError(
        'payment',
        data.payment_id,
        this.providerName,
      );
    }

    const pm = data.provider_metadata as
      | BachsRefundMetadata
      | undefined;

    // A caller-supplied idempotencyKey doubles as the reference too,
    // so a retried createRefund() call reuses the same value on both
    // and Bachs returns the original refund instead of creating a
    // second one. Without one, both fall back to a fresh random value
    // per call, same as before.
    const idempotencyKey = pm?.idempotencyKey ?? crypto.randomUUID();

    const body: BachsCreateRefundRequest = {
      charge_id: session.charge.payment_id,
      reference: idempotencyKey,
      idempotency_key: idempotencyKey,
      ...(data.amount && { amount: String(data.amount) }),
      ...(data.reason && { reason: data.reason }),
      ...(pm?.fee_bearer && { fee_bearer: pm.fee_bearer }),
      ...(pm?.refund_address && {
        refund_address: pm.refund_address,
      }),
    };

    const response = await this._client.post<BachsRefundResponse>(
      '/v1/refunds',
      {
        body: JSON.stringify(body),
        headers: this.idempotencyHeaders(idempotencyKey),
      },
    );

    const refund = await this.unwrap(response, 'createRefund');

    return Refund$inboundSchema(refund, session.charge.currency);
  };

  /**
   * Verifies `X-Bachs-Signature` (HMAC-SHA256 hex digest of
   * `"{timestamp}.{raw_body}"`) and `X-Bachs-Timestamp` against
   * webhookSecret, per Bachs' documented reference implementation.
   * Deliveries older than 300 seconds are rejected.
   */
  handleWebhook = async (
    payload: WebhookHandlerConfig,
    webhookSecret: string | null,
  ): Promise<Array<WebhookEventPayload<PayKitBachsRawEvents>>> => {
    if (!webhookSecret) {
      throw new WebhookError(
        'webhookSecret is required for Bachs webhook verification',
        {
          provider: this.providerName,
        },
      );
    }

    const { body, headersAsObject } = payload;

    const timestampHeader = headersAsObject['x-bachs-timestamp'];
    const signatureHeader = headersAsObject['x-bachs-signature'];

    if (!timestampHeader || !signatureHeader) {
      throw new WebhookError(
        'Missing X-Bachs-Timestamp or X-Bachs-Signature header',
        {
          provider: this.providerName,
        },
      );
    }

    const timestamp = parseInt(timestampHeader, 10);

    if (
      !Number.isFinite(timestamp) ||
      Math.abs(Date.now() / 1000 - timestamp) >
        WEBHOOK_TOLERANCE_SECONDS
    ) {
      throw new WebhookError(
        'Bachs webhook timestamp is stale or invalid',
        {
          provider: this.providerName,
        },
      );
    }

    const expectedSignature = createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${body}`)
      .digest('hex');

    const expectedBuf = Buffer.from(expectedSignature, 'hex');
    const receivedBuf = Buffer.from(signatureHeader, 'hex');

    if (
      expectedBuf.length !== receivedBuf.length ||
      !timingSafeEqual(expectedBuf, receivedBuf)
    ) {
      throw new WebhookError('Invalid Bachs webhook signature', {
        provider: this.providerName,
      });
    }

    let event: BachsWebhookEnvelope<unknown>;

    try {
      event = JSON.parse(body) as BachsWebhookEnvelope<unknown>;
    } catch {
      throw new WebhookError(
        'Invalid webhook payload: not valid JSON',
        {
          provider: this.providerName,
        },
      );
    }

    const results: Array<WebhookEventPayload<PayKitBachsRawEvents>> =
      [];

    const contentHash = hashWebhookPayload(event.type, body);

    results.push({
      id: `bachs:${event.type}:${contentHash}`,
      type: `bachs.${event.type}`,
      created: Math.floor(Date.now() / 1000),
      data: event.data as any,
      is_raw: true,
    });

    const standardEvents = await this.mapToStandardEvents(
      event,
      contentHash,
    );

    if (standardEvents) results.push(...standardEvents);

    return results;
  };

  private mapToStandardEvents = async (
    event: BachsWebhookEnvelope<unknown>,
    contentHash: string,
  ): Promise<Array<WebhookEventPayload> | null> => {
    const created = Math.floor(Date.now() / 1000);
    const id = `paykit:${event.type}:${contentHash}`;

    switch (event.type) {
      case 'collection.succeeded':
      case 'collection.failed':
      case 'collection.underpaid': {
        const data = event.data as
          | BachsCollectionSucceededEventData
          | BachsCollectionFailedEventData
          | BachsCollectionUnderpaidEventData;

        if (!data.checkout_id) return null;

        const payment = await this.retrievePayment(data.checkout_id);

        if (!payment) return null;

        const type =
          event.type === 'collection.succeeded'
            ? 'payment.succeeded'
            : event.type === 'collection.failed'
              ? 'payment.failed'
              : 'payment.updated';

        return [
          paykitEvent$InboundSchema({
            type,
            created,
            id,
            data: payment,
          }),
        ];
      }

      case 'refund.created':
      case 'refund.paid':
      case 'refund.failed': {
        const data = event.data as BachsRefundEventData;

        const chargeResponse =
          await this._client.get<BachsPaymentResponse>(
            `/v1/payments/${encodeURIComponent(data.charge_id)}`,
          );

        const currency =
          chargeResponse.ok && chargeResponse.value
            ? chargeResponse.value.currency
            : 'USD';

        const refund = Refund$inboundSchema(data, currency);

        return [
          paykitEvent$InboundSchema({
            type: 'refund.created',
            created,
            id,
            data: refund,
          }),
        ];
      }

      case 'customer.subscription.created':
      case 'customer.subscription.updated':
      case 'customer.subscription.deleted': {
        const data = event.data as BachsSubscriptionEventData;

        if (!data.subscription_id) return null;

        const subscription = await this.retrieveSubscription(
          data.subscription_id,
        );

        const type =
          event.type === 'customer.subscription.created'
            ? 'subscription.created'
            : event.type === 'customer.subscription.deleted'
              ? 'subscription.canceled'
              : 'subscription.updated';

        return [
          paykitEvent$InboundSchema({
            type,
            created,
            id,
            data: subscription,
          }),
        ];
      }

      case 'customer.created':
      case 'customer.updated': {
        const data = event.data as BachsCustomerEventData;

        if (!data.customer_id) return null;

        const customer = Customer$inboundSchema(data);

        return [
          paykitEvent$InboundSchema({
            type:
              event.type === 'customer.created'
                ? 'customer.created'
                : 'customer.updated',
            created,
            id,
            data: customer,
          }),
        ];
      }

      default:
        if (this.opts.debug) {
          console.info(
            `[Bachs] No standard mapping for event: ${event.type}. Available as raw event.`,
          );
        }
        return null;
    }
  };
}
