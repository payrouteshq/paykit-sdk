import {
  AbstractPayKitProvider,
  CapturePaymentSchema,
  Checkout,
  CreateCheckoutSchema,
  CreateCustomerParams,
  CreatePaymentSchema,
  CreateRefundSchema,
  CreateSubscriptionSchema,
  Customer,
  HTTPClient,
  InvalidTypeError,
  OperationFailedError,
  PAYKIT_METADATA_KEY,
  PayKitProvider,
  PaykitProviderOptions,
  Payment,
  ProviderMetadataRegistry,
  ProviderNotSupportedError,
  Refund,
  ResourceNotFoundError,
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
  createSubscriptionSchema,
  hashWebhookPayload,
  isEmailCustomer,
  parseCustomerName,
  paykitEvent$InboundSchema,
  schema,
  stringifyMetadataValues,
  updateCustomerSchema,
  validateRequiredKeys,
} from '@paykit-sdk/core';
import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import {
  RazorpayCustomer,
  RazorpayErrorResponse,
  RazorpayPayment,
  RazorpayPaymentLink,
  RazorpayPlan,
  RazorpayRawEvents,
  RazorpayRefund,
  RazorpaySubscription,
  RazorpayWebhookEvent,
} from './schema';
import {
  Checkout$inboundSchema,
  Customer$inboundSchema,
  Invoice$inboundSchema,
  Payment$inboundSchema,
  Refund$inboundSchema,
  Subscription$inboundSchema,
} from './utils/mapper';

interface RazorpayMetadata extends ProviderMetadataRegistry {
  subscription: {
    total_count?: number;
    end_at?: number;
    customer_notify?: boolean;
  };
}

export interface RazorpayOptions extends PaykitProviderOptions {
  /**
   * Razorpay key id, e.g. `rzp_test_xxxxx` or `rzp_live_xxxxx`
   */
  keyId: string;

  /**
   * Razorpay key secret
   */
  keySecret: string;
}

const razorpayOptionsSchema = schema<RazorpayOptions>()(
  z.object({
    keyId: z.string(),
    keySecret: z.string(),
    isSandbox: z.boolean(),
    debug: z.boolean().optional(),
  }),
);

const providerName = 'razorpay';

