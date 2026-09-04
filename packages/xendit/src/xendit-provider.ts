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
  Invoice,
  OperationFailedError,
  PAYKIT_METADATA_KEY,
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
  isIdCustomer,
  parseCustomerName,
  paykitEvent$InboundSchema,
  refundReasonMatcher,
  schema,
  stringifyMetadataValues,
  updateCustomerSchema,
  validateRequiredKeys,
} from '@paykit-sdk/core';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import {
  XenditCustomer,
  XenditErrorResponse,
  XenditInvoice,
  XenditPaymentToken,
  XenditRawEvents,
  XenditRecurringInterval,
  XenditRecurringPlan,
  XenditRefund,
  XenditWebhookEvent,
  isXenditRecurringWebhookEvent,
} from './schema';
import {
  Checkout$inboundSchema,
  Customer$inboundSchema,
  Invoice$inboundSchema,
  Payment$inboundSchema,
  Refund$inboundSchema,
  Subscription$inboundSchema,
} from './utils/mapper';

interface XenditMetadata extends ProviderMetadataRegistry {
  subscription: {
    payment_tokens?: XenditPaymentToken[];
  };
}

export interface XenditOptions extends PaykitProviderOptions {
  /**
   * Xendit secret key, e.g. `xnd_development_...` or `xnd_production_...`
   */
  secretKey: string;
}

const xenditOptionsSchema = schema<XenditOptions>()(
  z.object({
    secretKey: z.string(),
    isSandbox: z.boolean(),
    debug: z.boolean().optional(),
  }),
);

const providerName = 'xendit';

const RECURRING_API_VERSION = '2026-01-01';

const recurringIntervalMap: Record<
  string,
  { interval: XenditRecurringInterval; interval_count: number }
> = {
  day: { interval: 'DAY', interval_count: 1 },
  week: { interval: 'WEEK', interval_count: 1 },
  month: { interval: 'MONTH', interval_count: 1 },
  year: { interval: 'MONTH', interval_count: 12 },
};

