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
  createPaymentSchema,
  createRefundSchema,
  hashWebhookPayload,
  isEmailCustomer,
  paykitEvent$InboundSchema,
  schema,
  stringifyMetadataValues,
  validateRequiredKeys,
} from '@paykit-sdk/core';
import { createHmac, timingSafeEqual } from 'crypto';
import { z } from 'zod';
import {
  ChapaRefund,
  ChapaRawEvents,
  ChapaResponse,
  ChapaTransaction,
  ChapaInitializeResponse,
  ChapaWebhookEvent,
  isChapaTransactionEvent,
} from './schema';
import {
  Checkout$inboundSchema,
  Invoice$inboundSchema,
  Payment$inboundSchema,
  Refund$inboundSchema,
  RefundFromTransaction$inboundSchema,
} from './utils/mapper';

interface ChapaMetadata extends ProviderMetadataRegistry {
  refund: {
    reference?: string;
  };
  checkout?: {
    amount?: string;
    currency?: string;
  };
}

export interface ChapaOptions extends PaykitProviderOptions {
  /**
   * Chapa secret key
   */
  secretKey: string;
}

const chapaOptionsSchema = schema<ChapaOptions>()(
  z.object({
    secretKey: z.string(),
    isSandbox: z.boolean(),
    debug: z.boolean().optional(),
  }),
);

const providerName = 'chapa';

