import {
  AbstractPayKitProvider,
  BillingInfo,
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
  OAuth2TokenManager,
  OperationFailedError,
  PAYKIT_METADATA_KEY,
  Payee,
  PayKitProvider,
  PaykitProviderOptions,
  Payment,
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
  createCustomerSchema,
  createPaymentSchema,
  createRefundSchema,
  hashWebhookPayload,
  isIdCustomer,
  paykitEvent$InboundSchema,
  schema,
  stringifyMetadataValues,
} from '@paykit-sdk/core';
import { createHmac, timingSafeEqual } from 'crypto';
import {
  FlutterwaveChargeAuthorization,
  FlutterwaveChargeCompletedEventData,
  FlutterwaveCharge,
  FlutterwaveCreateChargeRequest,
  FlutterwaveCreateCustomerRequest,
  FlutterwaveCreateOrderRequest,
  FlutterwaveCurrency,
  FlutterwaveCustomer,
  FlutterwaveCustomerInput,
  FlutterwaveDirectChargeRequest,
  FlutterwaveDirectOrderRequest,
  FlutterwaveEnvelope,
  FlutterwaveEventPayloadMap,
  FlutterwaveOrder,
  FlutterwaveOrderAuthorizationEventData,
  FlutterwavePaymentMethodRequest,
  FlutterwaveRefund,
  FlutterwaveRefundCompletedEventData,
  FlutterwaveUpdateChargeRequest,
  FlutterwaveUpdateCustomerRequest,
  FlutterwaveUpdateOrderRequest,
  FlutterwaveWebhookEnvelope,
} from './schema';
import {
  Customer$inboundSchema,
  Payment$fromCharge,
  Payment$fromOrder,
  REFUND_REASON_NOTE_KEY,
  Refund$inboundSchema,
  toFlutterwaveName,
  toFlutterwavePhone,
  toRefundReason,
} from './utils/mapper';

/** Sent on any request; all optional. */
interface FlutterwaveRequestMetadata {
  /** Reused as `X-Idempotency-Key` so a retried call can't duplicate the resource. */
  idempotencyKey?: string;
  /** `X-Trace-Id`, echoed back by Flutterwave and useful for support. */
  traceId?: string;
  /** `X-Scenario-Key`: simulates an outcome in the sandbox, ignored in production. */
  scenarioKey?: string;
}

interface FlutterwavePaymentMetadata
  extends FlutterwaveRequestMetadata {
  /**
   * Payment method to charge, created inline together with the customer
   * (Flutterwave's orchestrator). Card details must already be
   * encrypted per Flutterwave's encryption guide.
   */
  payment_method?: FlutterwavePaymentMethodRequest;
  /**
   * A saved payment method (`pmd_...`). Needs `customer: { id }`.
   * Provide this or `payment_method`, not both.
   */
  payment_method_id?: string;
  /** Where Flutterwave sends the customer after a redirect-based step. */
  redirect_url?: string;
  /** Your unique reference for the charge. Random if omitted. */
  reference?: string;
  /**
   * Customer authorization (PIN, OTP, AVS) to complete a charge. Used
   * by updatePayment() after createPayment() returns `requires_action`.
   */
  authorization?: FlutterwaveChargeAuthorization;
}

interface FlutterwaveCustomerMetadata
  extends FlutterwaveRequestMetadata {}

interface FlutterwaveRefundMetadata
  extends FlutterwaveRequestMetadata {}

interface FlutterwaveMetadata extends ProviderMetadataRegistry {
  customer: FlutterwaveCustomerMetadata;
  payment: FlutterwavePaymentMetadata;
  refund: FlutterwaveRefundMetadata;
}

type PayKitFlutterwaveRawEvents = {
  [K in keyof FlutterwaveEventPayloadMap as `flutterwave.${K}`]: FlutterwaveEventPayloadMap[K];
} & Record<string, any>;