export class XenditProvider
  extends AbstractPayKitProvider
  implements
    PayKitProvider<XenditMetadata, HTTPClient, XenditRawEvents>
{
  readonly providerName = providerName;
  private readonly _client: HTTPClient;
  private readonly opts: XenditOptions;
  readonly isSandbox: boolean;

  constructor(opts: XenditOptions) {
    super(xenditOptionsSchema, opts, providerName);

    this.opts = opts;

    this._client = new HTTPClient({
      baseUrl: 'https://api.xendit.co',
      headers: {
        Authorization: `Basic ${Buffer.from(`${opts.secretKey}:`).toString('base64')}`,
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
        | XenditErrorResponse
        | undefined;

      throw new OperationFailedError(
        errorValue?.message ?? 'Xendit request failed',
        this.providerName,
        { cause: new Error(JSON.stringify(result.error)) },
      );
    }

    return result.value as T;
  }

  private async createInvoice(params: {
    email: string;
    amount: number;
    currency: string;
    metadata: Record<string, unknown>;
    successUrl?: string;
    failureUrl?: string;
    providerMetadata?: Record<string, unknown>;
  }): Promise<XenditInvoice> {
    const body = {
      ...params.providerMetadata,
      external_id: crypto.randomUUID(),
      amount: params.amount,
      currency: params.currency,
      payer_email: params.email,
      metadata: params.metadata,
      ...(params.successUrl && {
        success_redirect_url: params.successUrl,
      }),
      ...(params.failureUrl && {
        failure_redirect_url: params.failureUrl,
      }),
    };

    const response = await this._client.post<XenditInvoice>(
      '/v2/invoices/',
      { body: JSON.stringify(body) },
    );

    return this.unwrap(response);
  }

  createCheckout = async (
    params: CreateCheckoutSchema<XenditMetadata['checkout']>,
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

    const metadata = {
      ...stringifyMetadataValues(data.metadata ?? {}),
      [PAYKIT_METADATA_KEY]: JSON.stringify({
        item_id: data.item_id,
        quantity: data.quantity,
        type: data.session_type,
      }),
    };

    const invoice = await this.createInvoice({
      email: data.customer.email,
      amount: Number(amount),
      currency: currency.toUpperCase(),
      metadata,
      successUrl: data.success_url,
      failureUrl: data.cancel_url,
      providerMetadata: data.provider_metadata,
    });

    return Checkout$inboundSchema(invoice);
  };

  retrieveCheckout = async (id: string): Promise<Checkout | null> => {
    const response = await this._client.get<XenditInvoice>(
      `/v2/invoices/${encodeURIComponent(id)}`,
    );

    if (!response.ok || !response.value) return null;

    return Checkout$inboundSchema(response.value);
  };

  updateCheckout = async (
    _id: string,
    _params: UpdateCheckoutSchema<XenditMetadata['checkout']>,
  ): Promise<Checkout> => {
    throw new ProviderNotSupportedError('updateCheckout', 'Xendit', {
      reason:
        'Xendit does not support updating invoices after creation',
      alternative: 'Create a new checkout session instead',
    });
  };

  deleteCheckout = async (id: string): Promise<null> => {
    const response = await this._client.post<XenditInvoice>(
      `/invoices/${encodeURIComponent(id)}/expire!`,
    );

    await this.unwrap(response);

    return null;
  };

  createCustomer = async (
    params: CreateCustomerParams<XenditMetadata['customer']>,
  ): Promise<Customer> => {
    const { error, data } = createCustomerSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createCustomer',
      );
    }

    const { firstName, lastName } = parseCustomerName({
      name: data.name,
      email: data.email,
    });

    const body = {
      ...data.provider_metadata,
      reference_id: crypto.randomUUID(),
      email: data.email,
      individual_detail: {
        given_names: firstName,
        surname: lastName,
      },
      ...(data.phone && { mobile_number: data.phone }),
      metadata: stringifyMetadataValues(data.metadata ?? {}),
    };

    const response = await this._client.post<XenditCustomer>(
      '/customers',
      { body: JSON.stringify(body) },
    );

    const customer = await this.unwrap(response);

    return Customer$inboundSchema(customer);
  };

  retrieveCustomer = async (id: string): Promise<Customer | null> => {
    const response = await this._client.get<XenditCustomer>(
      `/customers/${encodeURIComponent(id)}`,
    );

    if (!response.ok || !response.value) return null;

    return Customer$inboundSchema(response.value);
  };

  updateCustomer = async (
    id: string,
    params: UpdateCustomerParams<XenditMetadata['customer']>,
  ): Promise<Customer> => {
    const { error, data } = updateCustomerSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'updateCustomer',
      );
    }

    const { firstName, lastName } = parseCustomerName({
      name: data.name,
      email: data.email ?? '',
    });

    const body = {
      ...data.provider_metadata,
      ...(data.email && { email: data.email }),
      ...(data.name && {
        individual_detail: {
          given_names: firstName,
          surname: lastName,
        },
      }),
      ...(data.metadata && {
        metadata: stringifyMetadataValues(data.metadata),
      }),
    };

    const response = await this._client.patch<XenditCustomer>(
      `/customers/${encodeURIComponent(id)}`,
      { body: JSON.stringify(body) },
    );

    const customer = await this.unwrap(response);

    return Customer$inboundSchema(customer);
  };

  deleteCustomer = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deleteCustomer', 'Xendit', {
      reason: 'Xendit does not provide a delete-customer API',
    });
  };

  private recurringHeaders = {
    headers: { 'api-version': RECURRING_API_VERSION },
  };

  createSubscription = async (
    params: CreateSubscriptionSchema<XenditMetadata['subscription']>,
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

    if (!isIdCustomer(data.customer)) {
      throw new InvalidTypeError(
        'customer',
        'object with id (a pre-created Xendit customer)',
        'string (email)',
        { provider: this.providerName, method: 'createSubscription' },
      );
    }

    const providerMetadata = data.provider_metadata as
      | { payment_tokens?: XenditPaymentToken[] }
      | undefined;

    if (!providerMetadata?.payment_tokens?.length) {
      throw new ValidationError(
        'Xendit requires at least one payment_tokens entry in provider_metadata to create a recurring plan',
        { provider: this.providerName, method: 'createSubscription' },
      );
    }

    const schedule = recurringIntervalMap[
      typeof data.billing_interval === 'string'
        ? data.billing_interval
        : 'month'
    ] ?? { interval: 'MONTH' as const, interval_count: 1 };

    const body = {
      reference_id: crypto.randomUUID(),
      customer_id: String(data.customer.id),
      currency: data.currency,
      amount: data.amount,
      schedule: {
        interval: schedule.interval,
        interval_count: schedule.interval_count,
        anchor_date: new Date().toISOString(),
      },
      payment_tokens: providerMetadata.payment_tokens,
      description: data.item_id,
      metadata: stringifyMetadataValues(data.metadata ?? {}),
    };

    const response = await this._client.post<XenditRecurringPlan>(
      '/recurring/plans',
      { body: JSON.stringify(body), ...this.recurringHeaders },
    );

    const plan = await this.unwrap(response);

    return Subscription$inboundSchema(plan);
  };

  retrieveSubscription = async (
    id: string,
  ): Promise<Subscription | null> => {
    const response = await this._client.get<XenditRecurringPlan>(
      `/recurring/plans/${encodeURIComponent(id)}`,
      this.recurringHeaders,
    );

    if (!response.ok || !response.value) return null;

    return Subscription$inboundSchema(response.value);
  };

  updateSubscription = async (
    id: string,
    params: UpdateSubscriptionSchema<XenditMetadata['subscription']>,
  ): Promise<Subscription> => {
    const metadata = stringifyMetadataValues(params.metadata ?? {});

    const body = {
      ...(params.provider_metadata ?? {}),
      ...(Object.keys(metadata).length > 0 && { metadata }),
    };

    if (Object.keys(body).length === 0) {
      throw new ValidationError(
        'Xendit requires at least one field (via metadata or provider_metadata) to update a recurring plan',
        { provider: this.providerName, method: 'updateSubscription' },
      );
    }

    const response = await this._client.patch<XenditRecurringPlan>(
      `/recurring/plans/${encodeURIComponent(id)}`,
      { body: JSON.stringify(body), ...this.recurringHeaders },
    );

    const plan = await this.unwrap(response);

    return Subscription$inboundSchema(plan);
  };

  cancelSubscription = async (id: string): Promise<Subscription> => {
    const response = await this._client.post<XenditRecurringPlan>(
      `/recurring/plans/${encodeURIComponent(id)}/deactivate`,
      this.recurringHeaders,
    );

    const plan = await this.unwrap(response);

    return Subscription$inboundSchema(plan);
  };

  deleteSubscription = async (id: string): Promise<null> => {
    await this.cancelSubscription(id);

    return null;
  };

  createPayment = async (
    params: CreatePaymentSchema<XenditMetadata['payment']>,
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

    const { success_url: _successUrl, ...restRaw } =
      (data.provider_metadata as Record<string, unknown>) ?? {};

    const metadata = {
      ...stringifyMetadataValues(data.metadata ?? {}),
      [PAYKIT_METADATA_KEY]: JSON.stringify({
        item_id: data.item_id,
      }),
    };

    if (this.opts.debug) {
      console.info('[Xendit] Creating invoice', {
        email: data.customer.email,
        amount: data.amount,
      });
    }

    const invoice = await this.createInvoice({
      email: data.customer.email,
      amount: data.amount,
      currency: data.currency,
      metadata,
      successUrl: success_url,
      providerMetadata: restRaw,
    });

    return {
      id: invoice.id,
      amount: data.amount,
      currency: data.currency,
      customer: { email: data.customer.email },
      status: 'pending',
      metadata: stringifyMetadataValues(
        data.metadata ?? {},
      ) as Record<string, string>,
      item_id: data.item_id ?? null,
      requires_action: true,
      payment_url: invoice.invoice_url,
    };
  };

  retrievePayment = async (id: string): Promise<Payment | null> => {
    const response = await this._client.get<XenditInvoice>(
      `/v2/invoices/${encodeURIComponent(id)}`,
    );

    if (!response.ok || !response.value) return null;

    return Payment$inboundSchema(response.value);
  };

  updatePayment = async (
    _id: string,
    _params: UpdatePaymentSchema<XenditMetadata['payment']>,
  ): Promise<Payment> => {
    throw new ProviderNotSupportedError('updatePayment', 'Xendit', {
      reason:
        'Xendit does not support updating payments after creation',
    });
  };

  deletePayment = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deletePayment', 'Xendit', {
      reason: 'Xendit does not support deleting payments',
      alternative:
        'Use cancelPayment to expire a pending invoice instead',
    });
  };

  capturePayment = async (
    _id: string,
    _params: CapturePaymentSchema,
  ): Promise<Payment> => {
    throw new ProviderNotSupportedError('capturePayment', 'Xendit', {
      reason:
        'Xendit invoices are auto-settled once paid and do not support manual capture',
    });
  };

  cancelPayment = async (id: string): Promise<Payment> => {
    const response = await this._client.post<XenditInvoice>(
      `/invoices/${encodeURIComponent(id)}/expire!`,
    );

    const invoice = await this.unwrap(response);

    return Payment$inboundSchema(invoice);
  };

  createRefund = async (
    params: CreateRefundSchema<XenditMetadata['refund']>,
  ): Promise<Refund> => {
    const { error, data } = createRefundSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createRefund',
      );
    }

    const matchedReason = data.reason
      ? refundReasonMatcher(data.reason)
      : 'other';

    const reasonMap: Record<string, string> = {
      duplicate: 'DUPLICATE',
      fraudulent: 'FRAUDULENT',
      requested_by_customer: 'REQUESTED_BY_CUSTOMER',
    };

    const body = {
      ...data.provider_metadata,
      invoice_id: data.payment_id,
      amount: data.amount,
      reason: reasonMap[matchedReason] ?? 'OTHERS',
      metadata: stringifyMetadataValues(data.metadata ?? {}),
    };

    const response = await this._client.post<XenditRefund>(
      '/refunds',
      { body: JSON.stringify(body) },
    );

    const refund = await this.unwrap(response);

    return Refund$inboundSchema(refund);
  };

  handleWebhook = async (
    payload: WebhookHandlerConfig,
    webhookSecret: string | null,
  ): Promise<Array<WebhookEventPayload<XenditRawEvents>>> => {
    if (!webhookSecret) {
      throw new WebhookError(
        'webhookSecret (your Callback Verification Token) is required for Xendit webhook verification',
        { provider: this.providerName },
      );
    }

    const { body, headersAsObject } = payload;

    const token = headersAsObject['x-callback-token'];

    if (!token) {
      throw new WebhookError('Missing x-callback-token header', {
        provider: this.providerName,
      });
    }

    if (!this.safeStringEqual(token, webhookSecret)) {
      throw new WebhookError(
        'Invalid Xendit webhook callback token',
        {
          provider: this.providerName,
        },
      );
    }

    let event: XenditWebhookEvent;

    try {
      event = JSON.parse(body) as XenditWebhookEvent;
    } catch {
      throw new WebhookError(
        'Invalid webhook payload: not valid JSON',
        { provider: this.providerName },
      );
    }

    const results: Array<WebhookEventPayload<XenditRawEvents>> = [];

    const rawType = isXenditRecurringWebhookEvent(event)
      ? `xendit.${event.event}`
      : `xendit.invoice.${(event as XenditInvoice).status.toLowerCase()}`;
    const created = isXenditRecurringWebhookEvent(event)
      ? Math.floor(new Date(event.created).getTime() / 1000)
      : Math.floor(
          new Date((event as XenditInvoice).updated).getTime() / 1000,
        );

    const contentHash = hashWebhookPayload(rawType, body);

    results.push({
      id: `xendit:${rawType}:${contentHash}`,
      type: rawType as keyof XenditRawEvents,
      created,
      data: event as any,
      is_raw: true,
    });

    const standardEvents = this.mapToStandardEvents(
      event,
      created,
      contentHash,
    );

    if (standardEvents) results.push(...standardEvents);

    return results;
  };

  private safeStringEqual(
    received: string,
    expected: string,
  ): boolean {
    try {
      const receivedBuf = Buffer.from(received);
      const expectedBuf = Buffer.from(expected);

      return (
        receivedBuf.length === expectedBuf.length &&
        timingSafeEqual(receivedBuf, expectedBuf)
      );
    } catch {
      return false;
    }
  }

  private mapToStandardEvents = (
    event: XenditWebhookEvent,
    created: number,
    contentHash: string,
  ): Array<WebhookEventPayload> | null => {
    const id = `paykit:${contentHash}`;

    if (isXenditRecurringWebhookEvent(event)) {
      if (event.event === 'recurring.plan.activated') {
        return [
          paykitEvent$InboundSchema({
            type: 'subscription.updated',
            created,
            id,
            data: Subscription$inboundSchema(event.data),
          }),
        ];
      }

      if (event.event === 'recurring.plan.inactivated') {
        return [
          paykitEvent$InboundSchema({
            type: 'subscription.canceled',
            created,
            id,
            data: Subscription$inboundSchema(event.data),
          }),
        ];
      }

      if (
        event.event === 'recurring.cycle.succeeded' ||
        event.event === 'recurring.cycle.failed'
      ) {
        const cycle = event.data;

        const payment: Payment = {
          id: cycle.id,
          amount: cycle.amount,
          currency: cycle.currency,
          customer: cycle.customer_id
            ? { id: cycle.customer_id }
            : null,
          status:
            event.event === 'recurring.cycle.succeeded'
              ? 'succeeded'
              : 'failed',
          metadata: {},
          item_id: null,
          requires_action: false,
          payment_url: null,
        };

        if (event.event === 'recurring.cycle.failed') {
          return [
            paykitEvent$InboundSchema({
              type: 'payment.failed',
              created,
              id,
              data: payment,
            }),
          ];
        }

        const invoice: Invoice = {
          id: cycle.id,
          customer: cycle.customer_id
            ? { id: cycle.customer_id }
            : null,
          subscription_id: cycle.plan_id ?? null,
          billing_mode: 'recurring',
          amount_paid: cycle.amount,
          currency: cycle.currency,
          status: 'paid',
          paid_at: cycle.updated ?? cycle.created ?? null,
          line_items: null,
          metadata: null,
          custom_fields: null,
        };

        return [
          paykitEvent$InboundSchema({
            type: 'payment.succeeded',
            created,
            id,
            data: payment,
          }),
          paykitEvent$InboundSchema({
            type: 'invoice.generated',
            created,
            id: `${id}-invoice`,
            data: invoice,
          }),
        ];
      }

      // recurring.cycle.created / recurring.cycle.retrying are
      // transitional states with no standard PayKit equivalent -
      // available as raw events only.
      if (this.opts.debug) {
        console.info(
          `[Xendit] No standard mapping for event: ${event.event}. Available as raw event.`,
        );
      }
      return null;
    }

    const invoice = event as XenditInvoice;

    if (invoice.status === 'PAID' || invoice.status === 'SETTLED') {
      return [
        paykitEvent$InboundSchema({
          type: 'payment.succeeded',
          created,
          id,
          data: Payment$inboundSchema(invoice),
        }),
        paykitEvent$InboundSchema({
          type: 'invoice.generated',
          created,
          id: `${id}-invoice`,
          data: Invoice$inboundSchema(invoice),
        }),
      ];
    }

    if (invoice.status === 'EXPIRED') {
      return [
        paykitEvent$InboundSchema({
          type: 'payment.failed',
          created,
          id,
          data: Payment$inboundSchema(invoice),
        }),
      ];
    }

    if (invoice.status === 'PENDING') {
      return [
        paykitEvent$InboundSchema({
          type: 'payment.created',
          created,
          id,
          data: Payment$inboundSchema(invoice),
        }),
      ];
    }

    return null;
  };
}