export class RazorpayProvider
  extends AbstractPayKitProvider
  implements
    PayKitProvider<RazorpayMetadata, HTTPClient, RazorpayRawEvents>
{
  readonly providerName = providerName;
  private readonly _client: HTTPClient;
  private readonly opts: RazorpayOptions;
  readonly isSandbox: boolean;

  constructor(opts: RazorpayOptions) {
    super(razorpayOptionsSchema, opts, providerName);

    this.opts = opts;

    this._client = new HTTPClient({
      baseUrl: 'https://api.razorpay.com/v1',
      headers: {
        Authorization: `Basic ${Buffer.from(`${opts.keyId}:${opts.keySecret}`).toString('base64')}`,
        'Content-Type': 'application/json',
      },
      retryOptions: {
        max: 3,
        baseDelay: 1000,
        debug: opts.debug ?? false,
      },
    });
    this.isSandbox = opts.isSandbox;
  }

  get _native(): HTTPClient {
    return this._client;
  }

  private async unwrap<T>(result: {
    ok: boolean;
    value?: T;
    error?: unknown;
  }): Promise<T> {
    if (!result.ok) {
      const errorValue = result.error as
        | RazorpayErrorResponse
        | undefined;

      throw new OperationFailedError(
        errorValue?.error?.description ?? 'Razorpay request failed',
        this.providerName,
        { cause: new Error(JSON.stringify(result.error)) },
      );
    }

    return result.value as T;
  }

  /**
   * Razorpay has one way to charge a customer without a saved payment
   * method: Payment Links. createCheckout and createPayment both boil
   * down to this same call - only the input validation and the response
   * mapper differ.
   */
  private async createPaymentLink(params: {
    amount: number;
    currency: string;
    customer: { email?: string; name?: string; contact?: string };
    notes: Record<string, string>;
    callbackUrl?: string;
    providerMetadata?: Record<string, unknown>;
  }): Promise<RazorpayPaymentLink> {
    const body = {
      // Spread first so provider_metadata can only add extra
      // Razorpay-specific fields - it must never silently override the
      // normalized fields computed below.
      ...params.providerMetadata,
      amount: params.amount,
      currency: params.currency,
      customer: params.customer,
      notes: params.notes,
      ...(params.callbackUrl && {
        callback_url: params.callbackUrl,
        callback_method: 'get',
      }),
    };

    const response = await this._client.post<RazorpayPaymentLink>(
      '/payment_links/',
      { body: JSON.stringify(body) },
    );

    return this.unwrap(response);
  }

  createCheckout = async (
    params: CreateCheckoutSchema<RazorpayMetadata['checkout']>,
  ): Promise<Checkout> => {
    const { error, data } = createCheckoutSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createCheckout',
      );
    }

    if (!isEmailCustomer(data.customer)) {
      throw new InvalidTypeError(
        'customer',
        'object with email',
        'string (customer ID)',
        { provider: this.providerName, method: 'createCheckout' },
      );
    }

    const { amount, currency } = validateRequiredKeys(
      ['amount', 'currency'],
      (data.provider_metadata as Record<string, string>) ?? {},
      'Missing required provider metadata: {keys}',
    );

    const notes = {
      ...stringifyMetadataValues(data.metadata ?? {}),
      [PAYKIT_METADATA_KEY]: JSON.stringify({
        item_id: data.item_id,
        quantity: data.quantity,
        type: data.session_type,
      }),
    };

    const link = await this.createPaymentLink({
      amount: Number(amount),
      currency: currency.toUpperCase(),
      customer: { email: data.customer.email },
      notes,
      callbackUrl: data.success_url,
      providerMetadata: data.provider_metadata,
    });

    return Checkout$inboundSchema(link);
  };

  retrieveCheckout = async (id: string): Promise<Checkout | null> => {
    const response = await this._client.get<RazorpayPaymentLink>(
      `/payment_links/${encodeURIComponent(id)}`,
    );

    if (!response.ok || !response.value) return null;

    return Checkout$inboundSchema(response.value);
  };

  updateCheckout = async (
    _id: string,
    _params: UpdateCheckoutSchema<RazorpayMetadata['checkout']>,
  ): Promise<Checkout> => {
    throw new ProviderNotSupportedError(
      'updateCheckout',
      'Razorpay',
      {
        reason:
          'Razorpay does not support updating payment links after creation',
        alternative: 'Create a new checkout session instead',
      },
    );
  };

  deleteCheckout = async (id: string): Promise<null> => {
    const response = await this._client.post<RazorpayPaymentLink>(
      `/payment_links/${encodeURIComponent(id)}/cancel`,
    );

    await this.unwrap(response);

    return null;
  };

  createCustomer = async (
    params: CreateCustomerParams<RazorpayMetadata['customer']>,
  ): Promise<Customer> => {
    const { error, data } = createCustomerSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createCustomer',
      );
    }

    const { fullName: name } = parseCustomerName({
      name: data.name,
      email: data.email,
    });

    const body = {
      ...data.provider_metadata,
      name,
      email: data.email,
      ...(data.phone && { contact: data.phone }),
      notes: stringifyMetadataValues(data.metadata ?? {}),
    };

    const response = await this._client.post<RazorpayCustomer>(
      '/customers',
      { body: JSON.stringify(body) },
    );

    const customer = await this.unwrap(response);

    return Customer$inboundSchema(customer);
  };

  retrieveCustomer = async (id: string): Promise<Customer | null> => {
    const response = await this._client.get<RazorpayCustomer>(
      `/customers/${encodeURIComponent(id)}`,
    );

    if (!response.ok || !response.value) return null;

    return Customer$inboundSchema(response.value);
  };

  updateCustomer = async (
    id: string,
    params: UpdateCustomerParams<RazorpayMetadata['customer']>,
  ): Promise<Customer> => {
    const { error, data } = updateCustomerSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'updateCustomer',
      );
    }

    const body = {
      ...data.provider_metadata,
      ...(data.name && { name: data.name }),
      ...(data.email && { email: data.email }),
      ...(data.metadata && {
        notes: stringifyMetadataValues(data.metadata),
      }),
    };

    const response = await this._client.put<RazorpayCustomer>(
      `/customers/${encodeURIComponent(id)}`,
      { body: JSON.stringify(body) },
    );

    const customer = await this.unwrap(response);

    return Customer$inboundSchema(customer);
  };

  deleteCustomer = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deleteCustomer',
      'Razorpay',
      { reason: 'Razorpay does not provide a delete-customer API' },
    );
  };

  private async fetchPlan(planId: string): Promise<RazorpayPlan> {
    const response = await this._client.get<RazorpayPlan>(
      `/plans/${encodeURIComponent(planId)}`,
    );

    return this.unwrap(response);
  }

  createSubscription = async (
    params: CreateSubscriptionSchema<
      RazorpayMetadata['subscription']
    >,
  ): Promise<Subscription> => {
    const { error, data } =
      createSubscriptionSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createSubscription',
      );
    }

    const plan = await this.fetchPlan(data.item_id);

    const providerMetadata = data.provider_metadata as
      | { total_count?: number; end_at?: number }
      | undefined;

    if (!providerMetadata?.total_count && !providerMetadata?.end_at) {
      throw new ValidationError(
        'Razorpay requires either total_count or end_at in provider_metadata to create a subscription',
        { provider: this.providerName, method: 'createSubscription' },
      );
    }

    const body = {
      ...providerMetadata,
      plan_id: data.item_id,
      quantity: data.quantity,
      notes: stringifyMetadataValues(data.metadata ?? {}),
    };

    const response = await this._client.post<RazorpaySubscription>(
      '/subscriptions',
      { body: JSON.stringify(body) },
    );

    const subscription = await this.unwrap(response);

    return Subscription$inboundSchema(subscription, plan);
  };

  retrieveSubscription = async (
    id: string,
  ): Promise<Subscription | null> => {
    const response = await this._client.get<RazorpaySubscription>(
      `/subscriptions/${encodeURIComponent(id)}`,
    );

    if (!response.ok || !response.value) return null;

    const plan = await this.fetchPlan(response.value.plan_id);

    return Subscription$inboundSchema(response.value, plan);
  };

  updateSubscription = async (
    id: string,
    params: UpdateSubscriptionSchema<
      RazorpayMetadata['subscription']
    >,
  ): Promise<Subscription> => {
    const body = {
      ...(params.provider_metadata ?? {}),
      ...(params.metadata && {
        notes: stringifyMetadataValues(params.metadata),
      }),
    };

    if (Object.keys(body).length === 0) {
      throw new ValidationError(
        'Razorpay requires at least one field (via metadata or provider_metadata) to update a subscription',
        { provider: this.providerName, method: 'updateSubscription' },
      );
    }

    const response = await this._client.patch<RazorpaySubscription>(
      `/subscriptions/${encodeURIComponent(id)}`,
      { body: JSON.stringify(body) },
    );

    const subscription = await this.unwrap(response);
    const plan = await this.fetchPlan(subscription.plan_id);

    return Subscription$inboundSchema(subscription, plan);
  };

  cancelSubscription = async (id: string): Promise<Subscription> => {
    const response = await this._client.post<RazorpaySubscription>(
      `/subscriptions/${encodeURIComponent(id)}/cancel`,
      { body: JSON.stringify({ cancel_at_cycle_end: false }) },
    );

    const subscription = await this.unwrap(response);
    const plan = await this.fetchPlan(subscription.plan_id);

    return Subscription$inboundSchema(subscription, plan);
  };

  deleteSubscription = async (id: string): Promise<null> => {
    await this.cancelSubscription(id);

    return null;
  };

  createPayment = async (
    params: CreatePaymentSchema<RazorpayMetadata['payment']>,
  ): Promise<Payment> => {
    const { error, data } = createPaymentSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createPayment',
      );
    }

    if (!isEmailCustomer(data.customer)) {
      throw new InvalidTypeError(
        'customer',
        'object with email',
        typeof data.customer,
        { provider: this.providerName, method: 'createPayment' },
      );
    }

    const { success_url } = validateRequiredKeys(
      ['success_url'],
      (data.provider_metadata as Record<string, string>) ?? {},
      'Missing required provider metadata: {keys}',
    );

    const { success_url: _successUrl, ...restProviderMetadata } =
      (data.provider_metadata as Record<string, unknown>) ?? {};

    const notes = {
      ...stringifyMetadataValues(data.metadata ?? {}),
      [PAYKIT_METADATA_KEY]: JSON.stringify({
        item_id: data.item_id,
      }),
    };

    if (this.opts.debug) {
      console.info('[Razorpay] Creating payment link', {
        email: data.customer.email,
        amount: data.amount,
      });
    }

    const link = await this.createPaymentLink({
      amount: data.amount,
      currency: data.currency,
      customer: { email: data.customer.email },
      notes,
      callbackUrl: success_url,
      providerMetadata: restProviderMetadata,
    });

    return Payment$inboundSchema(
      {
        id: link.id,
        entity: 'payment',
        amount: link.amount,
        currency: link.currency,
        status: 'created',
        order_id: link.order_id,
        invoice_id: null,
        international: false,
        method: '',
        amount_refunded: 0,
        refund_status: null,
        captured: false,
        description: link.description,
        card_id: null,
        bank: null,
        wallet: null,
        vpa: null,
        email: data.customer.email,
        contact: null,
        notes: link.notes,
        fee: null,
        tax: null,
        error_code: null,
        error_description: null,
        error_source: null,
        error_step: null,
        error_reason: null,
        acquirer_data: null,
        created_at: link.created_at,
      },
      link.short_url,
    );
  };

  retrievePayment = async (id: string): Promise<Payment | null> => {
    const response = await this._client.get<RazorpayPayment>(
      `/payments/${encodeURIComponent(id)}`,
    );

    if (!response.ok || !response.value) return null;

    return Payment$inboundSchema(response.value);
  };

  updatePayment = async (
    _id: string,
    _params: UpdatePaymentSchema<RazorpayMetadata['payment']>,
  ): Promise<Payment> => {
    throw new ProviderNotSupportedError('updatePayment', 'Razorpay', {
      reason:
        'Razorpay does not support updating payments after creation',
    });
  };

  deletePayment = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deletePayment', 'Razorpay', {
      reason: 'Razorpay does not support deleting payments',
    });
  };

  capturePayment = async (
    id: string,
    params: CapturePaymentSchema,
  ): Promise<Payment> => {
    const existing = await this.retrievePayment(id);

    if (!existing) {
      throw new ResourceNotFoundError(
        'payment',
        id,
        this.providerName,
      );
    }

    const response = await this._client.post<RazorpayPayment>(
      `/payments/${encodeURIComponent(id)}/capture`,
      {
        body: JSON.stringify({
          amount: params.amount,
          currency: existing.currency,
        }),
      },
    );

    const payment = await this.unwrap(response);

    return Payment$inboundSchema(payment);
  };

  cancelPayment = async (_id: string): Promise<Payment> => {
    throw new ProviderNotSupportedError('cancelPayment', 'Razorpay', {
      reason: 'Razorpay does not support canceling payments',
      alternative: 'Use createRefund to refund a captured payment',
    });
  };

  createRefund = async (
    params: CreateRefundSchema<RazorpayMetadata['refund']>,
  ): Promise<Refund> => {
    const { error, data } = createRefundSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createRefund',
      );
    }

    const body = {
      ...data.provider_metadata,
      amount: data.amount,
      notes: {
        ...stringifyMetadataValues(data.metadata ?? {}),
        ...(data.reason && { reason: data.reason }),
      },
    };

    const response = await this._client.post<RazorpayRefund>(
      `/payments/${encodeURIComponent(data.payment_id)}/refund`,
      { body: JSON.stringify(body) },
    );

    const refund = await this.unwrap(response);

    return Refund$inboundSchema(refund);
  };

  handleWebhook = async (
    payload: WebhookHandlerConfig,
    webhookSecret: string | null,
  ): Promise<Array<WebhookEventPayload<RazorpayRawEvents>>> => {
    if (!webhookSecret) {
      throw new WebhookError(
        'webhookSecret is required for Razorpay webhook verification',
        { provider: this.providerName },
      );
    }

    const { body, headersAsObject } = payload;

    const signature = headersAsObject['x-razorpay-signature'];

    if (!signature) {
      throw new WebhookError('Missing x-razorpay-signature header', {
        provider: this.providerName,
      });
    }

    const expectedSignature = createHmac('sha256', webhookSecret)
      .update(body)
      .digest('hex');

    if (!this.safeHexEqual(signature, expectedSignature)) {
      throw new WebhookError('Invalid Razorpay webhook signature', {
        provider: this.providerName,
      });
    }

    let event: RazorpayWebhookEvent;

    try {
      event = JSON.parse(body) as RazorpayWebhookEvent;
    } catch {
      throw new WebhookError(
        'Invalid webhook payload: not valid JSON',
        { provider: this.providerName },
      );
    }

    const results: Array<WebhookEventPayload<RazorpayRawEvents>> = [];

    const contentHash = hashWebhookPayload(event.event, body);

    results.push({
      id: `razorpay:${event.event}:${contentHash}`,
      type: `razorpay.${event.event}`,
      created: event.created_at,
      data: event as any,
      is_raw: true,
    });

    const standardEvents = await this.mapToStandardEvents(
      event,
      contentHash,
    );

    if (standardEvents) results.push(...standardEvents);

    return results;
  };

  private safeHexEqual(
    received: string,
    expectedHex: string,
  ): boolean {
    try {
      const expectedBuf = Buffer.from(expectedHex, 'hex');
      const receivedBuf = Buffer.from(received, 'hex');

      return (
        expectedBuf.length === receivedBuf.length &&
        timingSafeEqual(expectedBuf, receivedBuf)
      );
    } catch {
      return false;
    }
  }

  private mapToStandardEvents = async (
    event: RazorpayWebhookEvent,
    contentHash: string,
  ): Promise<Array<WebhookEventPayload> | null> => {
    const created = event.created_at;
    const id = `paykit:${event.event}:${contentHash}`;

    switch (event.event) {
      case 'payment.authorized': {
        const payment = event.payload.payment?.entity;
        if (!payment) return null;

        return [
          paykitEvent$InboundSchema({
            type: 'payment.updated',
            created,
            id,
            data: Payment$inboundSchema(payment),
          }),
        ];
      }

      case 'payment.captured': {
        const payment = event.payload.payment?.entity;
        if (!payment) return null;

        return [
          paykitEvent$InboundSchema({
            type: 'payment.succeeded',
            created,
            id,
            data: Payment$inboundSchema(payment),
          }),
          paykitEvent$InboundSchema({
            type: 'invoice.generated',
            created,
            id: `${id}-invoice`,
            data: Invoice$inboundSchema(payment),
          }),
        ];
      }

      case 'payment.failed': {
        const payment = event.payload.payment?.entity;
        if (!payment) return null;

        return [
          paykitEvent$InboundSchema({
            type: 'payment.failed',
            created,
            id,
            data: Payment$inboundSchema(payment),
          }),
        ];
      }

      case 'order.paid': {
        const payment = event.payload.payment?.entity;
        if (!payment) return null;

        return [
          paykitEvent$InboundSchema({
            type: 'payment.succeeded',
            created,
            id,
            data: Payment$inboundSchema(payment),
          }),
          paykitEvent$InboundSchema({
            type: 'invoice.generated',
            created,
            id: `${id}-invoice`,
            data: Invoice$inboundSchema(payment),
          }),
        ];
      }

      case 'refund.created':
      case 'refund.processed': {
        const refund = event.payload.refund?.entity;
        if (!refund) return null;

        return [
          paykitEvent$InboundSchema({
            type: 'refund.created',
            created,
            id,
            data: Refund$inboundSchema(refund),
          }),
        ];
      }

      case 'payment_link.paid': {
        const paymentLink = event.payload.payment_link?.entity;
        if (!paymentLink) return null;

        return [
          paykitEvent$InboundSchema({
            type: 'payment.succeeded',
            created,
            id,
            data: {
              ...Payment$inboundSchema(
                {
                  id: paymentLink.id,
                  entity: 'payment',
                  amount: paymentLink.amount,
                  currency: paymentLink.currency,
                  status: 'captured',
                  order_id: paymentLink.order_id,
                  invoice_id: null,
                  international: false,
                  method: '',
                  amount_refunded: 0,
                  refund_status: null,
                  captured: true,
                  description: paymentLink.description,
                  card_id: null,
                  bank: null,
                  wallet: null,
                  vpa: null,
                  email: paymentLink.customer?.email ?? '',
                  contact: paymentLink.customer?.contact ?? null,
                  notes: paymentLink.notes,
                  fee: null,
                  tax: null,
                  error_code: null,
                  error_description: null,
                  error_source: null,
                  error_step: null,
                  error_reason: null,
                  acquirer_data: null,
                  created_at: paymentLink.created_at,
                },
                paymentLink.short_url,
              ),
            },
          }),
        ];
      }

      case 'payment_link.cancelled':
      case 'payment_link.expired':
        // No standard PayKit checkout/payment status covers this
        // transition; available as a raw event only.
        return null;

      case 'subscription.authenticated':
      case 'subscription.activated':
      case 'subscription.updated':
      case 'subscription.resumed': {
        const subscription = event.payload.subscription?.entity;
        if (!subscription) return null;

        const plan = await this.fetchPlan(subscription.plan_id);

        return [
          paykitEvent$InboundSchema({
            type: 'subscription.updated',
            created,
            id,
            data: Subscription$inboundSchema(subscription, plan),
          }),
        ];
      }

      case 'subscription.charged': {
        const payment = event.payload.payment?.entity;
        if (!payment) return null;

        return [
          paykitEvent$InboundSchema({
            type: 'payment.succeeded',
            created,
            id,
            data: Payment$inboundSchema(payment),
          }),
          paykitEvent$InboundSchema({
            type: 'invoice.generated',
            created,
            id: `${id}-invoice`,
            data: Invoice$inboundSchema(payment),
          }),
        ];
      }

      case 'subscription.completed':
      case 'subscription.cancelled': {
        const subscription = event.payload.subscription?.entity;
        if (!subscription) return null;

        const plan = await this.fetchPlan(subscription.plan_id);

        return [
          paykitEvent$InboundSchema({
            type: 'subscription.canceled',
            created,
            id,
            data: Subscription$inboundSchema(subscription, plan),
          }),
        ];
      }

      case 'subscription.pending':
      case 'subscription.halted':
      case 'subscription.paused':
        // No standard PayKit subscription status covers these
        // transitions; available as raw events only.
        return null;

      default:
        if (this.opts.debug) {
          console.info(
            `[Razorpay] No standard mapping for event: ${event.event}. Available as raw event.`,
          );
        }
        return null;
    }
  };
}