export interface FlutterwaveOptions extends PaykitProviderOptions {
  /** OAuth 2.0 client id from the Flutterwave dashboard. */
  clientId: string;
  /** OAuth 2.0 client secret from the Flutterwave dashboard. */
  clientSecret: string;
}

const flutterwaveOptionsSchema = schema<FlutterwaveOptions>()(
  Schema.object({
    clientId: Schema.string(),
    clientSecret: Schema.string(),
    isSandbox: Schema.boolean(),
    debug: Schema.boolean().optional(),
  }),
);

const providerName = 'flutterwave';

const SANDBOX_BASE_URL =
  'https://developersandbox-api.flutterwave.com';
const PRODUCTION_BASE_URL = 'https://f4bexperience.flutterwave.com';

const IDP_BASE_URL = 'https://idp.flutterwave.com';
const TOKEN_ENDPOINT =
  '/realms/flutterwave/protocol/openid-connect/token';

/** Access tokens live 10 minutes; refresh a minute early. */
const TOKEN_EXPIRY_BUFFER_SECONDS = 60;

const ORDER_ID_PREFIX = 'ord_';

const isOrderId = (id: string) => id.startsWith(ORDER_ID_PREFIX);

export class FlutterwaveProvider
  extends AbstractPayKitProvider
  implements
    PayKitProvider<
      FlutterwaveMetadata,
      HTTPClient,
      PayKitFlutterwaveRawEvents
    >
{
  readonly providerName = providerName;
  readonly isSandbox: boolean;
  private readonly _client: HTTPClient;
  private readonly tokenManager: OAuth2TokenManager;

  get _native(): HTTPClient {
    return this._client;
  }

  constructor(private readonly opts: FlutterwaveOptions) {
    super(flutterwaveOptionsSchema, opts, providerName);

    this.isSandbox = opts.isSandbox;

    const retryOptions = {
      max: 3,
      baseDelay: 1000,
      debug: opts.debug ?? false,
    };

    this._client = new HTTPClient({
      baseUrl: this.isSandbox
        ? SANDBOX_BASE_URL
        : PRODUCTION_BASE_URL,
      headers: { 'Content-Type': 'application/json' },
      retryOptions,
    });

    this.tokenManager = new OAuth2TokenManager({
      client: new HTTPClient({
        baseUrl: IDP_BASE_URL,
        headers: {},
        retryOptions,
      }),
      provider: this.providerName,
      tokenEndpoint: TOKEN_ENDPOINT,
      credentials: {
        username: opts.clientId,
        password: opts.clientSecret,
      },
      requestBody: new URLSearchParams({
        client_id: opts.clientId,
        client_secret: opts.clientSecret,
        grant_type: 'client_credentials',
      }),
      requestHeaders: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      responseAdapter: ({ access_token, expires_in }) => ({
        accessToken: access_token ?? '',
        expiresIn: expires_in ?? 0,
      }),
      expiryBuffer: TOKEN_EXPIRY_BUFFER_SECONDS,
    });
  }

  private async headers(
    meta?: FlutterwaveRequestMetadata,
    { idempotent = false } = {},
  ): Promise<Record<string, string>> {
    return {
      ...(await this.tokenManager.getAuthHeaders()),
      'X-Trace-Id': meta?.traceId ?? crypto.randomUUID(),
      ...(idempotent && {
        'X-Idempotency-Key':
          meta?.idempotencyKey ?? crypto.randomUUID(),
      }),
      ...(this.isSandbox &&
        meta?.scenarioKey && { 'X-Scenario-Key': meta.scenarioKey }),
    };
  }

  private async get<T>(path: string) {
    return this._client.get<FlutterwaveEnvelope<T>>(path, {
      headers: await this.headers(),
    });
  }

  private async post<T>(
    path: string,
    body: unknown,
    meta?: FlutterwaveRequestMetadata,
  ) {
    return this._client.post<FlutterwaveEnvelope<T>>(path, {
      body: JSON.stringify(body),
      headers: await this.headers(meta, { idempotent: true }),
    });
  }

  private async put<T>(
    path: string,
    body: unknown,
    meta?: FlutterwaveRequestMetadata,
  ) {
    return this._client.put<FlutterwaveEnvelope<T>>(path, {
      body: JSON.stringify(body),
      headers: await this.headers(meta),
    });
  }

  private unwrap<T>(
    result: {
      ok: boolean;
      value?: FlutterwaveEnvelope<T> | null;
      error?: unknown;
    },
    operation: string,
  ): T {
    if (!result.ok || !result.value?.data) {
      throw new OperationFailedError(operation, this.providerName, {
        cause: new Error(
          JSON.stringify(
            result.error ?? result.value ?? 'Unknown error',
          ),
        ),
      });
    }

    return result.value.data;
  }

  private validationError(
    message: string,
    method: string,
    field: string,
  ) {
    return new ValidationError(message, {
      field,
      method,
      provider: this.providerName,
    });
  }

  /** Flutterwave needs `{ country_code, number }`; PayKit carries E.164. */
  private parsePhone(phone: string, method: string) {
    const parsed = toFlutterwavePhone(phone);

    if (!parsed) {
      throw this.validationError(
        'phone must be in E.164 format, e.g. +2349067985861',
        method,
        'phone',
      );
    }

    return parsed;
  }

  private toAddress(billing: BillingInfo) {
    const { line1, line2, city, state, postal_code, country } =
      billing.address;

    return {
      line1,
      ...(line2 && { line2 }),
      city,
      state: state ?? '',
      postal_code,
      country,
    };
  }

  /**
   * The orchestrator takes the customer inline. For an existing
   * customer that means re-reading their details first.
   */
  private async toCustomerInput(
    customer: Payee,
    billing?: BillingInfo,
  ): Promise<FlutterwaveCustomerInput> {
    const address = billing && this.toAddress(billing);

    if (!isIdCustomer(customer)) {
      return {
        email: (customer as { email: string }).email,
        ...(address && { address }),
      };
    }

    const existing = await this.retrieveFlutterwaveCustomer(
      String(customer.id),
    );

    if (!existing) {
      throw new ResourceNotFoundError(
        'customer',
        String(customer.id),
        this.providerName,
      );
    }

    return {
      email: existing.email,
      ...(existing.name && { name: existing.name }),
      ...(existing.phone && { phone: existing.phone }),
      ...((address ?? existing.address) && {
        address: address ?? existing.address,
      }),
    };
  }

  private retrieveFlutterwaveCustomer = async (
    id: string,
  ): Promise<FlutterwaveCustomer | null> => {
    const response = await this.get<FlutterwaveCustomer>(
      `/customers/${encodeURIComponent(id)}`,
    );

    return response.ok ? (response.value?.data ?? null) : null;
  };

  createCheckout = async (
    _params: CreateCheckoutSchema,
  ): Promise<Checkout> => {
    throw new ProviderNotSupportedError(
      'createCheckout',
      'Flutterwave',
      {
        reason:
          'Flutterwave v4 has no hosted checkout or product catalog API.',
        alternative:
          'Use createPayment(): a redirect-based method returns a payment_url to send the customer to.',
      },
    );
  };

  retrieveCheckout = async (
    _id: string,
  ): Promise<Checkout | null> => {
    throw new ProviderNotSupportedError(
      'retrieveCheckout',
      'Flutterwave',
      {
        reason: 'Flutterwave v4 has no hosted checkout API.',
        alternative: 'Use retrievePayment() instead.',
      },
    );
  };

  updateCheckout = async (
    _id: string,
    _params: UpdateCheckoutSchema,
  ): Promise<Checkout> => {
    throw new ProviderNotSupportedError(
      'updateCheckout',
      'Flutterwave',
      {
        reason: 'Flutterwave v4 has no hosted checkout API.',
      },
    );
  };

  deleteCheckout = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deleteCheckout',
      'Flutterwave',
      {
        reason: 'Flutterwave v4 has no hosted checkout API.',
      },
    );
  };

  createCustomer = async (
    params: CreateCustomerParams<FlutterwaveMetadata['customer']>,
  ): Promise<Customer> => {
    const { error, data } = createCustomerSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createCustomer',
      );
    }

    const body: FlutterwaveCreateCustomerRequest = {
      email: data.email,
      ...(data.name && { name: toFlutterwaveName(data.name) }),
      ...(data.phone && {
        phone: this.parsePhone(data.phone, 'createCustomer'),
      }),
      ...(data.billing && { address: this.toAddress(data.billing) }),
      ...(data.metadata && {
        meta: stringifyMetadataValues(data.metadata),
      }),
    };

    const response = await this.post<FlutterwaveCustomer>(
      '/customers',
      body,
      data.provider_metadata as
        | FlutterwaveCustomerMetadata
        | undefined,
    );

    return Customer$inboundSchema(
      this.unwrap(response, 'createCustomer'),
    );
  };

  retrieveCustomer = async (id: string): Promise<Customer | null> => {
    const customer = await this.retrieveFlutterwaveCustomer(id);

    return customer ? Customer$inboundSchema(customer) : null;
  };

  updateCustomer = async (
    id: string,
    params: UpdateCustomerParams<FlutterwaveMetadata['customer']>,
  ): Promise<Customer> => {
    if (params.email) {
      throw this.validationError(
        "Flutterwave doesn't allow changing a customer's email.",
        'updateCustomer',
        'email',
      );
    }

    const body: FlutterwaveUpdateCustomerRequest = {
      ...(params.name && { name: toFlutterwaveName(params.name) }),
      ...(params.phone && {
        phone: this.parsePhone(params.phone, 'updateCustomer'),
      }),
      ...(params.billing && {
        address: this.toAddress(params.billing),
      }),
      ...(params.metadata && {
        meta: stringifyMetadataValues(params.metadata),
      }),
    };

    const response = await this.put<FlutterwaveCustomer>(
      `/customers/${encodeURIComponent(id)}`,
      body,
      params.provider_metadata,
    );

    return Customer$inboundSchema(
      this.unwrap(response, 'updateCustomer'),
    );
  };

  deleteCustomer = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deleteCustomer',
      'Flutterwave',
      {
        reason: 'Flutterwave has no endpoint to delete customers.',
      },
    );
  };

  createSubscription = async (
    _params: CreateSubscriptionSchema,
  ): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'createSubscription',
      'Flutterwave',
      {
        reason:
          'Flutterwave v4 has no subscription or payment plan API.',
        alternative:
          'Charge a saved payment_method_id on your own schedule with createPayment().',
      },
    );
  };

  retrieveSubscription = async (
    _id: string,
  ): Promise<Subscription | null> => {
    throw new ProviderNotSupportedError(
      'retrieveSubscription',
      'Flutterwave',
      { reason: 'Flutterwave v4 has no subscription API.' },
    );
  };

  updateSubscription = async (
    _id: string,
    _params: UpdateSubscriptionSchema,
  ): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'updateSubscription',
      'Flutterwave',
      { reason: 'Flutterwave v4 has no subscription API.' },
    );
  };

  cancelSubscription = async (_id: string): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'cancelSubscription',
      'Flutterwave',
      { reason: 'Flutterwave v4 has no subscription API.' },
    );
  };

  deleteSubscription = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deleteSubscription',
      'Flutterwave',
      { reason: 'Flutterwave v4 has no subscription API.' },
    );
  };

  /**
   * `capture_method: 'automatic'` creates a charge and `'manual'`
   * creates an order, which is authorized first and captured later with
   * capturePayment(). Pass `payment_method` to create the customer's
   * payment method inline (orchestrator), or `payment_method_id` plus a
   * `{ id }` customer to charge a saved one.
   */
  createPayment = async (
    params: CreatePaymentSchema<FlutterwaveMetadata['payment']>,
  ): Promise<Payment> => {
    const { error, data } = createPaymentSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createPayment',
      );
    }

    if (!data.customer) {
      throw new ConfigurationError(
        'customer is required for createPayment',
        { provider: this.providerName, missingKeys: ['customer'] },
      );
    }

    const pm = (data.provider_metadata ??
      {}) as FlutterwavePaymentMetadata;

    if (!pm.payment_method === !pm.payment_method_id) {
      throw new ConfigurationError(
        'Provide exactly one of payment_method or payment_method_id in the provider_metadata of createPayment',
        {
          provider: this.providerName,
          missingKeys: ['payment_method', 'payment_method_id'],
        },
      );
    }

    const isOrder = data.capture_method === 'manual';

    const common = {
      amount: data.amount,
      currency: data.currency as FlutterwaveCurrency,
      reference: pm.reference ?? crypto.randomUUID(),
      meta: {
        ...stringifyMetadataValues(data.metadata ?? {}),
        ...(data.item_id && {
          [PAYKIT_METADATA_KEY]: JSON.stringify({
            item_id: data.item_id,
          }),
        }),
      },
      ...(pm.redirect_url && { redirect_url: pm.redirect_url }),
    };

    let path: string;
    let body:
      | FlutterwaveCreateChargeRequest
      | FlutterwaveCreateOrderRequest
      | FlutterwaveDirectChargeRequest
      | FlutterwaveDirectOrderRequest;

    if (pm.payment_method_id) {
      if (!isIdCustomer(data.customer)) {
        throw new ConfigurationError(
          'payment_method_id requires customer to be { id }',
          {
            provider: this.providerName,
            missingKeys: ['customer.id'],
          },
        );
      }

      const saved = {
        ...common,
        customer_id: String(data.customer.id),
        payment_method_id: pm.payment_method_id,
      };

      path = isOrder ? '/orders' : '/charges';
      body = isOrder ? saved : { ...saved, recurring: false };
    } else {
      const inline = {
        ...common,
        customer: await this.toCustomerInput(
          data.customer,
          data.billing,
        ),
        payment_method: pm.payment_method!,
      };

      path = isOrder
        ? '/orchestration/direct-orders'
        : '/orchestration/direct-charges';
      body = inline;
    }

    const response = await this.post<
      FlutterwaveCharge | FlutterwaveOrder
    >(path, body, pm);

    const created = this.unwrap(response, 'createPayment');

    return isOrder
      ? Payment$fromOrder(created as FlutterwaveOrder)
      : Payment$fromCharge(created as FlutterwaveCharge);
  };

  /** `ord_...` ids are orders, everything else is a charge. */
  retrievePayment = async (id: string): Promise<Payment | null> => {
    const encoded = encodeURIComponent(id);

    if (isOrderId(id)) {
      const response = await this.get<FlutterwaveOrder>(
        `/orders/${encoded}`,
      );

      return response.ok && response.value?.data
        ? Payment$fromOrder(response.value.data)
        : null;
    }

    const response = await this.get<FlutterwaveCharge>(
      `/charges/${encoded}`,
    );

    return response.ok && response.value?.data
      ? Payment$fromCharge(response.value.data)
      : null;
  };

  /**
   * Charges only accept customer authorization (PIN, OTP, AVS) through
   * `provider_metadata.authorization`; orders only accept metadata.
   */
  updatePayment = async (
    id: string,
    params: UpdatePaymentSchema<FlutterwaveMetadata['payment']>,
  ): Promise<Payment> => {
    const pm = params.provider_metadata;
    const meta =
      params.metadata && stringifyMetadataValues(params.metadata);
    const encoded = encodeURIComponent(id);

    if (isOrderId(id)) {
      if (!meta) {
        throw this.validationError(
          'Nothing to update: an order only accepts metadata.',
          'updatePayment',
          'metadata',
        );
      }

      const body: FlutterwaveUpdateOrderRequest = { meta };
      const response = await this.put<FlutterwaveOrder>(
        `/orders/${encoded}`,
        body,
        pm,
      );

      return Payment$fromOrder(
        this.unwrap(response, 'updatePayment'),
      );
    }

    if (!meta && !pm?.authorization) {
      throw this.validationError(
        'Nothing to update: pass metadata or provider_metadata.authorization.',
        'updatePayment',
        'provider_metadata',
      );
    }

    const body: FlutterwaveUpdateChargeRequest = {
      ...(meta && { meta }),
      ...(pm?.authorization && { authorization: pm.authorization }),
    };

    const response = await this.put<FlutterwaveCharge>(
      `/charges/${encoded}`,
      body,
      pm,
    );

    return Payment$fromCharge(this.unwrap(response, 'updatePayment'));
  };

  deletePayment = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deletePayment',
      'Flutterwave',
      {
        reason: 'Flutterwave has no endpoint to delete a payment.',
        alternative:
          'Use cancelPayment() on an authorized order, or createRefund() once it has succeeded.',
      },
    );
  };

  /**
   * Flutterwave captures the full authorized amount of an order, so a
   * smaller `amount` is rejected rather than silently over-captured.
   */
  capturePayment = async (
    id: string,
    params: CapturePaymentSchema,
  ): Promise<Payment> => {
    if (!isOrderId(id)) {
      throw new ProviderNotSupportedError(
        'capturePayment',
        'Flutterwave',
        {
          reason:
            'Only orders (capture_method: "manual") can be captured. Charges are captured automatically.',
        },
      );
    }

    const order = await this.retrievePayment(id);

    if (!order) {
      throw new ResourceNotFoundError(
        'payment',
        id,
        this.providerName,
      );
    }

    if (params.amount !== order.amount) {
      throw this.validationError(
        `Flutterwave captures the full authorized amount (${order.amount}); partial capture is not supported.`,
        'capturePayment',
        'amount',
      );
    }

    const body: FlutterwaveUpdateOrderRequest = { action: 'capture' };
    const response = await this.put<FlutterwaveOrder>(
      `/orders/${encodeURIComponent(id)}`,
      body,
    );

    return Payment$fromOrder(this.unwrap(response, 'capturePayment'));
  };

  /** Voids an authorized order. Charges can't be cancelled. */
  cancelPayment = async (id: string): Promise<Payment> => {
    if (!isOrderId(id)) {
      throw new ProviderNotSupportedError(
        'cancelPayment',
        'Flutterwave',
        {
          reason:
            'Only authorized orders can be voided, not charges.',
          alternative:
            'Use createRefund() once the charge has succeeded.',
        },
      );
    }

    const body: FlutterwaveUpdateOrderRequest = { action: 'void' };
    const response = await this.put<FlutterwaveOrder>(
      `/orders/${encodeURIComponent(id)}`,
      body,
    );

    return Payment$fromOrder(this.unwrap(response, 'cancelPayment'));
  };

  /**
   * Refunds the full payment when `amount` is 0, since Flutterwave
   * always needs one. The payment is read first for its currency, which
   * Flutterwave doesn't repeat on refunds.
   */
  createRefund = async (
    params: CreateRefundSchema<FlutterwaveMetadata['refund']>,
  ): Promise<Refund> => {
    const { error, data } = createRefundSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createRefund',
      );
    }

    const payment = await this.retrievePayment(data.payment_id);

    if (!payment) {
      throw new ResourceNotFoundError(
        'payment',
        data.payment_id,
        this.providerName,
      );
    }

    const { reason, note } = toRefundReason(data.reason);

    const body = {
      charge_id: data.payment_id,
      amount: data.amount || payment.amount,
      reason,
      meta: {
        ...stringifyMetadataValues(data.metadata ?? {}),
        ...(note && { [REFUND_REASON_NOTE_KEY]: note }),
      },
    };

    const response = await this.post<FlutterwaveRefund>(
      '/refunds',
      body,
      data.provider_metadata as FlutterwaveRefundMetadata | undefined,
    );

    return Refund$inboundSchema(
      this.unwrap(response, 'createRefund'),
      payment.currency,
    );
  };

  /**
   * Verifies `flutterwave-signature`: the base64 HMAC-SHA256 of the raw
   * body keyed with the secret hash set in the dashboard. Flutterwave
   * retries a failed delivery, so this throws, rather than dropping the
   * event, when a payment can't be re-read to confirm it.
   */
  handleWebhook = async (
    payload: WebhookHandlerConfig,
    webhookSecret: string | null,
  ): Promise<
    Array<WebhookEventPayload<PayKitFlutterwaveRawEvents>>
  > => {
    if (!webhookSecret) {
      throw new WebhookError(
        'webhookSecret is required for Flutterwave webhook verification',
        { provider: this.providerName },
      );
    }

    const { body, headersAsObject } = payload;
    const signature = headersAsObject['flutterwave-signature'];

    if (!signature) {
      throw new WebhookError('Missing flutterwave-signature header', {
        provider: this.providerName,
      });
    }

    const expected = Buffer.from(
      createHmac('sha256', webhookSecret)
        .update(body)
        .digest('base64'),
    );
    const received = Buffer.from(signature);

    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      throw new WebhookError(
        'Invalid Flutterwave webhook signature',
        {
          provider: this.providerName,
        },
      );
    }

    let event: FlutterwaveWebhookEnvelope;

    try {
      event = JSON.parse(body) as FlutterwaveWebhookEnvelope;
    } catch {
      throw new WebhookError(
        'Invalid webhook payload: not valid JSON',
        {
          provider: this.providerName,
        },
      );
    }

    const contentHash = hashWebhookPayload(event.type, body);

    const results: Array<
      WebhookEventPayload<PayKitFlutterwaveRawEvents>
    > = [
      {
        id: `flutterwave:${event.type}:${contentHash}`,
        type: `flutterwave.${event.type}`,
        created: Math.floor(Date.now() / 1000),
        data: event.data as any,
        is_raw: true,
      },
    ];

    const standardEvents = await this.mapToStandardEvents(
      event,
      contentHash,
    );

    if (standardEvents) results.push(...standardEvents);

    return results;
  };

  private mapToStandardEvents = async (
    event: FlutterwaveWebhookEnvelope,
    contentHash: string,
  ): Promise<Array<WebhookEventPayload> | null> => {
    const created = Math.floor(Date.now() / 1000);
    const id = `paykit:${event.type}:${contentHash}`;

    switch (event.type) {
      case 'charge.completed':
      case 'order.authorization': {
        const data = event.data as
          | FlutterwaveChargeCompletedEventData
          | FlutterwaveOrderAuthorizationEventData;

        if (!data.id) return null;

        // Re-read the payment: the webhook is only a notification, and
        // Flutterwave advises confirming status before acting on it.
        const payment = await this.retrievePayment(data.id);

        if (!payment) {
          throw new WebhookError(
            `Could not verify payment ${data.id} for ${event.type}`,
            { provider: this.providerName },
          );
        }

        const type =
          payment.status === 'succeeded'
            ? 'payment.succeeded'
            : payment.status === 'failed'
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

      case 'refund.completed': {
        const data =
          event.data as FlutterwaveRefundCompletedEventData;

        if (!data.id || !data.status) return null;

        const payment = data.charge_id
          ? await this.retrievePayment(data.charge_id)
          : null;

        if (!payment) {
          throw new WebhookError(
            `Could not verify payment ${data.charge_id} for ${event.type}`,
            { provider: this.providerName },
          );
        }

        return [
          paykitEvent$InboundSchema({
            type: 'refund.created',
            created,
            id,
            data: Refund$inboundSchema(
              data as FlutterwaveRefund,
              payment.currency,
            ),
          }),
        ];
      }

      default:
        if (this.opts.debug) {
          console.info(
            `[Flutterwave] No standard mapping for event: ${event.type}. Available as raw event.`,
          );
        }
        return null;
    }
  };
}
