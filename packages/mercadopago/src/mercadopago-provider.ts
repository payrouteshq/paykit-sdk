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
  MercadoPagoAuthorizedPayment,
  MercadoPagoCustomer,
  MercadoPagoErrorResponse,
  MercadoPagoPayment,
  MercadoPagoPreApproval,
  MercadoPagoPreference,
  MercadoPagoRawEvents,
  MercadoPagoRefund,
  MercadoPagoWebhookEvent,
} from './schema';
import {
  Checkout$inboundSchema,
  Customer$inboundSchema,
  Invoice$inboundSchema,
  Payment$inboundSchema,
  Refund$inboundSchema,
  Subscription$inboundSchema,
} from './utils/mapper';

interface MercadoPagoMetadata extends ProviderMetadataRegistry {}

export interface MercadoPagoOptions extends PaykitProviderOptions {
  /**
   * Mercado Pago access token, e.g. `APP_USR-...` (production) or
   * `TEST-...` (sandbox)
   */
  accessToken: string;
}

const mercadoPagoOptionsSchema = schema<MercadoPagoOptions>()(
  z.object({
    accessToken: z.string(),
    isSandbox: z.boolean(),
    debug: z.boolean().optional(),
  }),
);

const providerName = 'mercadopago';

export class MercadoPagoProvider
  extends AbstractPayKitProvider
  implements
    PayKitProvider<
      MercadoPagoMetadata,
      HTTPClient,
      MercadoPagoRawEvents
    >
{
  readonly providerName = providerName;
  private readonly _client: HTTPClient;
  private readonly opts: MercadoPagoOptions;
  readonly isSandbox: boolean;

  constructor(opts: MercadoPagoOptions) {
    super(mercadoPagoOptionsSchema, opts, providerName);

    this.opts = opts;

    this._client = new HTTPClient({
      baseUrl: 'https://api.mercadopago.com',
      headers: {
        Authorization: `Bearer ${opts.accessToken}`,
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
        | MercadoPagoErrorResponse
        | undefined;

      throw new OperationFailedError(
        errorValue?.message ?? 'Mercado Pago request failed',
        this.providerName,
        { cause: new Error(JSON.stringify(result.error)) },
      );
    }

    return result.value as T;
  }

  /**
   * Mercado Pago has one way to charge a customer without a saved card
   * token: Checkout Pro preferences. createCheckout and createPayment
   * both boil down to this same call - only the input validation and the
   * response mapper differ.
   */
  private async createPreference(params: {
    email: string;
    amount: number;
    currency: string;
    itemId: string;
    quantity: number;
    metadata: Record<string, unknown>;
    successUrl?: string;
    failureUrl?: string;
    providerMetadata?: Record<string, unknown>;
  }): Promise<MercadoPagoPreference> {
    const body = {
      // Spread first so provider_metadata can only add extra
      // Mercado Pago-specific fields - it must never silently override
      // the normalized fields computed below.
      ...params.providerMetadata,
      items: [
        {
          id: params.itemId,
          title: params.itemId,
          quantity: params.quantity,
          unit_price: params.amount,
          currency_id: params.currency,
        },
      ],
      payer: { email: params.email },
      metadata: params.metadata,
      ...((params.successUrl || params.failureUrl) && {
        back_urls: {
          ...(params.successUrl && {
            success: params.successUrl,
            pending: params.successUrl,
          }),
          ...(params.failureUrl && { failure: params.failureUrl }),
        },
        ...(params.successUrl && { auto_return: 'approved' }),
      }),
    };

    const response = await this._client.post<MercadoPagoPreference>(
      '/checkout/preferences/',
      { body: JSON.stringify(body) },
    );

    return this.unwrap(response);
  }

  createCheckout = async (
    params: CreateCheckoutSchema<MercadoPagoMetadata['checkout']>,
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

    const preference = await this.createPreference({
      email: data.customer.email,
      amount: Number(amount),
      currency: currency.toUpperCase(),
      itemId: data.item_id,
      quantity: data.quantity,
      metadata,
      successUrl: data.success_url,
      failureUrl: data.cancel_url,
      providerMetadata: data.provider_metadata,
    });

    return Checkout$inboundSchema(preference);
  };

  retrieveCheckout = async (id: string): Promise<Checkout | null> => {
    const response = await this._client.get<MercadoPagoPreference>(
      `/checkout/preferences/${encodeURIComponent(id)}`,
    );

    if (!response.ok || !response.value) return null;

    return Checkout$inboundSchema(response.value);
  };

  updateCheckout = async (
    id: string,
    params: UpdateCheckoutSchema<MercadoPagoMetadata['checkout']>,
  ): Promise<Checkout> => {
    // success_url/cancel_url only exist on the one_time branch of the
    // create-checkout union; cast defensively since an update payload is a
    // partial of that union and may carry either shape.
    const data = params as Partial<
      CreateCheckoutSchema<MercadoPagoMetadata['checkout']>
    > & { success_url?: string; cancel_url?: string };

    const body: Record<string, unknown> = {
      ...(data.provider_metadata ?? {}),
    };

    if (data.metadata) {
      body.metadata = stringifyMetadataValues(data.metadata);
    }

    if (data.success_url || data.cancel_url) {
      body.back_urls = {
        ...(data.success_url && {
          success: data.success_url,
          pending: data.success_url,
        }),
        ...(data.cancel_url && { failure: data.cancel_url }),
      };
    }

    if (data.item_id) {
      const { amount } = validateRequiredKeys(
        ['amount'],
        (data.provider_metadata as Record<string, string>) ?? {},
        'Updating item_id requires amount in provider_metadata: {keys}',
      );

      body.items = [
        {
          id: data.item_id,
          title: data.item_id,
          quantity: data.quantity ?? 1,
          unit_price: Number(amount),
        },
      ];
    }

    if (Object.keys(body).length === 0) {
      throw new ValidationError(
        'Mercado Pago requires at least one field to update a preference',
        { provider: this.providerName, method: 'updateCheckout' },
      );
    }

    const response = await this._client.put<MercadoPagoPreference>(
      `/checkout/preferences/${encodeURIComponent(id)}`,
      { body: JSON.stringify(body) },
    );

    const preference = await this.unwrap(response);

    return Checkout$inboundSchema(preference);
  };

  deleteCheckout = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deleteCheckout',
      'Mercado Pago',
      {
        reason: 'Mercado Pago does not support deleting preferences',
      },
    );
  };

  createCustomer = async (
    params: CreateCustomerParams<MercadoPagoMetadata['customer']>,
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
      email: data.email,
      first_name: firstName,
      last_name: lastName,
      ...(data.phone && { phone: { number: data.phone } }),
      metadata: stringifyMetadataValues(data.metadata ?? {}),
    };

    const response = await this._client.post<MercadoPagoCustomer>(
      '/v1/customers',
      { body: JSON.stringify(body) },
    );

    const customer = await this.unwrap(response);

    return Customer$inboundSchema(customer);
  };

  retrieveCustomer = async (id: string): Promise<Customer | null> => {
    const response = await this._client.get<MercadoPagoCustomer>(
      `/v1/customers/${encodeURIComponent(id)}`,
    );

    if (!response.ok || !response.value) return null;

    return Customer$inboundSchema(response.value);
  };

  updateCustomer = async (
    id: string,
    params: UpdateCustomerParams<MercadoPagoMetadata['customer']>,
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
      ...(data.email && { email: data.email }),
      ...(data.name && {
        first_name: parseCustomerName({
          name: data.name,
          email: data.email ?? '',
        }).firstName,
        last_name: parseCustomerName({
          name: data.name,
          email: data.email ?? '',
        }).lastName,
      }),
      ...(data.metadata && {
        metadata: stringifyMetadataValues(data.metadata),
      }),
    };

    const response = await this._client.put<MercadoPagoCustomer>(
      `/v1/customers/${encodeURIComponent(id)}`,
      { body: JSON.stringify(body) },
    );

    const customer = await this.unwrap(response);

    return Customer$inboundSchema(customer);
  };

  deleteCustomer = async (id: string): Promise<null> => {
    const response = await this._client.delete<MercadoPagoCustomer>(
      `/v1/customers/${encodeURIComponent(id)}`,
    );

    await this.unwrap(response);

    return null;
  };

  createSubscription = async (
    params: CreateSubscriptionSchema<
      MercadoPagoMetadata['subscription']
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

    if (!isEmailCustomer(data.customer)) {
      throw new InvalidTypeError(
        'customer',
        'object with email',
        'string (customer ID)',
        { provider: this.providerName, method: 'createSubscription' },
      );
    }

    const metadata = stringifyMetadataValues(data.metadata ?? {});

    const body = {
      ...data.provider_metadata,
      preapproval_plan_id: data.item_id,
      payer_email: data.customer.email,
      ...(Object.keys(metadata).length > 0 && {
        external_reference: JSON.stringify(metadata),
      }),
    };

    const response = await this._client.post<MercadoPagoPreApproval>(
      '/preapproval/',
      { body: JSON.stringify(body) },
    );

    const subscription = await this.unwrap(response);

    return Subscription$inboundSchema(subscription);
  };

  retrieveSubscription = async (
    id: string,
  ): Promise<Subscription | null> => {
    const response = await this._client.get<MercadoPagoPreApproval>(
      `/preapproval/${encodeURIComponent(id)}`,
    );

    if (!response.ok || !response.value) return null;

    return Subscription$inboundSchema(response.value);
  };

  updateSubscription = async (
    id: string,
    params: UpdateSubscriptionSchema<
      MercadoPagoMetadata['subscription']
    >,
  ): Promise<Subscription> => {
    const metadata = stringifyMetadataValues(params.metadata ?? {});

    const body = {
      ...(params.provider_metadata ?? {}),
      ...(Object.keys(metadata).length > 0 && {
        external_reference: JSON.stringify(metadata),
      }),
    };

    if (Object.keys(body).length === 0) {
      throw new ValidationError(
        'Mercado Pago requires at least one field (via metadata or provider_metadata) to update a subscription',
        { provider: this.providerName, method: 'updateSubscription' },
      );
    }

    const response = await this._client.put<MercadoPagoPreApproval>(
      `/preapproval/${encodeURIComponent(id)}`,
      { body: JSON.stringify(body) },
    );

    const subscription = await this.unwrap(response);

    return Subscription$inboundSchema(subscription);
  };

  cancelSubscription = async (id: string): Promise<Subscription> => {
    const response = await this._client.put<MercadoPagoPreApproval>(
      `/preapproval/${encodeURIComponent(id)}`,
      { body: JSON.stringify({ status: 'cancelled' }) },
    );

    const subscription = await this.unwrap(response);

    return Subscription$inboundSchema(subscription);
  };

  deleteSubscription = async (id: string): Promise<null> => {
    await this.cancelSubscription(id);

    return null;
  };

  createPayment = async (
    params: CreatePaymentSchema<MercadoPagoMetadata['payment']>,
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

    const { success_url, ...restProviderMetadata } =
      validateRequiredKeys(
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
      console.info('[Mercado Pago] Creating preference', {
        email: data.customer.email,
        amount: data.amount,
      });
    }

    const preference = await this.createPreference({
      email: data.customer.email,
      amount: data.amount,
      currency: data.currency,
      itemId: data.item_id ?? 'payment',
      quantity: 1,
      metadata,
      successUrl: success_url,
      providerMetadata: restRaw,
    });

    return {
      id: preference.id,
      amount: data.amount,
      currency: data.currency,
      customer: { email: data.customer.email },
      status: 'pending',
      metadata: stringifyMetadataValues(
        data.metadata ?? {},
      ) as Record<string, string>,
      item_id: data.item_id ?? null,
      requires_action: true,
      payment_url:
        preference.init_point ??
        preference.sandbox_init_point ??
        null,
    };
  };

  retrievePayment = async (id: string): Promise<Payment | null> => {
    const response = await this._client.get<MercadoPagoPayment>(
      `/v1/payments/${encodeURIComponent(id)}`,
    );

    if (!response.ok || !response.value) return null;

    return Payment$inboundSchema(response.value);
  };

  updatePayment = async (
    _id: string,
    _params: UpdatePaymentSchema<MercadoPagoMetadata['payment']>,
  ): Promise<Payment> => {
    throw new ProviderNotSupportedError(
      'updatePayment',
      'Mercado Pago',
      {
        reason:
          'Mercado Pago only supports capturing or canceling a payment after creation',
      },
    );
  };

  deletePayment = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deletePayment',
      'Mercado Pago',
      { reason: 'Mercado Pago does not support deleting payments' },
    );
  };

  capturePayment = async (
    id: string,
    params: CapturePaymentSchema,
  ): Promise<Payment> => {
    const response = await this._client.put<MercadoPagoPayment>(
      `/v1/payments/${encodeURIComponent(id)}`,
      {
        body: JSON.stringify({
          capture: true,
          transaction_amount: params.amount,
        }),
      },
    );

    const payment = await this.unwrap(response);

    return Payment$inboundSchema(payment);
  };

  cancelPayment = async (id: string): Promise<Payment> => {
    const response = await this._client.put<MercadoPagoPayment>(
      `/v1/payments/${encodeURIComponent(id)}`,
      { body: JSON.stringify({ status: 'cancelled' }) },
    );

    const payment = await this.unwrap(response);

    return Payment$inboundSchema(payment);
  };

  createRefund = async (
    params: CreateRefundSchema<MercadoPagoMetadata['refund']>,
  ): Promise<Refund> => {
    const { error, data } = createRefundSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createRefund',
      );
    }

    const paymentResponse =
      await this._client.get<MercadoPagoPayment>(
        `/v1/payments/${encodeURIComponent(data.payment_id)}`,
      );
    const payment = await this.unwrap(paymentResponse);

    const body = {
      // Escape hatch fields go in first so they can only add extra
      // Mercado Pago-specific params - they must never override the
      // authoritative amount set below.
      ...data.provider_metadata,
      amount: data.amount,
    };

    const response = await this._client.post<MercadoPagoRefund>(
      `/v1/payments/${encodeURIComponent(data.payment_id)}/refunds`,
      { body: JSON.stringify(body) },
    );

    const refund = await this.unwrap(response);

    return Refund$inboundSchema(refund, {
      currency: payment.currency_id,
      reason: data.reason,
    });
  };

  handleWebhook = async (
    payload: WebhookHandlerConfig,
    webhookSecret: string | null,
  ): Promise<Array<WebhookEventPayload<MercadoPagoRawEvents>>> => {
    if (!webhookSecret) {
      throw new WebhookError(
        'webhookSecret is required for Mercado Pago webhook verification',
        { provider: this.providerName },
      );
    }

    const { body, headersAsObject, fullUrl } = payload;

    const signatureHeader = headersAsObject['x-signature'];
    const requestId = headersAsObject['x-request-id'];

    if (!signatureHeader) {
      throw new WebhookError('Missing x-signature header', {
        provider: this.providerName,
      });
    }

    const { ts, v1 } = this.parseSignatureHeader(signatureHeader);

    if (!ts || !v1) {
      throw new WebhookError(
        'Malformed x-signature header: expected "ts=...,v1=..."',
        { provider: this.providerName },
      );
    }

    const dataId = new URL(fullUrl).searchParams.get('data.id');

    const manifestParts: string[] = [];
    if (dataId) manifestParts.push(`id:${dataId}`);
    if (requestId) manifestParts.push(`request-id:${requestId}`);
    manifestParts.push(`ts:${ts}`);
    const manifest = manifestParts.join(';') + ';';

    const expected = createHmac('sha256', webhookSecret)
      .update(manifest)
      .digest('hex');

    if (!this.safeHexEqual(v1, expected)) {
      throw new WebhookError(
        'Invalid Mercado Pago webhook signature',
        { provider: this.providerName },
      );
    }

    let event: MercadoPagoWebhookEvent;

    try {
      event = JSON.parse(body) as MercadoPagoWebhookEvent;
    } catch {
      throw new WebhookError(
        'Invalid webhook payload: not valid JSON',
        { provider: this.providerName },
      );
    }

    const results: Array<WebhookEventPayload<MercadoPagoRawEvents>> =
      [];

    const contentHash = hashWebhookPayload(event.action, body);

    results.push({
      id: `mercadopago:${event.action}:${contentHash}`,
      type: `mercadopago.${event.action}`,
      created: Math.floor(
        new Date(event.date_created).getTime() / 1000,
      ),
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

  private parseSignatureHeader(header: string): {
    ts?: string;
    v1?: string;
  } {
    const result: { ts?: string; v1?: string } = {};

    for (const part of header.split(',')) {
      const eq = part.indexOf('=');
      if (eq === -1) continue;
      const key = part.substring(0, eq).trim().toLowerCase();
      const value = part.substring(eq + 1).trim();
      if (key === 'ts') result.ts = value;
      if (key === 'v1') result.v1 = value;
    }

    return result;
  }

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
    event: MercadoPagoWebhookEvent,
    contentHash: string,
  ): Promise<Array<WebhookEventPayload> | null> => {
    const created = Math.floor(
      new Date(event.date_created).getTime() / 1000,
    );
    const id = `paykit:${event.action}:${contentHash}`;

    if (event.type === 'payment') {
      const response = await this._client.get<MercadoPagoPayment>(
        `/v1/payments/${encodeURIComponent(event.data.id)}`,
      );
      if (!response.ok || !response.value) return null;
      const payment = response.value;

      if (event.action === 'payment.created') {
        return [
          paykitEvent$InboundSchema({
            type: 'payment.created',
            created,
            id,
            data: Payment$inboundSchema(payment),
          }),
        ];
      }

      if (payment.status === 'approved') {
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

      if (
        payment.status === 'rejected' ||
        payment.status === 'cancelled'
      ) {
        return [
          paykitEvent$InboundSchema({
            type: 'payment.failed',
            created,
            id,
            data: Payment$inboundSchema(payment),
          }),
        ];
      }

      if (payment.status === 'refunded' && payment.refunds?.length) {
        const latestRefund =
          payment.refunds[payment.refunds.length - 1];

        return [
          paykitEvent$InboundSchema({
            type: 'refund.created',
            created,
            id,
            data: Refund$inboundSchema(latestRefund, {
              currency: payment.currency_id,
              reason: null,
            }),
          }),
        ];
      }

      return [
        paykitEvent$InboundSchema({
          type: 'payment.updated',
          created,
          id,
          data: Payment$inboundSchema(payment),
        }),
      ];
    }

    if (event.type === 'subscription_preapproval') {
      const response = await this._client.get<MercadoPagoPreApproval>(
        `/preapproval/${encodeURIComponent(event.data.id)}`,
      );
      if (!response.ok || !response.value) return null;
      const subscription = response.value;

      if (event.action === 'subscription_preapproval.created') {
        return [
          paykitEvent$InboundSchema({
            type: 'subscription.created',
            created,
            id,
            data: Subscription$inboundSchema(subscription),
          }),
        ];
      }

      if (subscription.status === 'cancelled') {
        return [
          paykitEvent$InboundSchema({
            type: 'subscription.canceled',
            created,
            id,
            data: Subscription$inboundSchema(subscription),
          }),
        ];
      }

      return [
        paykitEvent$InboundSchema({
          type: 'subscription.updated',
          created,
          id,
          data: Subscription$inboundSchema(subscription),
        }),
      ];
    }

    if (event.type === 'subscription_authorized_payment') {
      const response =
        await this._client.get<MercadoPagoAuthorizedPayment>(
          `/authorized_payments/${encodeURIComponent(event.data.id)}`,
        );
      if (
        !response.ok ||
        !response.value ||
        !response.value.payment
      ) {
        return null;
      }

      const authorizedPayment = response.value;
      const paymentStatus = authorizedPayment.payment!.status;

      if (
        paymentStatus !== 'approved' &&
        paymentStatus !== 'rejected'
      ) {
        return null;
      }

      const paymentResponse =
        await this._client.get<MercadoPagoPayment>(
          `/v1/payments/${authorizedPayment.payment!.id}`,
        );
      if (!paymentResponse.ok || !paymentResponse.value) return null;
      const payment = paymentResponse.value;

      if (paymentStatus === 'approved') {
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

      return [
        paykitEvent$InboundSchema({
          type: 'payment.failed',
          created,
          id,
          data: Payment$inboundSchema(payment),
        }),
      ];
    }

    if (this.opts.debug) {
      console.info(
        `[Mercado Pago] No standard mapping for event: ${event.type}/${event.action}. Available as raw event.`,
      );
    }

    return null;
  };
}
