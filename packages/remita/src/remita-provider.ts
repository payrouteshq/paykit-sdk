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
  InvalidTypeError,
  OperationFailedError,
  PayKitProvider,
  PaykitProviderOptions,
  Payment,
  PaykitMetadata,
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
  createPaymentSchema,
  hashWebhookPayload,
  isEmailCustomer,
  schema,
  stringifyMetadataValues,
  validateRequiredKeys,
} from '@paykit-sdk/core';
import { createHash } from 'crypto';
import {
  RemitaCancelInvoiceRequest,
  RemitaCancelInvoiceResponse,
  RemitaCustomField,
  RemitaInvoiceRequest,
  RemitaInvoiceResponse,
  RemitaRawEvents,
  RemitaStatusResponse,
  RemitaWebhookNotification,
} from './schema';
import {
  Payment$fromCreate,
  Payment$fromStatus,
} from './utils/mapper';

interface RemitaPaymentMetadata {
  /**
   * Remita's Payee type only carries an email/id - it has no name or
   * phone field, both of which Remita's Invoice Generation API
   * requires.
   */
  payerName: string;
  payerPhone: string;

  /**
   * Overrides the provider-level default serviceTypeId for this
   * payment. Custom field names (below) must be pre-registered
   * against whichever serviceTypeId is used, on Remita's merchant
   * dashboard.
   */
  serviceTypeId?: string;

  /** Format: DD/MM/YYYY. */
  expiryDate?: string;
  customFields?: RemitaCustomField[];
}

interface RemitaMetadata extends ProviderMetadataRegistry {
  payment: RemitaPaymentMetadata;
}

export interface RemitaOptions extends PaykitProviderOptions {
  /** Merchant ID issued by Remita. */
  merchantId: string;

  /** API key issued by Remita (used in the SHA-512 request hash - never sent directly). */
  apiKey: string;

  /**
   * Default serviceTypeId used for payments that don't override it via
   * provider_metadata. Service types are registered per-merchant on
   * Remita's dashboard and tie a payment to a specific good/service.
   */
  serviceTypeId: string;

  /**
   * Remita does not publish a fixed production base URL for the
   * Invoice Generation API in their docs - it's issued per-merchant
   * after KYC/go-live (Administration Menu -> API Keys and Webhooks).
   * Required when isSandbox is false.
   */
  baseUrl?: string;
}

const remitaOptionsSchema = schema<RemitaOptions>()(
  Schema.object({
    merchantId: Schema.string(),
    apiKey: Schema.string(),
    serviceTypeId: Schema.string(),
    isSandbox: Schema.boolean(),
    baseUrl: Schema.string().optional(),
    debug: Schema.boolean().optional(),
  }),
);

const providerName = 'remita';

/**
 * Sandbox base URL for the Invoice Generation ("Standard Invoice" /
 * RRR) endpoints, as documented in Remita's official Postman
 * collection ("Remita APIs" -> Accept Payments -> Invoice Generation).
 */
const SANDBOX_BASE_URL =
  'https://demo.remita.net/remita/exapp/api/v1/send/api';

/**
 * Remita's official docs (Cancel Invoice) list this endpoint under a
 * different host (`remitademo.net` vs. `demo.remita.net` used
 * everywhere else in the same collection). Both are documented as
 * pointing at Remita's demo environment, so this implementation
 * deliberately resolves Cancel Invoice against the same configured
 * base URL as every other endpoint rather than hardcoding the
 * divergent host.
 */
const CANCEL_INVOICE_PATH = '/echannelsvc/v2/api/deactivate.json';

/**
 * PayKit provider for Remita's "Invoice Generation" (Remita Retrieval
 * Reference / RRR) API - Remita's First Generation Payment Gateway
 * product, documented at https://api.remita.net (Accept Payments ->
 * Invoice Generation).
 *
 * This is a reference-based collection flow, not a hosted checkout:
 * createPayment generates an RRR that the payer completes through
 * Remita's own channels (bank transfer, USSD, card, agent) outside of
 * this integration - there is no payment_url. createCheckout is
 * therefore unsupported; see deleteCheckout etc. below.
 */
