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
  PAYKIT_METADATA_KEY,
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
  createCheckoutSchema,
  createPaymentSchema,
  createRefundSchema,
  hashWebhookPayload,
  isEmailCustomer,
  paykitEvent$InboundSchema,
  schema,
  stringifyMetadataValues,
} from '@paykit-sdk/core';
import { timingSafeEqual } from 'crypto';
import {
  FlutterwaveV3Authorization,
  FlutterwaveV3CardDetails,
  FlutterwaveV3ChargeAuthorization,
  FlutterwaveV3Envelope,
  FlutterwaveV3EventPayloadMap,
  FlutterwaveV3HostedLink,
  FlutterwaveV3HostedPaymentRequest,
  FlutterwaveV3LegacyChargeWebhook,
  FlutterwaveV3LegacyRefundWebhook,
  FlutterwaveV3PaymentPlan,
  FlutterwaveV3Refund,
  FlutterwaveV3RefundRequest,
  FlutterwaveV3Subscription,
  FlutterwaveV3SubscriptionCancelledEventData,
  FlutterwaveV3Transaction,
} from './schema';
import { encryptV3Payload } from './utils/encryption';
import {
  Checkout$fromHostedLink,
  Checkout$fromTransaction,
  Payment$fromAuthorization,
  Payment$fromTransaction,
  Refund$inboundSchema,
  Subscription$fromHostedLink,
  Subscription$inboundSchema,
  toBillingInterval,
} from './utils/mapper';

/** Sent with any request that creates something; all optional. */
interface FlutterwaveV3PaymentMetadata {
  /**
   * Your unique reference (`tx_ref`) for the payment, and the id of the
   * Payment this returns. Random if omitted. Must not be all digits,
   * which are read as Flutterwave's numeric transaction id.
   */
  reference?: string;
  /** Where Flutterwave sends the customer after a redirect-based step. */
  redirect_url?: string;
  /** The customer's name. */
  fullname?: string;
  phone_number?: string;
  /**
   * How to charge. `card` (the default) needs `card`, or `token` to
   * reuse a saved card. Anything else, such as `mobile_money_ghana`,
   * `mpesa` or `ussd`, is sent to `/charges?type=<payment_type>`
   * together with `fields`.
   */
  payment_type?: string;
  /** Raw card details. Encrypted for you with `encryptionKey`. */
  card?: FlutterwaveV3CardDetails;
  /** A card token from a previous payment, charged as a tokenized charge. */
  token?: string;
  /** Country for a tokenized charge. Defaults to `NG`. */
  country?: string;
  /**
   * The customer's answer to the previous step, sent when you call
   * createPayment() again with the same `reference` and `card` after
   * it returned `requires_action` for a PIN or address.
   */
  authorization?: FlutterwaveV3ChargeAuthorization;
  /**
   * Id of a payment plan to subscribe the customer to with this
   * charge. Find the subscription afterwards with
   * retrieveSubscription(payment.id).
   */
  payment_plan?: number | string;
  /** Extra body fields for non-card payment types, e.g. `network` or `phone_number`. */
  fields?: Record<string, unknown>;
  /**
   * The OTP the customer received, sent with updatePayment() to
   * finish a charge that returned `requires_action` for an OTP.
   */
  otp?: string;
}

interface FlutterwaveV3CheckoutMetadata {
  /** Your unique reference (`tx_ref`) and the id of the Checkout. Random if omitted. */
  reference?: string;
  /** Total to charge. Required for a one-time checkout; a plan sets its own. */
  amount?: number | string;
  /** Required for a one-time checkout; a plan sets its own. */
  currency?: string;
  customer_name?: string;
  phone_number?: string;
  /** Where Flutterwave sends the customer after paying. Defaults to `success_url`. */
  redirect_url?: string;
  /** Comma-separated payment methods to show, e.g. `card,ussd`. */
  payment_options?: string;
  customizations?: {
    title?: string;
    logo?: string;
    description?: string;
  };
}

interface FlutterwaveV3SubscriptionMetadata {
  reference?: string;
  /** Where Flutterwave sends the customer after paying. Required. */
  redirect_url?: string;
  customer_name?: string;
  phone_number?: string;
}

interface FlutterwaveV3RefundMetadata {}

interface FlutterwaveV3Metadata extends ProviderMetadataRegistry {
  checkout: FlutterwaveV3CheckoutMetadata;
  payment: FlutterwaveV3PaymentMetadata;
  refund: FlutterwaveV3RefundMetadata;
  subscription: FlutterwaveV3SubscriptionMetadata;
}