export class ChapaProvider
  extends AbstractPayKitProvider
  implements PayKitProvider<ChapaMetadata, HTTPClient, ChapaRawEvents>
{
  readonly providerName = providerName;
  private readonly _client: HTTPClient;
  private readonly opts: ChapaOptions;
  readonly isSandbox: boolean;

  constructor(opts: ChapaOptions) {
    super(chapaOptionsSchema, opts, providerName);

    this.opts = opts;

    this._client = new HTTPClient({
      baseUrl: 'https://api.chapa.co/v1',
      headers: {
        Authorization: `Bearer ${opts.secretKey}`,
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

  private async unwrap<T>(
    result: {
      ok: boolean;
      value?: ChapaResponse<T>;
      error?: unknown;
    },
    operation: string,
  ): Promise<T> {
    if (!result.ok || result.value?.status !== 'success') {
      throw new OperationFailedError(operation, this.providerName, {
        cause: new Error(
          result.value?.message ??
            JSON.stringify(result.error) ??
            'Unknown error',
        ),
      });
    }

    return result.value.data as T;
  }

  /**
   * Chapa has one way to charge a customer: POST /transaction/initialize.
   * createCheckout and createPayment both boil down to this same call -
   * only the input validation and the response mapper differ.
   */
  private async initializeTransaction(params: {
    email: string;
    amount: string;
    currency: string;
    txRef: string;
    meta: Record<string, unknown>;
    returnUrl?: string;
    providerMetadata?: Record<string, unknown>;
  }): Promise<ChapaInitializeResponse> {
    const body = {
      // Spread first so provider_metadata can only add extra Chapa-specific
      // fields (customization, callback_url, phone_number, ...) - it must
      // never silently override the normalized fields computed below.
      ...params.providerMetadata,
      amount: params.amount,
      currency: params.currency,
      email: params.email,
      tx_ref: params.txRef,
      ...(params.returnUrl && { return_url: params.returnUrl }),
      meta: params.meta,
    };

    const response = await this._client.post<
      ChapaResponse<ChapaInitializeResponse>
    >('/transaction/initialize', { body: JSON.stringify(body) });

    return this.unwrap(response, 'initializeTransaction');
  }

  createCheckout = async (
    params: CreateCheckoutSchema<ChapaMetadata['checkout']>,
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
        {
          provider: this.providerName,
          method: 'createCheckout',
        },
      );
    }

    const { amount, currency } = validateRequiredKeys(
      ['amount', 'currency'],
      (data.provider_metadata as Record<string, string>) ?? {},
      'Missing required provider metadata: {keys}',
    );

    const meta = {
      ...stringifyMetadataValues(data.metadata ?? {}),
      [PAYKIT_METADATA_KEY]: JSON.stringify({
        item_id: data.item_id,
        quantity: data.quantity,
        type: data.session_type,
      }),
    };

    const txRef = crypto.randomUUID();
    const upperCurrency = currency.toUpperCase();

    const initData = await this.initializeTransaction({
      email: data.customer.email,
      amount,
      currency: upperCurrency,
      txRef,
      meta,
      returnUrl: data.success_url,
      providerMetadata: data.provider_metadata,
    });

    return Checkout$inboundSchema(
      { checkout_url: initData.checkout_url, tx_ref: txRef },
      {
        amount: parseFloat(amount),
        currency: upperCurrency,
        email: data.customer.email,
        meta,
      } satisfies Omit<
        Partial<ChapaTransaction>,
        'amount' | 'currency'
      > & {
        amount: number;
        currency: string;
      },
    );
  };

  retrieveCheckout = async (id: string): Promise<Checkout | null> => {
    const response = await this._client.get<
      ChapaResponse<ChapaTransaction>
    >(`/transaction/verify/${encodeURIComponent(id)}`);

    if (!response.ok || !response.value?.data) return null;

    const txn = response.value.data;

    return Checkout$inboundSchema(
      { checkout_url: null, tx_ref: txn.tx_ref },
      txn,
    );
  };

  updateCheckout = async (
    _id: string,
    _params: UpdateCheckoutSchema<ChapaMetadata['checkout']>,
  ): Promise<Checkout> => {
    throw new ProviderNotSupportedError('updateCheckout', 'Chapa', {
      reason: 'Chapa does not support updating checkout sessions',
      alternative: 'Create a new checkout session instead',
    });
  };

  deleteCheckout = async (id: string): Promise<null> => {
    const response = await this._client.put<ChapaResponse<unknown>>(
      `/transaction/cancel/${encodeURIComponent(id)}`,
    );

    await this.unwrap(response, 'deleteCheckout');

    return null;
  };

  createCustomer = async (
    _params: CreateCustomerParams<ChapaMetadata['customer']>,
  ): Promise<Customer> => {
    throw new ProviderNotSupportedError('createCustomer', 'Chapa', {
      reason:
        'Chapa does not provide a customer management API; customer details are captured inline with each transaction',
    });
  };

  retrieveCustomer = async (
    _id: string,
  ): Promise<Customer | null> => {
    throw new ProviderNotSupportedError('retrieveCustomer', 'Chapa', {
      reason: 'Chapa does not provide a customer management API',
    });
  };

  updateCustomer = async (
    _id: string,
    _params: UpdateCustomerParams<ChapaMetadata['customer']>,
  ): Promise<Customer> => {
    throw new ProviderNotSupportedError('updateCustomer', 'Chapa', {
      reason: 'Chapa does not provide a customer management API',
    });
  };

  deleteCustomer = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deleteCustomer', 'Chapa', {
      reason: 'Chapa does not provide a customer management API',
    });
  };

  createSubscription = async (
    _params: CreateSubscriptionSchema<ChapaMetadata['subscription']>,
  ): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'createSubscription',
      'Chapa',
      {
        reason: 'Chapa does not support subscriptions',
      },
    );
  };

  retrieveSubscription = async (
    _id: string,
  ): Promise<Subscription | null> => {
    throw new ProviderNotSupportedError(
      'retrieveSubscription',
      'Chapa',
      {
        reason: 'Chapa does not support subscriptions',
      },
    );
  };

  updateSubscription = async (
    _id: string,
    _params: UpdateSubscriptionSchema<ChapaMetadata['subscription']>,
  ): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'updateSubscription',
      'Chapa',
      {
        reason: 'Chapa does not support subscriptions',
      },
    );
  };

  cancelSubscription = async (_id: string): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'cancelSubscription',
      'Chapa',
      {
        reason: 'Chapa does not support subscriptions',
      },
    );
  };

  deleteSubscription = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deleteSubscription',
      'Chapa',
      {
        reason: 'Chapa does not support subscriptions',
      },
    );
  };

  createPayment = async (
    params: CreatePaymentSchema<ChapaMetadata['payment']>,
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
        {
          provider: this.providerName,
          method: 'createPayment',
        },
      );
    }

    const meta = {
      ...stringifyMetadataValues(data.metadata ?? {}),
      [PAYKIT_METADATA_KEY]: JSON.stringify({
        item_id: data.item_id,
      }),
    };

    const txRef = crypto.randomUUID();

    if (this.opts.debug) {
      console.info('[Chapa] Initializing transaction', {
        email: data.customer.email,
        amount: data.amount,
      });
    }

    const initData = await this.initializeTransaction({
      email: data.customer.email,
      amount: data.amount.toString(),
      currency: data.currency,
      txRef,
      meta,
      providerMetadata: data.provider_metadata,
    });

    return {
      id: txRef,
      amount: data.amount,
      currency: data.currency,
      customer: { email: data.customer.email },
      status: 'pending',
      metadata: stringifyMetadataValues(
        data.metadata ?? {},
      ) as Record<string, string>,
      item_id: data.item_id ?? null,
      requires_action: true,
      payment_url: initData.checkout_url,
    };
  };

  retrievePayment = async (id: string): Promise<Payment | null> => {
    const response = await this._client.get<
      ChapaResponse<ChapaTransaction>
    >(`/transaction/verify/${encodeURIComponent(id)}`);

    if (!response.ok || !response.value?.data) return null;

    return Payment$inboundSchema(response.value.data);
  };

  updatePayment = async (
    _id: string,
    _params: UpdatePaymentSchema<ChapaMetadata['payment']>,
  ): Promise<Payment> => {
    throw new ProviderNotSupportedError('updatePayment', 'Chapa', {
      reason:
        'Chapa does not support updating transactions after initialization',
    });
  };

  deletePayment = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deletePayment', 'Chapa', {
      reason: 'Chapa does not support deleting transactions',
      alternative:
        'Use cancelPayment to cancel an active transaction instead',
    });
  };

  capturePayment = async (
    _id: string,
    _params: CapturePaymentSchema,
  ): Promise<Payment> => {
    throw new ProviderNotSupportedError('capturePayment', 'Chapa', {
      reason:
        'Chapa transactions are charged immediately and do not support manual capture',
    });
  };

  cancelPayment = async (id: string): Promise<Payment> => {
    const existing = await this.retrievePayment(id);

    if (!existing) {
      throw new ResourceNotFoundError(
        'payment',
        id,
        this.providerName,
      );
    }

    const response = await this._client.put<ChapaResponse<unknown>>(
      `/transaction/cancel/${encodeURIComponent(id)}`,
    );

    await this.unwrap(response, 'cancelPayment');

    return { ...existing, status: 'canceled' };
  };

  createRefund = async (
    params: CreateRefundSchema<ChapaMetadata['refund']>,
  ): Promise<Refund> => {
    const { error, data } = createRefundSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createRefund',
      );
    }

    const form = new URLSearchParams();

    // Escape hatch fields go in first so they can only add extra Chapa-specific
    // params - they must never override the authoritative fields set below.
    if (data.provider_metadata) {
      for (const [key, value] of Object.entries(
        data.provider_metadata as Record<string, unknown>,
      )) {
        form.set(key, String(value));
      }
    }

    form.set('amount', data.amount.toString());

    if (data.reason) form.set('reason', data.reason);

    const meta = stringifyMetadataValues(data.metadata ?? {});
    for (const [key, value] of Object.entries(meta)) {
      form.set(`meta[${key}]`, value);
    }

    const response = await this._client.post<
      ChapaResponse<Partial<ChapaRefund>>
    >(`/refund/${encodeURIComponent(data.payment_id)}`, {
      body: form.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    const refund = await this.unwrap(response, 'createRefund');

    return Refund$inboundSchema(refund ?? {}, {
      paymentId: data.payment_id,
      amount: data.amount,
      currency: 'ETB',
      reason: data.reason,
    });
  };

  handleWebhook = async (
    payload: WebhookHandlerConfig,
    webhookSecret: string | null,
  ): Promise<Array<WebhookEventPayload<ChapaRawEvents>>> => {
    if (!webhookSecret) {
      throw new WebhookError(
        'webhookSecret is required for Chapa webhook verification',
        {
          provider: this.providerName,
        },
      );
    }

    const { body, headersAsObject } = payload;

    const chapaSignature = headersAsObject['chapa-signature'];
    const xChapaSignature = headersAsObject['x-chapa-signature'];

    if (!chapaSignature && !xChapaSignature) {
      throw new WebhookError(
        'Missing chapa-signature or x-chapa-signature header',
        {
          provider: this.providerName,
        },
      );
    }

    let event: ChapaWebhookEvent;

    try {
      event = JSON.parse(body) as ChapaWebhookEvent;
    } catch {
      throw new WebhookError(
        'Invalid webhook payload: not valid JSON',
        {
          provider: this.providerName,
        },
      );
    }

    // `chapa-signature` = HMAC-SHA256(secret, secret); `x-chapa-signature` =
    // HMAC-SHA256(secret, JSON.stringify(payload)). Either one matching is
    // treated as a valid signature, per Chapa's own verification example.
    const expectedChapaSignature = createHmac('sha256', webhookSecret)
      .update(webhookSecret)
      .digest('hex');

    const expectedXChapaSignature = createHmac(
      'sha256',
      webhookSecret,
    )
      .update(JSON.stringify(event))
      .digest('hex');

    const chapaSigValid = chapaSignature
      ? this.safeHexEqual(chapaSignature, expectedChapaSignature)
      : false;

    const xChapaSigValid = xChapaSignature
      ? this.safeHexEqual(xChapaSignature, expectedXChapaSignature)
      : false;

    if (!chapaSigValid && !xChapaSigValid) {
      throw new WebhookError('Invalid Chapa webhook signature', {
        provider: this.providerName,
      });
    }

    const results: Array<WebhookEventPayload<ChapaRawEvents>> = [];

    const contentHash = hashWebhookPayload(event.event, body);

    results.push({
      id: `chapa:${event.event}:${contentHash}`,
      type: `chapa.${event.event}`,
      created: Math.floor(Date.now() / 1000),
      data: event as any,
      is_raw: true,
    });

    const standardEvents = this.mapToStandardEvents(
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

  private mapToStandardEvents = (
    event: ChapaWebhookEvent,
    contentHash: string,
  ): Array<WebhookEventPayload> | null => {
    const created = Math.floor(Date.now() / 1000);
    const id = `paykit:${event.event}:${contentHash}`;

    if (!isChapaTransactionEvent(event)) {
      if (this.opts.debug) {
        console.info(
          `[Chapa] No standard mapping for event: ${event.event}. Available as raw event.`,
        );
      }
      return null;
    }

    if (event.event === 'charge.success') {
      const payment = Payment$inboundSchema(event);
      const invoice = Invoice$inboundSchema(event);

      return [
        paykitEvent$InboundSchema({
          type: 'payment.updated',
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

    if (
      event.event === 'charge.refunded' ||
      event.event === 'charge.reversed'
    ) {
      const refund = RefundFromTransaction$inboundSchema(event);

      return [
        paykitEvent$InboundSchema({
          type: 'refund.created',
          created,
          id,
          data: refund,
        }),
      ];
    }

    // Chapa's docs don't give an unambiguous literal event value for a
    // failed/cancelled charge (shown as `charge.failed/cancelled`), so this
    // falls back to the transaction's own `status` field instead.
    if (event.status === 'failed') {
      const payment = Payment$inboundSchema(event);

      return [
        paykitEvent$InboundSchema({
          type: 'payment.failed',
          created,
          id,
          data: payment,
        }),
      ];
    }

    if (this.opts.debug) {
      console.info(
        `[Chapa] No standard mapping for event: ${event.event} with status "${event.status}". Available as raw event.`,
      );
    }

    return null;
  };
}