export class RemitaProvider
  extends AbstractPayKitProvider
  implements
    PayKitProvider<RemitaMetadata, HTTPClient, RemitaRawEvents>
{
  readonly providerName = providerName;
  readonly isSandbox: boolean;
  private readonly _client: HTTPClient;

  get _native(): HTTPClient {
    return this._client;
  }

  constructor(private readonly opts: RemitaOptions) {
    super(remitaOptionsSchema, opts, providerName);

    if (!opts.isSandbox && !opts.baseUrl) {
      throw new ConfigurationError(
        'baseUrl is required when isSandbox is false - Remita does not publish a fixed production URL; use the one issued to your merchant account after go-live',
        { provider: providerName, missingKeys: ['baseUrl'] },
      );
    }

    this.isSandbox = opts.isSandbox;

    this._client = new HTTPClient({
      baseUrl: opts.isSandbox ? SANDBOX_BASE_URL : opts.baseUrl!,
      headers: { 'Content-Type': 'application/json' },
      retryOptions: {
        max: 3,
        baseDelay: 1000,
        debug: opts.debug ?? false,
      },
    });
  }

  /** SHA-512 hex digest of the concatenated (unseparated) parts, as required by Remita's apiHash. */
  private hash(...parts: string[]): string {
    return createHash('sha512').update(parts.join('')).digest('hex');
  }

  private authHeader(apiHash: string): Record<string, string> {
    return {
      Authorization: `remitaConsumerKey=${this.opts.merchantId},remitaConsumerToken=${apiHash}`,
    };
  }

  private unwrap<T>(
    result: { ok: boolean; value?: T; error?: unknown },
    operation: string,
  ): T {
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

  createCheckout = async (
    _params: CreateCheckoutSchema<RemitaMetadata['checkout']>,
  ): Promise<Checkout> => {
    throw new ProviderNotSupportedError('createCheckout', 'Remita', {
      reason:
        "Remita's Invoice Generation API returns only a Remita Retrieval Reference (RRR), not a hosted payment URL - the payer completes payment against the RRR through Remita's own channels (bank transfer, USSD, card, agent), not a redirect.",
      alternative:
        'Use createPayment() to generate an RRR, then direct your customer to pay against it through Remita.',
    });
  };

  retrieveCheckout = async (
    _id: string,
  ): Promise<Checkout | null> => {
    throw new ProviderNotSupportedError(
      'retrieveCheckout',
      'Remita',
      {
        reason:
          'Remita has no checkout/session resource - only payments.',
        alternative: 'Use retrievePayment() instead.',
      },
    );
  };

  updateCheckout = async (
    _id: string,
    _params: UpdateCheckoutSchema<RemitaMetadata['checkout']>,
  ): Promise<Checkout> => {
    throw new ProviderNotSupportedError('updateCheckout', 'Remita', {
      reason:
        'Remita has no checkout/session resource - only payments.',
    });
  };

  deleteCheckout = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deleteCheckout', 'Remita', {
      reason:
        'Remita has no checkout/session resource - only payments.',
      alternative: 'Use cancelPayment() instead.',
    });
  };

  createCustomer = async (
    _params: CreateCustomerParams<RemitaMetadata['customer']>,
  ): Promise<Customer> => {
    throw new ProviderNotSupportedError('createCustomer', 'Remita', {
      reason:
        "Remita's Invoice Generation API has no customer-object API - payer details are supplied per-payment.",
    });
  };

  retrieveCustomer = async (
    _id: string,
  ): Promise<Customer | null> => {
    throw new ProviderNotSupportedError(
      'retrieveCustomer',
      'Remita',
      {
        reason:
          "Remita's Invoice Generation API has no customer-object API.",
      },
    );
  };

  updateCustomer = async (
    _id: string,
    _params: UpdateCustomerParams<RemitaMetadata['customer']>,
  ): Promise<Customer> => {
    throw new ProviderNotSupportedError('updateCustomer', 'Remita', {
      reason:
        "Remita's Invoice Generation API has no customer-object API.",
    });
  };

  deleteCustomer = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deleteCustomer', 'Remita', {
      reason:
        "Remita's Invoice Generation API has no customer-object API.",
    });
  };

  createSubscription = async (
    _params: CreateSubscriptionSchema<RemitaMetadata['subscription']>,
  ): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'createSubscription',
      'Remita',
      {
        reason:
          'Recurring billing is a separate Remita product (Direct Debit mandates) with its own auth/endpoints, out of scope for this integration.',
      },
    );
  };

  updateSubscription = async (
    _id: string,
    _params: UpdateSubscriptionSchema<RemitaMetadata['subscription']>,
  ): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'updateSubscription',
      'Remita',
      {
        reason: 'Remita Invoice Generation has no subscription API.',
      },
    );
  };

  cancelSubscription = async (_id: string): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'cancelSubscription',
      'Remita',
      {
        reason: 'Remita Invoice Generation has no subscription API.',
      },
    );
  };

  deleteSubscription = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deleteSubscription',
      'Remita',
      {
        reason: 'Remita Invoice Generation has no subscription API.',
      },
    );
  };

  retrieveSubscription = async (
    _id: string,
  ): Promise<Subscription | null> => {
    throw new ProviderNotSupportedError(
      'retrieveSubscription',
      'Remita',
      {
        reason: 'Remita Invoice Generation has no subscription API.',
      },
    );
  };

  createPayment = async (
    params: CreatePaymentSchema<RemitaMetadata['payment']>,
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
        'string (customer ID)',
        { provider: this.providerName, method: 'createPayment' },
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

    const { payerName, payerPhone } = validateRequiredKeys(
      ['payerName', 'payerPhone'],
      (data.provider_metadata as Record<string, string>) ?? {},
      'The following fields must be present in the provider_metadata of createPayment: {keys}',
    );

    const pm = (data.provider_metadata ??
      {}) as Partial<RemitaPaymentMetadata>;
    const serviceTypeId = pm.serviceTypeId ?? this.opts.serviceTypeId;
    const orderId = crypto.randomUUID();
    const amount = String(data.amount);

    const apiHash = this.hash(
      this.opts.merchantId,
      serviceTypeId,
      orderId,
      amount,
      this.opts.apiKey,
    );

    const body: RemitaInvoiceRequest = {
      serviceTypeId,
      amount,
      orderId,
      payerName,
      payerEmail: data.customer.email,
      payerPhone,
      description: `Payment for ${data.item_id}`,
      ...(pm.expiryDate && { expiryDate: pm.expiryDate }),
      ...(pm.customFields && { customFields: pm.customFields }),
    };

    const response = await this._client.post<RemitaInvoiceResponse>(
      '/echannelsvc/merchant/api/paymentinit',
      {
        body: JSON.stringify(body),
        headers: this.authHeader(apiHash),
      },
    );

    const invoice = this.unwrap(response, 'createPayment');

    if (invoice.statuscode !== '025') {
      throw new OperationFailedError(
        'createPayment',
        this.providerName,
        {
          cause: new Error(invoice.status),
        },
      );
    }

    return Payment$fromCreate({
      rrr: invoice.RRR,
      amount: data.amount,
      customer: data.customer,
      itemId: data.item_id,
      metadata: stringifyMetadataValues(
        data.metadata ?? {},
      ) as PaykitMetadata,
    });
  };

  retrievePayment = async (id: string): Promise<Payment | null> => {
    const apiHash = this.hash(
      id,
      this.opts.apiKey,
      this.opts.merchantId,
    );

    const response = await this._client.get<RemitaStatusResponse>(
      `/echannelsvc/${encodeURIComponent(this.opts.merchantId)}/${encodeURIComponent(id)}/${encodeURIComponent(apiHash)}/status.reg`,
      { headers: this.authHeader(apiHash) },
    );

    if (!response.ok || !response.value) return null;

    // '022' = INVALID_RRR/INVALID_REQUEST, '026' = UNKNOWN_ORDER, per
    // Remita's documented "Response Codes- Check Status" table.
    if (
      response.value.status === '022' ||
      response.value.status === '026'
    ) {
      return null;
    }

    return Payment$fromStatus(response.value);
  };

  updatePayment = async (
    _id: string,
    _params: UpdatePaymentSchema<RemitaMetadata['payment']>,
  ): Promise<Payment> => {
    throw new ProviderNotSupportedError('updatePayment', 'Remita', {
      reason:
        'Remita has no endpoint to amend a payment reference after creation.',
      alternative:
        'Cancel it with cancelPayment() and create a new one.',
    });
  };

  deletePayment = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deletePayment', 'Remita', {
      reason: 'Remita has no delete endpoint for payment references.',
      alternative: 'Use cancelPayment() instead.',
    });
  };

  capturePayment = async (
    _id: string,
    _params: CapturePaymentSchema,
  ): Promise<Payment> => {
    throw new ProviderNotSupportedError('capturePayment', 'Remita', {
      reason:
        'Remita payments settle directly against the RRR through the bank/channel the payer chooses - there is no manual capture step.',
    });
  };

  /**
   * Cancels an unpaid RRR via Remita's "Cancel Invoice" endpoint.
   * Remita's docs are explicit that this only works on Invoices that
   * have not yet been paid.
   */
  cancelPayment = async (id: string): Promise<Payment> => {
    const existing = await this.retrievePayment(id);

    if (!existing) {
      throw new ResourceNotFoundError(
        'payment',
        id,
        this.providerName,
      );
    }

    const apiHash = this.hash(
      id,
      this.opts.apiKey,
      this.opts.merchantId,
    );

    const body: RemitaCancelInvoiceRequest = {
      rrr: id,
      merchantId: this.opts.merchantId,
      hash: apiHash,
    };

    const response =
      await this._client.post<RemitaCancelInvoiceResponse>(
        CANCEL_INVOICE_PATH,
        { body: JSON.stringify(body) },
      );

    const result = this.unwrap(response, 'cancelPayment');

    if (result.statuscode !== '00') {
      throw new OperationFailedError(
        'cancelPayment',
        this.providerName,
        {
          cause: new Error(result.status),
        },
      );
    }

    return {
      ...existing,
      status: 'canceled',
      requires_action: false,
    };
  };

  createRefund = async (
    _params: CreateRefundSchema<RemitaMetadata['refund']>,
  ): Promise<Refund> => {
    throw new ProviderNotSupportedError('createRefund', 'Remita', {
      reason:
        "Remita's Invoice Generation API has no refund endpoint once an RRR has been paid.",
      alternative:
        'Reverse the payment manually through your Remita dashboard.',
    });
  };

  /**
   * Remita's "Payment Notification" webhook carries no signature or
   * shared secret - webhookSecret is accepted only to satisfy the
   * shared PayKitProvider interface and is otherwise unused. Every
   * notification is re-verified against the status API (retrievePayment)
   * before a standardized event is emitted, since the payload itself
   * cannot be authenticated.
   *
   * Per Remita's docs, your endpoint should reply with the literal
   * text "Ok" (or "Not Ok") - PayKit's webhook.handle() always sends
   * its own response, so if strict compliance with that contract
   * matters, send it from your own route handler after calling
   * webhook.handle().
   */
  handleWebhook = async (
    payload: WebhookHandlerConfig,
    _webhookSecret: string | null,
  ): Promise<Array<WebhookEventPayload<RemitaRawEvents>>> => {
    const { body } = payload;

    let notifications: RemitaWebhookNotification[];

    try {
      const parsed = JSON.parse(body);
      notifications = Array.isArray(parsed) ? parsed : [parsed];
    } catch {
      throw new WebhookError(
        'Invalid webhook payload: not valid JSON',
        {
          provider: this.providerName,
        },
      );
    }

    const results: Array<WebhookEventPayload<RemitaRawEvents>> = [];

    for (const notification of notifications) {
      if (!notification?.rrr) continue;

      // A single delivery can batch several notifications, so the hash is
      // derived per-notification (not from the whole raw body) to keep ids
      // from colliding across items in the same batch.
      const contentHash = hashWebhookPayload(
        'notification',
        JSON.stringify(notification),
      );

      results.push({
        id: `remita:notification:${contentHash}`,
        type: 'remita.notification',
        created: Math.floor(Date.now() / 1000),
        data: notification,
        is_raw: true,
      });

      const payment = await this.retrievePayment(notification.rrr);

      if (!payment) continue;

      const created = Math.floor(Date.now() / 1000);
      const id = `paykit:notification:${contentHash}`;

      if (payment.status === 'succeeded') {
        results.push({
          id,
          type: 'payment.succeeded',
          created,
          data: payment,
        });
      } else if (payment.status === 'failed') {
        results.push({
          id,
          type: 'payment.failed',
          created,
          data: payment,
        });
      } else {
        results.push({
          id,
          type: 'payment.updated',
          created,
          data: payment,
        });
      }
    }

    return results;
  };
}