type PayKitFlutterwaveV3RawEvents = {
  [K in keyof FlutterwaveV3EventPayloadMap as `flutterwave.${K}`]: FlutterwaveV3EventPayloadMap[K];
} & Record<string, any>;

export interface FlutterwaveV3Options
  extends Omit<PaykitProviderOptions, 'isSandbox'> {
  /** Secret key from the dashboard: `FLWSECK_TEST-...` or `FLWSECK-...`. */
  secretKey: string;
  /**
   * Inferred from the key (`_TEST` means sandbox) when omitted. When
   * given, it must agree with the key or the provider refuses to start.
   */
  isSandbox?: boolean;
  /**
   * 24-character encryption key from the dashboard. Only needed to
   * charge cards directly, since v3 requires card details encrypted.
   */
  encryptionKey?: string;
}

const flutterwaveV3OptionsSchema = schema<FlutterwaveV3Options>()(
  Schema.object({
    secretKey: Schema.string(),
    encryptionKey: Schema.string().optional(),
    isSandbox: Schema.boolean().optional(),
    debug: Schema.boolean().optional(),
  }),
);

const providerName = 'flutterwave';

/** Sandbox and production share one host; the key decides which you hit. */
const BASE_URL = 'https://api.flutterwave.com/v3';

const SANDBOX_KEY_MARKER = '_TEST';

/** Flutterwave's numeric ids are all digits; a `tx_ref` never is. */
const isNumericId = (id: string) => /^\d+$/.test(id);

const MAX_SUBSCRIPTION_PAGES = 25;

export class FlutterwaveV3Provider
  extends AbstractPayKitProvider
  implements
    PayKitProvider<
      FlutterwaveV3Metadata,
      HTTPClient,
      PayKitFlutterwaveV3RawEvents
    >
{
  readonly providerName = providerName;
  readonly isSandbox: boolean;
  private readonly _client: HTTPClient;
  /**
   * Flutterwave v3 has no idempotency keys, so a write that is retried
   * after a timeout could charge or refund twice. Writes never retry.
   */
  private readonly writeClient: HTTPClient;

  get _native(): HTTPClient {
    return this._client;
  }

  constructor(private readonly opts: FlutterwaveV3Options) {
    super(flutterwaveV3OptionsSchema, opts, providerName);

    const isTestKey = opts.secretKey.includes(SANDBOX_KEY_MARKER);

    this.isSandbox = opts.isSandbox ?? isTestKey;

    if (
      opts.isSandbox !== undefined &&
      opts.isSandbox !== isTestKey
    ) {
      throw new ConfigurationError(
        opts.isSandbox
          ? 'isSandbox is true but secretKey is a live key (it should contain _TEST)'
          : 'isSandbox is false but secretKey is a test key',
        { provider: this.providerName, missingKeys: ['secretKey'] },
      );
    }

    const headers = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.secretKey}`,
    };
    const debug = opts.debug ?? false;

    this._client = new HTTPClient({
      baseUrl: BASE_URL,
      headers,
      retryOptions: { max: 3, baseDelay: 1000, debug },
    });

    this.writeClient = new HTTPClient({
      baseUrl: BASE_URL,
      headers,
      retryOptions: { max: 0, baseDelay: 0, debug },
    });
  }

  /* Plumbing */

  private get<T>(path: string) {
    return this._client.get<FlutterwaveV3Envelope<T>>(path);
  }

  private post<T>(path: string, body: unknown) {
    return this.writeClient.post<FlutterwaveV3Envelope<T>>(path, {
      body: JSON.stringify(body),
    });
  }

  private put<T>(path: string, body: unknown = {}) {
    return this.writeClient.put<FlutterwaveV3Envelope<T>>(path, {
      body: JSON.stringify(body),
    });
  }

  /** Flutterwave's own error message, when the response carried one. */
  private failureReason(result: {
    error?: unknown;
  }): string | undefined {
    let error = result.error as
      | (Error & { cause?: unknown })
      | undefined;

    while (error?.cause instanceof Error) error = error.cause;

    const body = error?.cause;
    const data =
      body && typeof body === 'object'
        ? (body as { message?: string; data?: unknown })
        : undefined;

    return (
      [
        data?.message,
        typeof data?.data === 'string' ? data.data : undefined,
      ]
        .filter(Boolean)
        .join(': ') || error?.message
    );
  }

  private failed(result: { error?: unknown }, operation: string) {
    return new OperationFailedError(operation, this.providerName, {
      reason: this.failureReason(result),
      cause: result.error as Error | undefined,
    });
  }

  private unwrap<T>(
    result: {
      ok: boolean;
      value?: FlutterwaveV3Envelope<T> | null;
      error?: unknown;
    },
    operation: string,
  ): T {
    if (!result.ok) throw this.failed(result, operation);

    if (!result.value?.data) {
      throw new OperationFailedError(operation, this.providerName, {
        reason: result.value?.message,
      });
    }

    return result.value.data;
  }

  /** Flutterwave answers an unknown transaction with a 400, not a 404. */
  private isNotFound(result: { error?: unknown }) {
    return /no transaction was found/i.test(
      this.failureReason(result) ?? '',
    );
  }

  /**
   * Looks a transaction up by `tx_ref`, or by Flutterwave's numeric
   * id when given one. Returns null only when it doesn't exist; a bad
   * key or an outage still throws.
   */
  private async findTransaction(
    id: string,
    operation: string,
  ): Promise<FlutterwaveV3Transaction | null> {
    const result = await this.get<FlutterwaveV3Transaction>(
      isNumericId(id)
        ? `/transactions/${id}/verify`
        : `/transactions/verify_by_reference?tx_ref=${encodeURIComponent(id)}`,
    );

    if (result.ok) return result.value?.data ?? null;
    if (this.isNotFound(result)) return null;

    throw this.failed(result, operation);
  }

  private async requireTransaction(
    id: string,
    operation: string,
  ): Promise<FlutterwaveV3Transaction> {
    const tx = await this.findTransaction(id, operation);

    if (!tx) {
      throw new ResourceNotFoundError(
        'payment',
        id,
        this.providerName,
      );
    }

    return tx;
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

  private newReference(provided: string | undefined, method: string) {
    if (provided && isNumericId(provided)) {
      throw this.validationError(
        'reference must not be all digits, since that is read as a Flutterwave transaction id.',
        method,
        'reference',
      );
    }

    return provided ?? `pk_${crypto.randomUUID()}`;
  }

  private paykitMeta(
    metadata: Record<string, unknown> | null | undefined,
    internal: Record<string, unknown>,
  ): Record<string, string> {
    return {
      ...stringifyMetadataValues(metadata ?? {}),
      [PAYKIT_METADATA_KEY]: JSON.stringify(internal),
    };
  }

  private async findPlan(planId: string) {
    const result = await this.get<FlutterwaveV3PaymentPlan>(
      `/payment-plans/${encodeURIComponent(planId)}`,
    );

    return this.unwrap(result, 'retrieve payment plan');
  }

  /* Checkout */

  /**
   * Creates a hosted payment link. `item_id` is the id of a payment
   * plan for a recurring checkout and only a label for a one-time one.
   * Flutterwave only creates a transaction once the customer pays, so
   * retrieveCheckout() returns null until then.
   */
  createCheckout = async (
    params: CreateCheckoutSchema<FlutterwaveV3Metadata['checkout']>,
  ): Promise<Checkout> => {
    const isRecurring = params.session_type === 'recurring';

    // The shared schema only models one-time checkouts.
    if (!isRecurring) {
      const { error } = createCheckoutSchema.safeParse(params);

      if (error) {
        throw ValidationError.fromZodError(
          error,
          this.providerName,
          'createCheckout',
        );
      }
    }

    if (!isEmailCustomer(params.customer)) {
      throw new InvalidTypeError(
        'customer',
        'object with email',
        'string (customer ID)',
        { provider: this.providerName, method: 'createCheckout' },
      );
    }

    const pm = (params.provider_metadata ??
      {}) as FlutterwaveV3CheckoutMetadata;
    const reference = this.newReference(
      pm.reference,
      'createCheckout',
    );

    let amount: number;
    let currency: string;
    let plan: FlutterwaveV3PaymentPlan | undefined;

    if (isRecurring) {
      plan = await this.findPlan(params.item_id);
      amount = plan.amount;
      currency = plan.currency;
    } else {
      if (pm.amount === undefined || !pm.currency) {
        throw new ConfigurationError(
          'amount and currency are required in the provider_metadata of a one-time createCheckout',
          {
            provider: this.providerName,
            missingKeys: ['amount', 'currency'].filter(
              key => pm[key as 'amount' | 'currency'] === undefined,
            ),
          },
        );
      }

      amount = Number(pm.amount);
      currency = pm.currency.toUpperCase();
    }

    const metadata = this.paykitMeta(params.metadata, {
      item_id: params.item_id,
      quantity: params.quantity,
      type: params.session_type,
    });

    const body: FlutterwaveV3HostedPaymentRequest = {
      tx_ref: reference,
      amount,
      currency,
      redirect_url:
        ('success_url' in params && params.success_url) ||
        pm.redirect_url ||
        '',
      customer: {
        email: params.customer.email,
        ...(pm.customer_name && { name: pm.customer_name }),
        ...(pm.phone_number && { phone_number: pm.phone_number }),
      },
      ...(plan && { payment_plan: plan.id }),
      ...(pm.payment_options && {
        payment_options: pm.payment_options,
      }),
      ...(pm.customizations && { customizations: pm.customizations }),
      meta: metadata,
    };

    if (!body.redirect_url) {
      throw this.validationError(
        'A redirect URL is required: pass success_url, or provider_metadata.redirect_url.',
        'createCheckout',
        'success_url',
      );
    }

    const link = this.unwrap(
      await this.post<FlutterwaveV3HostedLink>('/payments', body),
      'createCheckout',
    );

    return Checkout$fromHostedLink(link, {
      id: reference,
      amount,
      currency,
      customer: { email: params.customer.email },
      session_type: params.session_type,
      metadata: stringifyMetadataValues(params.metadata ?? {}),
      item_id: params.item_id,
      quantity: params.quantity,
      subscription: params.subscription,
    });
  };

  retrieveCheckout = async (id: string): Promise<Checkout | null> => {
    const tx = await this.findTransaction(id, 'retrieveCheckout');

    return tx ? Checkout$fromTransaction(tx) : null;
  };

  updateCheckout = async (
    _id: string,
    _params: UpdateCheckoutSchema<FlutterwaveV3Metadata['checkout']>,
  ): Promise<Checkout> => {
    throw new ProviderNotSupportedError(
      'updateCheckout',
      'Flutterwave',
      {
        reason: 'Flutterwave v3 hosted links cannot be updated.',
        alternative: 'Create a new checkout instead.',
      },
    );
  };

  deleteCheckout = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deleteCheckout',
      'Flutterwave',
      {
        reason: 'Flutterwave v3 hosted links cannot be deleted.',
        alternative:
          'Let it expire, or set a short session on a new checkout.',
      },
    );
  };

  /* Customers */

  private unsupportedCustomer = (method: string) => {
    throw new ProviderNotSupportedError(method, 'Flutterwave', {
      reason:
        'Flutterwave v3 has no customer API: customers are created implicitly by the payments they make.',
      alternative: 'Pass { email } as the customer of a payment.',
    });
  };

  createCustomer = async (
    _params: CreateCustomerParams<Record<string, unknown>>,
  ): Promise<Customer> => this.unsupportedCustomer('createCustomer');

  retrieveCustomer = async (_id: string): Promise<Customer | null> =>
    this.unsupportedCustomer('retrieveCustomer');

  updateCustomer = async (
    _id: string,
    _params: UpdateCustomerParams<Record<string, unknown>>,
  ): Promise<Customer> => this.unsupportedCustomer('updateCustomer');

  deleteCustomer = async (_id: string): Promise<null> =>
    this.unsupportedCustomer('deleteCustomer');

  /* Subscriptions */

  /**
   * Flutterwave subscribes a customer when they pay for a payment
   * plan, so this returns a `pending` subscription carrying the
   * `payment_url` to send them to. `item_id` is the plan id. The
   * subscription's id is the checkout reference until payment, after
   * which retrieveSubscription() resolves it to the numeric id.
   */
  createSubscription = async (
    params: CreateSubscriptionSchema<
      FlutterwaveV3Metadata['subscription']
    >,
  ): Promise<Subscription> => {
    if (!isEmailCustomer(params.customer)) {
      throw new InvalidTypeError(
        'customer',
        'object with email',
        'string (customer ID)',
        { provider: this.providerName, method: 'createSubscription' },
      );
    }

    const pm = (params.provider_metadata ??
      {}) as FlutterwaveV3SubscriptionMetadata;

    if (!pm.redirect_url) {
      throw new ConfigurationError(
        'redirect_url is required in the provider_metadata of createSubscription',
        {
          provider: this.providerName,
          missingKeys: ['redirect_url'],
        },
      );
    }

    const checkout = await this.createCheckout({
      customer: params.customer,
      metadata: params.metadata,
      session_type: 'recurring',
      item_id: params.item_id,
      quantity: params.quantity,
      subscription: {
        billing_interval: params.billing_interval,
        billing_interval_count: 1,
      },
      provider_metadata: {
        reference: pm.reference,
        redirect_url: pm.redirect_url,
        customer_name: pm.customer_name,
        phone_number: pm.phone_number,
      },
    });

    const plan = await this.findPlan(params.item_id);

    return Subscription$fromHostedLink(
      { link: checkout.payment_url },
      {
        id: checkout.id,
        email: params.customer.email,
        plan,
        metadata: stringifyMetadataValues(params.metadata ?? {}),
      },
    );
  };

  /**
   * Flutterwave can't fetch a subscription by id, so a numeric id is
   * found by paging through the list. A checkout reference is resolved
   * through the transaction that paid for it.
   */
  private async findSubscription(
    id: string,
  ): Promise<FlutterwaveV3Subscription | null> {
    if (!isNumericId(id)) {
      const tx = await this.findTransaction(
        id,
        'retrieveSubscription',
      );

      if (!tx) return null;

      const result = await this.get<FlutterwaveV3Subscription[]>(
        `/subscriptions?transaction_id=${tx.id}`,
      );

      return this.unwrap(result, 'retrieveSubscription')[0] ?? null;
    }

    for (let page = 1; page <= MAX_SUBSCRIPTION_PAGES; page++) {
      const result = await this.get<FlutterwaveV3Subscription[]>(
        `/subscriptions?page=${page}`,
      );

      if (!result.ok)
        throw this.failed(result, 'retrieveSubscription');

      const found = result.value?.data?.find(
        subscription => String(subscription.id) === id,
      );

      if (found) return found;

      const info = result.value?.meta?.page_info;

      if (!info || page >= info.total_pages) return null;
    }

    return null;
  }

  retrieveSubscription = async (
    id: string,
  ): Promise<Subscription | null> => {
    const subscription = await this.findSubscription(id);

    if (!subscription) return null;

    return Subscription$inboundSchema(
      subscription,
      await this.findPlan(String(subscription.plan)),
    );
  };

  updateSubscription = async (
    _id: string,
    _params: UpdateSubscriptionSchema<
      FlutterwaveV3Metadata['subscription']
    >,
  ): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'updateSubscription',
      'Flutterwave',
      {
        reason:
          'Flutterwave v3 subscriptions can only be cancelled or reactivated.',
        alternative:
          'Cancel it and create a new subscription on another plan.',
      },
    );
  };

  cancelSubscription = async (id: string): Promise<Subscription> => {
    const existing = await this.findSubscription(id);

    if (!existing) {
      throw new ResourceNotFoundError(
        'subscription',
        id,
        this.providerName,
      );
    }

    const cancelled = this.unwrap(
      await this.put<FlutterwaveV3Subscription>(
        `/subscriptions/${existing.id}/cancel`,
      ),
      'cancelSubscription',
    );

    return Subscription$inboundSchema(
      cancelled,
      await this.findPlan(String(cancelled.plan)),
    );
  };

  deleteSubscription = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deleteSubscription',
      'Flutterwave',
      {
        reason: 'Flutterwave v3 subscriptions cannot be deleted.',
        alternative: 'Use cancelSubscription() instead.',
      },
    );
  };

  /* Payments */

  /**
   * Charges the customer directly. A card is encrypted with
   * `encryptionKey` and sent to `/charges?type=card`; a saved card
   * `token` goes to `/tokenized-charges`; any other `payment_type`
   * goes to `/charges?type=<payment_type>`.
   *
   * Most methods need more from the customer, so the Payment usually
   * comes back as `requires_action`: open `payment_url` for a
   * redirect, call createPayment() again with `authorization` when a
   * card needs its PIN, or call updatePayment() with `otp`.
   *
   * `capture_method: 'manual'` preauthorizes a card (holds the funds)
   * so it can be captured later; Flutterwave must enable this on your
   * account.
   */
  createPayment = async (
    params: CreatePaymentSchema<FlutterwaveV3Metadata['payment']>,
  ): Promise<Payment> => {
    const { error, data } = createPaymentSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createPayment',
      );
    }

    if (!data.customer || !isEmailCustomer(data.customer)) {
      throw new InvalidTypeError(
        'customer',
        'object with email',
        'string (customer ID)',
        { provider: this.providerName, method: 'createPayment' },
      );
    }

    const pm = (data.provider_metadata ??
      {}) as FlutterwaveV3PaymentMetadata;
    const email = data.customer.email;
    const reference = this.newReference(
      pm.reference,
      'createPayment',
    );
    const paymentType = pm.payment_type ?? 'card';
    const preauthorize = data.capture_method === 'manual';

    if (preauthorize && !pm.token && paymentType !== 'card') {
      throw this.validationError(
        'Only card payments can use capture_method "manual" (preauthorization).',
        'createPayment',
        'capture_method',
      );
    }

    const metadata = this.paykitMeta(
      data.metadata,
      data.item_id ? { item_id: data.item_id } : {},
    );

    const common = {
      tx_ref: reference,
      amount: data.amount,
      currency: data.currency,
      email,
      ...(pm.fullname && { fullname: pm.fullname }),
      ...(pm.phone_number && { phone_number: pm.phone_number }),
      ...(pm.redirect_url && { redirect_url: pm.redirect_url }),
      ...(pm.payment_plan && { payment_plan: pm.payment_plan }),
      meta: metadata,
    };

    let path: string;
    let body: Record<string, unknown>;

    if (pm.token) {
      const [firstName, ...rest] = (pm.fullname ?? '').split(/\s+/);

      path = '/tokenized-charges';
      body = {
        ...common,
        token: pm.token,
        country: pm.country ?? 'NG',
        ...(firstName && { first_name: firstName }),
        ...(rest.length > 0 && { last_name: rest.join(' ') }),
        ...(preauthorize && { preauthorize }),
      };
    } else if (paymentType === 'card') {
      if (!pm.card) {
        throw new ConfigurationError(
          'card (or token) is required in the provider_metadata of a card createPayment',
          { provider: this.providerName, missingKeys: ['card'] },
        );
      }

      if (!this.opts.encryptionKey) {
        throw new ConfigurationError(
          'encryptionKey is required to charge cards with Flutterwave v3',
          {
            provider: this.providerName,
            missingKeys: ['encryptionKey'],
          },
        );
      }

      const { number, ...card } = pm.card;

      path = '/charges?type=card';
      body = {
        client: encryptV3Payload(
          {
            ...common,
            card_number: number,
            ...card,
            ...(pm.authorization && {
              authorization: pm.authorization,
            }),
            ...(preauthorize && { preauthorize }),
          },
          this.opts.encryptionKey,
        ),
      };
    } else {
      path = `/charges?type=${encodeURIComponent(paymentType)}`;
      body = { ...common, ...pm.fields };
    }

    const response = await this.post<FlutterwaveV3Transaction>(
      path,
      body,
    );

    if (!response.ok) throw this.failed(response, 'createPayment');

    const { data: tx, meta } = response.value ?? {};
    const authorization: FlutterwaveV3Authorization | undefined =
      meta?.authorization ??
      (tx?.meta as { authorization?: FlutterwaveV3Authorization })
        ?.authorization;

    // The charge response doesn't echo `meta`, but the request had it.
    if (tx) {
      return Payment$fromTransaction(
        { ...tx, meta: metadata },
        authorization,
      );
    }

    if (authorization) {
      return Payment$fromAuthorization(authorization, {
        id: reference,
        amount: data.amount,
        currency: data.currency,
        customer: { email },
        metadata,
      });
    }

    throw new OperationFailedError(
      'createPayment',
      this.providerName,
      {
        reason: response.value?.message,
      },
    );
  };

  /** Takes the `reference` returned as the payment's id, or a numeric transaction id. */
  retrievePayment = async (id: string): Promise<Payment | null> => {
    const tx = await this.findTransaction(id, 'retrievePayment');

    return tx ? Payment$fromTransaction(tx) : null;
  };

  /**
   * Completes a charge that returned `requires_action` for an OTP, by
   * passing it as `provider_metadata.otp`. Flutterwave v3 can't change
   * a transaction's metadata.
   */
  updatePayment = async (
    id: string,
    params: UpdatePaymentSchema<FlutterwaveV3Metadata['payment']>,
  ): Promise<Payment> => {
    const otp = params.provider_metadata?.otp;

    if (!otp) {
      throw this.validationError(
        'Nothing to update: Flutterwave v3 only supports completing a charge with provider_metadata.otp.',
        'updatePayment',
        'provider_metadata',
      );
    }

    const tx = await this.requireTransaction(id, 'updatePayment');

    const validated = this.unwrap(
      await this.post<FlutterwaveV3Transaction>('/validate-charge', {
        otp,
        flw_ref: tx.flw_ref,
        type: tx.payment_type === 'account' ? 'account' : 'card',
      }),
      'updatePayment',
    );

    return Payment$fromTransaction({ ...validated, meta: tx.meta });
  };

  deletePayment = async (_id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deletePayment',
      'Flutterwave',
      {
        reason: 'Flutterwave has no endpoint to delete a payment.',
        alternative:
          'Use cancelPayment() on a preauthorized charge, or createRefund() once it has succeeded.',
      },
    );
  };

  /** Captures a preauthorized charge, in full or in part. */
  capturePayment = async (
    id: string,
    params: CapturePaymentSchema,
  ): Promise<Payment> => {
    const tx = await this.requireTransaction(id, 'capturePayment');

    if (Payment$fromTransaction(tx).status !== 'requires_capture') {
      throw new ProviderNotSupportedError(
        'capturePayment',
        'Flutterwave',
        {
          reason:
            'Only a preauthorized charge (capture_method: "manual") that is still pending can be captured.',
        },
      );
    }

    if (params.amount > tx.amount) {
      throw this.validationError(
        `Cannot capture more than the ${tx.amount} that was authorized.`,
        'capturePayment',
        'amount',
      );
    }

    const captured = this.unwrap(
      await this.post<FlutterwaveV3Transaction>(
        `/charges/${encodeURIComponent(tx.flw_ref)}/capture`,
        { amount: String(params.amount) },
      ),
      'capturePayment',
    );

    return Payment$fromTransaction({ ...captured, meta: tx.meta });
  };

  /** Releases the hold on a preauthorized charge. */
  cancelPayment = async (id: string): Promise<Payment> => {
    const tx = await this.requireTransaction(id, 'cancelPayment');

    if (Payment$fromTransaction(tx).status !== 'requires_capture') {
      throw new ProviderNotSupportedError(
        'cancelPayment',
        'Flutterwave',
        {
          reason:
            'Only a pending preauthorized charge can be voided.',
          alternative:
            'Use createRefund() once the charge has succeeded.',
        },
      );
    }

    const voided = this.unwrap(
      await this.post<FlutterwaveV3Transaction>(
        `/charges/${encodeURIComponent(tx.flw_ref)}/void`,
        {},
      ),
      'cancelPayment',
    );

    return Payment$fromTransaction({ ...voided, meta: tx.meta });
  };

  /* Refunds */

  /**
   * Refunds the whole payment when `amount` is 0. Flutterwave v3
   * can't attach metadata to a refund, so `metadata` is ignored. A
   * refund isn't immediate: it usually takes 3 to 15 working days to
   * reach the customer, although `status` can already read
   * `succeeded`.
   */
  createRefund = async (
    params: CreateRefundSchema<FlutterwaveV3Metadata['refund']>,
  ): Promise<Refund> => {
    const { error, data } = createRefundSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createRefund',
      );
    }

    const tx = await this.requireTransaction(
      data.payment_id,
      'createRefund',
    );

    const body: FlutterwaveV3RefundRequest = {
      ...(data.amount > 0 && { amount: data.amount }),
      ...(data.reason && { comments: data.reason }),
    };

    const refund = this.unwrap(
      await this.post<FlutterwaveV3Refund>(
        `/transactions/${tx.id}/refund`,
        body,
      ),
      'createRefund',
    );

    return Refund$inboundSchema(refund, tx.currency, data.reason);
  };

  /* Webhooks */

  /**
   * Verifies `verif-hash`, which Flutterwave sets to the secret hash
   * you chose in the dashboard, then maps the event. A charge or
   * refund is re-read from Flutterwave first, since a webhook is only
   * a notification. A failure then has three different causes, and
   * each throws a different error so the caller can answer correctly:
   *
   * - a bad `verif-hash` throws WebhookError: reject it (401).
   * - a valid webhook for a transaction Flutterwave doesn't know throws
   *   ResourceNotFoundError: no retry can fix it, so answer 200 or 404.
   * - a lookup that fails (an outage, a bad key) throws
   *   OperationFailedError: answer 5xx so Flutterwave retries.
   *
   * Flutterwave sends two shapes: `{ event, data }`, and (sandbox
   * charges and refunds) a bare legacy object. Both are accepted.
   */
  handleWebhook = async (
    payload: WebhookHandlerConfig,
    webhookSecret: string | null,
  ): Promise<
    Array<WebhookEventPayload<PayKitFlutterwaveV3RawEvents>>
  > => {
    if (!webhookSecret) {
      throw new WebhookError(
        'webhookSecret is required for Flutterwave webhook verification',
        { provider: this.providerName },
      );
    }

    const { body, headersAsObject } = payload;
    const received = headersAsObject['verif-hash'];

    if (!received) {
      throw new WebhookError('Missing verif-hash header', {
        provider: this.providerName,
      });
    }

    const expected = Buffer.from(webhookSecret);
    const actual = Buffer.from(received);

    if (
      expected.length !== actual.length ||
      !timingSafeEqual(expected, actual)
    ) {
      throw new WebhookError(
        'Invalid Flutterwave webhook secret hash',
        {
          provider: this.providerName,
        },
      );
    }

    let raw: Record<string, any>;

    try {
      raw = JSON.parse(body);
    } catch {
      throw new WebhookError(
        'Invalid webhook payload: not valid JSON',
        { provider: this.providerName },
      );
    }

    const event = this.resolveEvent(raw);
    const contentHash = hashWebhookPayload(event.type, body);

    const results: Array<
      WebhookEventPayload<PayKitFlutterwaveV3RawEvents>
    > = [
      {
        id: `flutterwave:${event.type}:${contentHash}`,
        type: `flutterwave.${event.type}`,
        created: Math.floor(Date.now() / 1000),
        data: event.data as any,
        is_raw: true,
      },
    ];

    const standard = await this.mapToStandardEvents(
      event,
      contentHash,
    );

    if (standard) results.push(...standard);

    return results;
  };

  private resolveEvent(raw: Record<string, any>): {
    type: string;
    data: any;
  } {
    if (typeof raw.event === 'string') {
      return { type: raw.event, data: raw.data };
    }

    if ('AmountRefunded' in raw) {
      return { type: 'refund.completed', data: raw };
    }

    if ('txRef' in raw || 'tx_ref' in raw) {
      return { type: 'charge.completed', data: raw };
    }

    throw new WebhookError(
      'Unrecognized Flutterwave webhook payload',
      {
        provider: this.providerName,
      },
    );
  }

  private mapToStandardEvents = async (
    event: { type: string; data: any },
    contentHash: string,
  ): Promise<Array<WebhookEventPayload> | null> => {
    const created = Math.floor(Date.now() / 1000);
    const id = `paykit:${event.type}:${contentHash}`;

    switch (event.type) {
      case 'charge.completed': {
        const data = event.data as
          | FlutterwaveV3LegacyChargeWebhook
          | FlutterwaveV3Transaction;
        const reference = 'txRef' in data ? data.txRef : data.tx_ref;

        if (!reference) {
          throw new WebhookError(
            `${event.type} payload has no transaction reference`,
            { provider: this.providerName },
          );
        }

        const tx = await this.findTransaction(
          reference,
          'handleWebhook',
        );

        if (!tx) {
          throw new ResourceNotFoundError(
            'payment',
            reference,
            this.providerName,
          );
        }

        const payment = Payment$fromTransaction(tx);

        return [
          paykitEvent$InboundSchema({
            type:
              payment.status === 'succeeded'
                ? 'payment.succeeded'
                : payment.status === 'failed'
                  ? 'payment.failed'
                  : 'payment.updated',
            created,
            id,
            data: payment,
          }),
        ];
      }

      case 'refund.completed': {
        const data = event.data as FlutterwaveV3LegacyRefundWebhook;

        if (!data.TransactionId) {
          throw new WebhookError(
            `${event.type} payload has no transaction id`,
            { provider: this.providerName },
          );
        }

        const transactionId = String(data.TransactionId);
        const tx = await this.findTransaction(
          transactionId,
          'handleWebhook',
        );

        if (!tx) {
          throw new ResourceNotFoundError(
            'payment',
            transactionId,
            this.providerName,
          );
        }

        return [
          paykitEvent$InboundSchema({
            type: 'refund.created',
            created,
            id,
            data: Refund$inboundSchema(
              {
                id: data.id,
                amount_refunded: data.AmountRefunded,
                status: data.status,
                comments: data.comments,
              },
              tx.currency,
              null,
            ),
          }),
        ];
      }

      case 'subscription.cancelled': {
        const data =
          event.data as FlutterwaveV3SubscriptionCancelledEventData;

        if (!data.plan?.id) return null;

        const now = new Date();

        return [
          paykitEvent$InboundSchema({
            type: 'subscription.canceled',
            created,
            id,
            data: {
              id: data.id ?? String(data.plan.id),
              customer: { email: data.customer.email },
              amount: data.amount,
              currency: data.currency,
              status: 'canceled',
              current_period_start: now,
              current_period_end: now,
              item_id: String(data.plan.id),
              billing_interval: toBillingInterval(
                data.plan.interval ?? 'monthly',
              ),
              metadata: null,
              custom_fields: data.plan.name
                ? { plan_name: data.plan.name }
                : null,
              requires_action: false,
              payment_url: null,
            } satisfies Subscription,
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
