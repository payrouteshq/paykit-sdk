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
  Invoice,
  LooseAutoComplete,
  OAuth2TokenManager,
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
  createPaymentSchema,
  createRefundSchema,
  createSubscriptionSchema,
  hashWebhookPayload,
  isEmailCustomer,
  isIdCustomer,
  paykitEvent$InboundSchema,
  schema,
  tryCatchAsync,
  validateRequiredKeys,
} from '@paykit-sdk/core';
import * as crypto from 'crypto';
import { z } from 'zod';
import {
  GoPayPaymentBaseResponse,
  GoPayPaymentRequest,
  GoPaySubscriptionResponse,
} from './schema';
import {
  Checkout$inboundSchema,
  Invoice$inboundSchema,
  Payment$inboundSchema,
  Refund$inboundSchema,
  Subscription$inboundSchema,
  decodeHtmlEntities,
} from './utils/mapper';

interface GoPayMetadata extends ProviderMetadataRegistry {
  checkout: {
    amount: number | string;
    currency: string;
    language: string;
  };
  subscription: {
    success_url: string;
    recurrence_period?: number;
  };
  payments: {
    success_url: string;
  };
}

interface GoPayRawEvents extends Record<string, any> {}

export interface GoPayOptions extends PaykitProviderOptions {
  /**
   * The client ID for the GoPay API
   */
  clientId: string;

  /**
   * The client secret for the GoPay API
   */
  clientSecret: string;

  /**
   * The GoID for the GoPay API
   */
  goId: string;

  /**
   * The webhook URL for the GoPay API
   */
  webhookUrl: string;
}

const gopayOptionsSchema = schema<GoPayOptions>()(
  z.object({
    clientId: z.string(),
    clientSecret: z.string(),
    goId: z.string(),
    isSandbox: z.boolean(),
    webhookUrl: z.string(),
    debug: z.boolean().optional(),
  }),
);

const providerName = 'gopay';

export class GoPayProvider
  extends AbstractPayKitProvider
  implements PayKitProvider<GoPayMetadata, HTTPClient, GoPayRawEvents>
{
  readonly providerName = providerName;
  readonly providerVersion = process.env.PROVIDER_VERSION!;

  private _client: HTTPClient;
  private baseUrl: string;

  readonly isSandbox: boolean;

  private tokenManager: OAuth2TokenManager;

  get _native(): HTTPClient {
    return this._client;
  }

  constructor(private readonly opts: GoPayOptions) {
    super(gopayOptionsSchema, opts, providerName);

    this.isSandbox = opts.isSandbox;

    const debug = opts.debug ?? true;

    this.baseUrl = opts.isSandbox
      ? 'https://gw.sandbox.gopay.com/api'
      : 'https://gate.gopay.cz/api';

    this._client = new HTTPClient({
      baseUrl: this.baseUrl,
      headers: {},
      retryOptions: { max: 3, baseDelay: 1000, debug },
    });

    this.tokenManager = new OAuth2TokenManager({
      client: this._client,
      provider: this.providerName,
      tokenEndpoint: '/oauth2/token',
      credentials: {
        username: opts.clientId,
        password: opts.clientSecret,
      },
      responseAdapter: response => ({
        accessToken: response.access_token,
        expiresIn: response.expires_in,
      }),
      expiryBuffer: 5 * 60, // 5 minutes
      requestBody: 'grant_type=client_credentials&scope=payment-all',
      requestHeaders: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/json',
      },
      authHeaders: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
    });
  }

  private async submitPayment(
    request: GoPayPaymentRequest,
    method: string,
  ): Promise<GoPayPaymentBaseResponse> {
    const response =
      await this._client.post<GoPayPaymentBaseResponse>(
        '/payments/payment',
        {
          body: JSON.stringify(request),
          headers: await this.tokenManager.getAuthHeaders(),
        },
      );

    if (!response.ok) {
      throw new OperationFailedError(method, this.providerName, {
        cause: new Error(
          `Failed to submit payment: ${JSON.stringify(response.error ?? response)}`,
        ),
      });
    }

    return response.value;
  }

  createCheckout = async (
    params: CreateCheckoutSchema<GoPayMetadata['checkout']>,
  ): Promise<Checkout> => {
    const { error, data } = createCheckoutSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        'gopay',
        'createCheckout',
      );
    }

    if (!isEmailCustomer(data.customer)) {
      throw new InvalidTypeError(
        'customer',
        'object (customer) with email',
        'string',
        {
          provider: this.providerName,
          method: 'createCheckout',
        },
      );
    }

    const { amount, currency = 'CZK' } = validateRequiredKeys(
      ['amount', 'currency'],
      (data.provider_metadata as Record<string, string>) ?? {},
      'The following fields must be present in the provider_metadata of createCheckout: {keys}',
    );

    if (this.opts.debug) {
      console.info(
        'Specify `language` in the `provider_metadata` of createCheckout to set the language of the checkout, default is `EN`',
      );

      console.info('Creating checkout with metadata:', data.metadata);
    }

    const goPayRequest: GoPayPaymentRequest = {
      payer: {
        allowed_payment_instruments: ['PAYMENT_CARD', 'BANK_ACCOUNT'],
        default_payment_instrument: 'PAYMENT_CARD',
        contact: {
          email: data.customer.email!,
          ...(data.billing && {
            city: data.billing.address.city,
            postal_code: data.billing.address.postal_code,
            country_code: data.billing.address.country,
            phone_number: data.billing.address.phone,
          }),
        },
      },
      target: { type: 'ACCOUNT', goid: parseInt(this.opts.goId) },
      amount: Number(amount),
      currency: currency.toUpperCase(),
      order_number: crypto
        .randomBytes(8)
        .toString('hex')
        .slice(0, 15),
      order_description: `Payment for ${data.item_id} by ${data.customer.email}`,
      items: [
        {
          name: data.item_id,
          amount: Number(amount),
          count: data.quantity,
          type: 'ITEM',
        },
      ],
      lang: data.provider_metadata?.language
        ? (data.provider_metadata.language as string)
        : 'EN',
      callback: {
        return_url: data.success_url,
        notification_url: this.opts.webhookUrl,
      },
      additional_params: Object.entries({
        ...data.metadata,
        [PAYKIT_METADATA_KEY]: JSON.stringify({
          item: data.item_id,
          qty: data.quantity,
          type: data.session_type,
        }),
      }).map(([name, value]) => ({
        name,
        value: String(value),
      })),
    };

    const responseValue = await this.submitPayment(
      goPayRequest,
      'createCheckout',
    );

    return Checkout$inboundSchema(responseValue);
  };

  retrieveCheckout = async (id: string): Promise<Checkout | null> => {
    const response = await this._client.get<GoPayPaymentBaseResponse>(
      `/payments/payment/${id}`,
      {
        headers: {
          ...(await this.tokenManager.getAuthHeaders()),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );

    if (!response.ok) {
      throw new OperationFailedError(
        'retrieveCheckout',
        this.providerName,
        {
          cause: new Error('Failed to retrieve checkout'),
        },
      );
    }

    return Checkout$inboundSchema(response.value);
  };

  updateCheckout = async (
    id: string,
    params: UpdateCheckoutSchema,
  ): Promise<Checkout> => {
    if (this.opts.debug) {
      console.info(
        "Gopay doesn't support updating checkouts, returning existing checkout",
      );
    }

    const existing = await this.retrieveCheckout(id);

    return existing as Checkout;
  };

  deleteCheckout = async (id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deleteCheckout', 'gopay', {
      reason: "Gopay doesn't support deleting checkouts",
      alternative:
        'Use createCheckout() instead to create a new checkout',
    });
  };

  createCustomer = async (
    params: CreateCustomerParams,
  ): Promise<Customer> => {
    throw new ProviderNotSupportedError('createCustomer', 'gopay', {
      reason: "Gopay doesn't support creating customers",
    });
  };

  updateCustomer = async (
    id: string,
    params: UpdateCustomerParams,
  ): Promise<Customer> => {
    throw new ProviderNotSupportedError('updateCustomer', 'gopay', {
      reason: "Gopay doesn't support updating customers",
    });
  };

  deleteCustomer = async (id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deleteCustomer', 'gopay', {
      reason: "Gopay doesn't support deleting customers",
    });
  };

  retrieveCustomer = async (id: string): Promise<Customer | null> => {
    throw new ProviderNotSupportedError('retrieveCustomer', 'gopay', {
      reason: "Gopay doesn't support retrieving customers",
    });
  };

  createSubscription = async (
    params: CreateSubscriptionSchema<GoPayMetadata['subscription']>,
  ): Promise<Subscription> => {
    const { error, data } =
      createSubscriptionSchema.safeParse(params);

    if (error)
      throw ValidationError.fromZodError(
        error,
        'gopay',
        'createSubscription',
      );

    // Customer must be an object with email
    if (!isEmailCustomer(data.customer)) {
      throw new InvalidTypeError(
        'customer',
        'object with email',
        isIdCustomer(data.customer)
          ? 'object with id'
          : typeof data.customer,
        {
          provider: this.providerName,
          method: 'createSubscription',
        },
      );
    }

    const { success_url } = validateRequiredKeys(
      ['success_url'],
      (data.provider_metadata as Record<string, string>) ?? {},
      'The following fields must be present in the provider_metadata of createSubscription: {keys}',
    );

    // ─── Resolve billing_interval → GoPay recurrence_cycle ──────────────────
    // GoPay only supports: DAY, WEEK, MONTH, ON_DEMAND
    // `year` has no native equivalent → ON_DEMAND (merchant triggers charges manually)
    // `custom` ({ type: 'custom', durationMs }) → ON_DEMAND (same reason)
    // For ON_DEMAND: recurrence_period MUST NOT be sent (per GoPay docs)

    const billingInterval = data.billing_interval;
    const isCustom =
      typeof billingInterval === 'object' &&
      billingInterval.type === 'custom';
    const isYear = billingInterval === 'year';
    const isOnDemand = isCustom || isYear;

    type GoPayCycle = 'DAY' | 'WEEK' | 'MONTH' | 'ON_DEMAND';

    const intervalMap: Record<
      'day' | 'week' | 'month' | 'year',
      GoPayCycle
    > = {
      day: 'DAY',
      week: 'WEEK',
      month: 'MONTH',
      year: 'ON_DEMAND',
    };

    const recurrenceCycle: GoPayCycle = isCustom
      ? 'ON_DEMAND'
      : intervalMap[
          billingInterval as 'day' | 'week' | 'month' | 'year'
        ];

    if (this.opts.debug) {
      if (isYear) {
        console.info(
          '[PayKit/GoPay] GoPay does not support yearly recurrence. Falling back to ON_DEMAND — ' +
            'trigger each charge via paykit.subscriptions.update(id, { provider_metadata: { amount } }). ' +
            'See: https://doc.gopay.com/#recurring-on-demand',
        );
      }
      if (isCustom) {
        const durationMs = (
          billingInterval as { type: 'custom'; durationMs: number }
        ).durationMs;
        console.info(
          `[PayKit/GoPay] Custom interval (${durationMs}ms) is not supported by GoPay. ` +
            'Falling back to ON_DEMAND — trigger each charge via paykit.subscriptions.update(id, { provider_metadata: { amount } }). ' +
            'See: https://doc.gopay.com/#recurring-on-demand',
        );
      }
      if (!isOnDemand) {
        console.info(
          `[PayKit/GoPay] AUTO recurrence (${recurrenceCycle}) — GoPay charges automatically each cycle. ` +
            'No manual update() call is needed to collect charges. ' +
            'Set provider_metadata.end_date (ISO string, e.g. "2027-01-01") to control when the subscription ends. ' +
            'Defaults to 1 year from today.',
        );
      } else {
        console.info(
          '[PayKit/GoPay] ON_DEMAND recurrence — you MUST call paykit.subscriptions.update(id, { provider_metadata: { amount } }) ' +
            'for each subsequent charge. GoPay will NOT charge automatically. ' +
            'Set provider_metadata.end_date (ISO string) to control the authorization window. ' +
            'Defaults to 1 year (custom interval) or 5 years (yearly interval).',
        );
      }
      if (!data.provider_metadata?.description) {
        console.info(
          `[PayKit/GoPay] No \`provider_metadata.description\` provided. ` +
            `Using default: "Subscription by ${data.customer.email}"`,
        );
      }
    }

    const toDateString = (ms: number): string => {
      const d = new Date(ms);
      return d.toISOString().split('T')[0];
    };

    const GOPAY_MAX_DATE = '2099-12-30';

    // recurrence_date_to = subscription END DATE.
    // For AUTO cycles (DAY/WEEK/MONTH): the date of the last automatic charge.
    // For ON_DEMAND: the date until which the parent payment is valid for creating recurrences.
    // Override via provider_metadata.end_date (ISO string, e.g. "2027-01-01").
    const endDateOverride = data.provider_metadata?.end_date as
      | string
      | undefined;

    const recurrenceDateTo = (() => {
      if (endDateOverride) {
        return endDateOverride < GOPAY_MAX_DATE
          ? endDateOverride
          : GOPAY_MAX_DATE;
      }

      if (recurrenceCycle === 'ON_DEMAND') {
        if (isCustom) {
          // 1-year authorization window for custom intervals
          return toDateString(Date.now() + 365 * 24 * 60 * 60 * 1000);
        }

        // year → 5-year authorization window
        return toDateString(
          Date.now() + 5 * 365 * 24 * 60 * 60 * 1000,
        );
      }

      // AUTO cycles (DAY / WEEK / MONTH): default to 1-year subscription.
      return toDateString(Date.now() + 365 * 24 * 60 * 60 * 1000);
    })();

    // recurrence_period = interval multiplier (e.g. DAY + period 7 = every 7 days).
    // Override via provider_metadata.recurrence_period. Defaults to 1 (every cycle).
    // MUST NOT be sent for ON_DEMAND (per GoPay docs).
    const recurrencePeriod =
      (data.provider_metadata?.recurrence_period as
        | number
        | undefined) ?? 1;

    const recurrence = isOnDemand
      ? {
          recurrence_cycle: recurrenceCycle,
          recurrence_date_to: recurrenceDateTo,
        }
      : {
          recurrence_cycle: recurrenceCycle,
          recurrence_period: recurrencePeriod,
          recurrence_date_to: recurrenceDateTo,
        };

    // ─── Build full payment request ──────────────────────────────────────────
    const goPaySubscriptionOptions: GoPayPaymentRequest = {
      payer: {
        allowed_payment_instruments: ['PAYMENT_CARD'],
        default_payment_instrument: 'PAYMENT_CARD',
        contact: { email: data.customer.email as string },
      },
      target: { type: 'ACCOUNT', goid: parseInt(this.opts.goId) },
      amount: Number(data.amount),
      currency: data.currency?.toUpperCase() ?? 'CZK',
      order_number: crypto
        .randomBytes(8)
        .toString('hex')
        .slice(0, 15),
      order_description: data.provider_metadata?.description
        ? (data.provider_metadata.description as string)
        : `Subscription by ${data.customer.email}`,
      items: [
        {
          name: data.item_id,
          amount: Number(data.amount),
          count: data.quantity ?? 1,
          type: 'ITEM',
        },
      ],
      recurrence,
      callback: {
        return_url: success_url,
        notification_url: this.opts.webhookUrl,
      },
      additional_params: Object.entries({
        ...data.metadata,
        [PAYKIT_METADATA_KEY]: JSON.stringify({
          item: data.item_id,
          qty: data.quantity,
          // Store the original interval so Subscription$inboundSchema can
          // recover it later - GoPay's recurrence_cycle collapses year and
          // custom intervals down to ON_DEMAND and can't tell them apart.
          billing_interval: isCustom
            ? `custom:${(billingInterval as { type: 'custom'; durationMs: number }).durationMs}ms`
            : billingInterval,
        }),
      }).map(([name, value]) => ({ name, value: String(value) })),
    };

    const response =
      await this._client.post<GoPaySubscriptionResponse>(
        '/payments/payment',
        {
          body: JSON.stringify(goPaySubscriptionOptions),
          headers: await this.tokenManager.getAuthHeaders(),
        },
      );

    if (!response.ok) {
      throw new OperationFailedError(
        'createSubscription',
        this.providerName,
        {
          cause: new Error(
            `[PayKit/GoPay] Failed to create subscription. Error: ${response.error}`,
          ),
        },
      );
    }

    return Subscription$inboundSchema(response.value);
  };

  /**
   * `updateSubscription` is GoPay's real mechanism for collecting each
   * charge on an ON_DEMAND recurring mandate - GoPay never charges these
   * automatically, so every subsequent payment has to be triggered
   * explicitly via `POST /payments/payment/{id}/create-recurrence`.
   * Supply the charge via `provider_metadata.amount` (and optionally
   * `currency`/`order_number`/`order_description`/`items`); `params.metadata`
   * is stored on that charge the same way createCheckout/createPayment do.
   *
   * For AUTO cycles (DAY/WEEK/MONTH), GoPay already charges on its own
   * schedule and there's nothing to trigger - calling this without
   * `provider_metadata.amount` just re-fetches the current subscription.
   *
   * @see https://doc.gopay.com/#recurring-payments
   */
  updateSubscription = async (
    id: string,
    params: UpdateSubscriptionSchema<GoPayMetadata['subscription']>,
  ): Promise<Subscription> => {
    const chargeParams = params.provider_metadata as
      | {
          amount?: number;
          currency?: string;
          order_number?: string;
          order_description?: string;
          items?: Array<{
            name: string;
            amount: number;
            count?: number;
          }>;
        }
      | undefined;

    if (chargeParams?.amount) {
      const body = {
        amount: chargeParams.amount,
        currency: (chargeParams.currency ?? 'CZK').toUpperCase(),
        order_number:
          chargeParams.order_number ??
          crypto.randomBytes(8).toString('hex').slice(0, 15),
        order_description:
          chargeParams.order_description ??
          `Recurring charge for payment ${id}`,
        items: chargeParams.items ?? [
          {
            name: 'recurring_charge',
            amount: chargeParams.amount,
            count: 1,
          },
        ],
        additional_params: Object.entries(params.metadata ?? {}).map(
          ([name, value]) => ({ name, value: String(value) }),
        ),
      };

      const response =
        await this._client.post<GoPaySubscriptionResponse>(
          `/payments/payment/${id}/create-recurrence`,
          {
            body: JSON.stringify(body),
            headers: await this.tokenManager.getAuthHeaders(),
          },
        );

      if (!response.ok) {
        throw new OperationFailedError(
          'updateSubscription',
          this.providerName,
          {
            cause: new Error(
              `[PayKit/GoPay] Failed to create on-demand recurrence charge: ${JSON.stringify(response.error ?? response)}`,
            ),
          },
        );
      }

      // GoPay's create-recurrence response describes the newly created
      // CHILD payment (its own id), not the parent mandate - re-fetch the
      // parent so callers get back the subscription they asked to update.
      const parent = await this.retrieveSubscription(id);

      if (!parent) {
        throw new OperationFailedError(
          'updateSubscription',
          this.providerName,
          {
            cause: new Error(
              'Failed to retrieve subscription after recurrence charge',
            ),
          },
        );
      }

      return parent;
    }

    const subscription = await this.retrieveSubscription(id);

    if (!subscription) {
      throw new ProviderNotSupportedError(
        'updateSubscription',
        this.providerName,
        {
          reason:
            "GoPay doesn't support updating subscription fields directly",
          alternative:
            'Pass provider_metadata.amount to trigger an on-demand recurrence charge instead',
        },
      );
    }

    return subscription;
  };

  cancelSubscription = async (id: string): Promise<Subscription> => {
    const existingSubscription = await this.retrieveSubscription(id);

    if (!existingSubscription) {
      throw new OperationFailedError(
        'cancelSubscription',
        this.providerName,
        {
          cause: new Error('Failed to retrieve subscription'),
        },
      );
    }

    const response = await this._client.post<{
      id: number;
      result: LooseAutoComplete<'FINISHED'>;
    }>(`/payments/payment/${id}/void-recurrence`, {
      headers: {
        ...(await this.tokenManager.getAuthHeaders()),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    return {
      ...existingSubscription,
      ...(response.value?.result == 'FINISHED' && {
        status: 'canceled',
      }),
    };
  };

  deleteSubscription = async (id: string): Promise<null> => {
    await this.cancelSubscription(id);
    return null;
  };

  retrieveSubscription = async (
    id: string,
  ): Promise<Subscription | null> => {
    const response =
      await this._client.get<GoPaySubscriptionResponse>(
        `/payments/payment/${id}`,
        {
          headers: await this.tokenManager.getAuthHeaders(),
        },
      );

    if (!response.ok) {
      throw new OperationFailedError(
        'retrieveSubscription',
        this.providerName,
        {
          cause: new Error('Failed to retrieve subscription'),
        },
      );
    }

    return Subscription$inboundSchema(response.value);
  };

  createPayment = async (
    params: CreatePaymentSchema<GoPayMetadata['payment']>,
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
        isIdCustomer(data.customer)
          ? 'object with id'
          : typeof data.customer,
        {
          provider: this.providerName,
          method: 'createPayment',
        },
      );
    }

    if (!data.item_id) {
      throw new ConfigurationError(
        'item_id is required, this is the name of the item in GoPay',
        {
          provider: this.providerName,
          missingKeys: ['item_id'],
        },
      );
    }

    const successUrl = data.provider_metadata?.success_url as string;

    if (!successUrl) {
      throw new ConfigurationError(
        'success_url is required, this is the URL to redirect the user to the success page after the payment is successful',
        {
          provider: this.providerName,
          missingKeys: ['success_url'],
        },
      );
    }

    const goPayRequest: GoPayPaymentRequest = {
      payer: {
        allowed_payment_instruments: ['PAYMENT_CARD', 'BANK_ACCOUNT'],
        default_payment_instrument: 'PAYMENT_CARD',
        contact: {
          email: data.customer.email as string,
          ...(data.billing && {
            city: data.billing.address.city,
            postal_code: data.billing.address.postal_code,
            country_code: data.billing.address.country,
            phone_number: data.billing.address.phone,
          }),
        },
      },
      target: { type: 'ACCOUNT', goid: parseInt(this.opts.goId) },
      amount: Number(data.amount),
      currency: data.currency?.toUpperCase() ?? 'CZK',
      order_number: crypto
        .randomBytes(8)
        .toString('hex')
        .slice(0, 15),
      order_description: `Payment for ${data.item_id} by ${data.customer.email}`,
      items: [
        {
          name: data.item_id,
          amount: data.amount,
          count: 1,
          type: 'ITEM',
        },
      ],
      lang: data.provider_metadata?.language
        ? (data.provider_metadata.language as string)
        : 'EN',
      callback: {
        return_url: successUrl,
        notification_url: this.opts.webhookUrl,
      },
      preauthorization: false, // automatically captures the payment
      additional_params: Object.entries({
        ...data.metadata,
        // Must use the same key ("item", not "itemId") that
        // Payment$inboundSchema reads back out of additional_params -
        // createCheckout uses this same key for the same reason.
        [PAYKIT_METADATA_KEY]: JSON.stringify({
          item: data.item_id,
          qty: 1,
        }),
      }).map(([name, value]) => ({
        name,
        value: String(value),
      })),
    };

    const responseValue = await this.submitPayment(
      goPayRequest,
      'createPayment',
    );

    return Payment$inboundSchema(responseValue);
  };

  retrievePayment = async (id: string): Promise<Payment | null> => {
    const response = await this._client.get<GoPayPaymentBaseResponse>(
      `/payments/payment/${id}`,
      {
        headers: {
          ...(await this.tokenManager.getAuthHeaders()),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
      },
    );

    if (!response.ok) {
      throw new OperationFailedError(
        'retrievePayment',
        this.providerName,
        {
          cause: new Error('Failed to retrieve payment'),
        },
      );
    }

    return Payment$inboundSchema(response.value);
  };

  deletePayment = async (id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deletePayment',
      this.providerName,
      {
        reason: 'GoPay does not support deleting payments, use the',
        alternative: 'Use createRefund() instead to refund payments',
      },
    );
  };

  capturePayment = async (
    id: string,
    params: CapturePaymentSchema,
  ): Promise<Payment> => {
    const payment = await this._client.get<GoPayPaymentBaseResponse>(
      `/payments/payment/${id}/capture`,
      { headers: await this.tokenManager.getAuthHeaders() },
    );

    if (!payment.ok) {
      throw new OperationFailedError(
        'capturePayment',
        this.providerName,
        {
          cause: new Error('Failed to retrieve payment'),
        },
      );
    }

    const { item, qty } = JSON.parse(
      decodeHtmlEntities(
        payment.value.additional_params?.find(
          param => param.name === PAYKIT_METADATA_KEY,
        )?.value ?? '{}',
      ),
    );

    if (!payment) {
      throw new OperationFailedError(
        'capturePayment',
        this.providerName,
        {
          cause: new Error('Payment not found after capture'),
        },
      );
    }

    const captureBody = {
      amount: params.amount,
      items: [{ name: item, amount: params.amount, count: qty }],
    };

    await this._client.post<{
      id: number;
      result: LooseAutoComplete<'FINISHED'>;
    }>(`/payments/payment/${id}/capture`, {
      body: JSON.stringify(captureBody),
      headers: await this.tokenManager.getAuthHeaders(),
    });

    return Payment$inboundSchema(payment.value);
  };

  cancelPayment = async (id: string): Promise<Payment> => {
    await this._client.post<GoPayPaymentBaseResponse>(
      `/payments/payment/${id}/void-authorization`,
      { headers: await this.tokenManager.getAuthHeaders() },
    );

    const payment = await this.retrievePayment(id);

    if (!payment) {
      throw new OperationFailedError(
        'cancelPayment',
        this.providerName,
        {
          cause: new Error('Payment not found after cancellation'),
        },
      );
    }

    return payment;
  };

  /**
   * Update payment - not supported by GoPay
   */
  updatePayment = async (
    id: string,
    params: UpdatePaymentSchema,
  ): Promise<Payment> => {
    console.info("Gopay doesn't support updating payments");

    const existing = await this.retrievePayment(id);

    if (!existing) {
      throw new OperationFailedError(
        'updatePayment',
        this.providerName,
        {
          cause: new Error('Failed to retrieve payment'),
        },
      );
    }

    return existing;
  };

  async createRefund(params: CreateRefundSchema): Promise<Refund> {
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
      throw new OperationFailedError(
        'createRefund',
        this.providerName,
        {
          cause: new Error('Failed to retrieve payment'),
        },
      );
    }

    const response = await this._client.post<{
      id: number;
      result: LooseAutoComplete<'FINISHED'>;
    }>(`/payments/payment/${data.payment_id}/refund`, {
      body: new URLSearchParams({
        amount: String(data.amount),
      }).toString(),
      headers: {
        ...(await this.tokenManager.getAuthHeaders()),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
    });

    if (!response.ok) {
      throw new OperationFailedError(
        'createRefund',
        this.providerName,
        {
          cause: new Error('Failed to create refund'),
        },
      );
    }

    return {
      id: crypto.randomBytes(8).toString('hex').slice(0, 15),
      amount: data.amount,
      currency: payment.currency,
      reason: data.reason,
      metadata: data.metadata,
    };
  }

  handleWebhook = async (
    payload: WebhookHandlerConfig,
    webhookSecret: string | null,
  ): Promise<Array<WebhookEventPayload<GoPayRawEvents>>> => {
    const { fullUrl } = payload;

    const paymentId = new URL(fullUrl).searchParams.get('id');
    const parentId = new URL(fullUrl).searchParams.get('parent_id'); // For recurring payments i.e subscriptions

    if (!paymentId) {
      throw new WebhookError('Payment ID is required', {
        provider: this.providerName,
      });
    }

    if (this.opts.debug) {
      console.info('Received GoPay webhook for payment:', paymentId);
    }

    const [payment, error] = await tryCatchAsync(
      this._client.get<GoPayPaymentBaseResponse>(
        `/payments/payment/${paymentId}`,
        {
          headers: {
            ...(await this.tokenManager.getAuthHeaders()),
            'Content-Type': 'application/x-www-form-urlencoded',
          },
        },
      ),
    );

    if (error) {
      throw new WebhookError('Failed to retrieve payment', {
        provider: this.providerName,
      });
    }

    if (!payment.value) {
      throw new WebhookError('Payment not found', {
        provider: this.providerName,
      });
    }

    if (this.opts.debug) {
      console.info(
        'Webhook verified successfully, status:',
        payment.value.state,
      );
    }

    const contentPayload = JSON.stringify(payment.value);

    const statusMap: Record<
      string,
      Payment['status'] | '__INDETERMINATE'
    > = {
      CREATED: 'pending',
      PAYMENT_METHOD_CHOSEN: 'processing',
      PAID: 'succeeded',
      AUTHORIZED: 'requires_capture',
      CANCELED: 'canceled',
      TIMEOUTED: 'failed',
      REFUNDED: '__INDETERMINATE', // Payment was successful (refund is separate action)
      PARTIALLY_REFUNDED: '__INDETERMINATE', // Payment was successful (partial refund is another separate action)
    } as const;

    const status = statusMap[payment.value.state];

    const webhookHandlers: Record<
      (typeof statusMap)[keyof typeof statusMap],
      (
        data: GoPayPaymentBaseResponse | GoPaySubscriptionResponse,
      ) => Array<WebhookEventPayload>
    > = {
      __INDETERMINATE: data => {
        const isRefundEvent =
          data.state === 'REFUNDED' ||
          data.state === 'PARTIALLY_REFUNDED';

        if (isRefundEvent) {
          const refund = Refund$inboundSchema(data);

          return [
            paykitEvent$InboundSchema<Refund>({
              type: 'refund.created',
              created: new Date().getTime(),
              id: hashWebhookPayload(
                'refund.created',
                contentPayload,
              ),
              data: refund,
            }),
          ];
        }

        return [];
      },

      pending: data => {
        const payment = Payment$inboundSchema(data);

        return [
          paykitEvent$InboundSchema<Payment>({
            type: 'payment.created',
            created: new Date().getTime(),
            id: hashWebhookPayload('payment.created', contentPayload),
            data: payment,
          }),
        ];
      },
      processing: data => {
        const payment = Payment$inboundSchema(data);

        return [
          paykitEvent$InboundSchema<Payment>({
            type: 'payment.updated',
            created: new Date().getTime(),
            id: hashWebhookPayload('payment.updated', contentPayload),
            data: payment,
          }),
        ];
      },
      requires_capture: data => {
        const payment = Payment$inboundSchema(data);

        return [
          paykitEvent$InboundSchema<Payment>({
            type: 'payment.updated',
            created: new Date().getTime(),
            id: hashWebhookPayload('payment.updated', contentPayload),
            data: payment,
          }),
        ];
      },
      canceled: data => {
        const payment = Payment$inboundSchema(data);

        const isCancellingSubscription =
          parentId &&
          (data as GoPaySubscriptionResponse).recurrence
            ?.recurrence_state == 'STOPPED';

        const subscription = Subscription$inboundSchema(
          data as GoPaySubscriptionResponse,
        );

        const subscriptionCanceledWebhookEvent = {
          type: 'subscription.canceled' as const,
          created: new Date().getTime(),
          id: hashWebhookPayload(
            'subscription.canceled',
            contentPayload,
          ),
          data: subscription,
        };

        return [
          ...(isCancellingSubscription
            ? [
                paykitEvent$InboundSchema<Subscription>(
                  subscriptionCanceledWebhookEvent,
                ),
              ]
            : []),
          paykitEvent$InboundSchema<Payment>({
            type: 'payment.failed',
            created: new Date().getTime(),
            id: hashWebhookPayload('payment.failed', contentPayload),
            data: payment,
          }),
        ];
      },
      failed: data => {
        const payment = Payment$inboundSchema(data);

        return [
          paykitEvent$InboundSchema<Payment>({
            type: 'payment.failed',
            created: new Date().getTime(),
            id: hashWebhookPayload('payment.failed', contentPayload),
            data: payment,
          }),
        ];
      },
      succeeded: data => {
        const payment = Payment$inboundSchema(data);
        const invoice = Invoice$inboundSchema(data, !!parentId);
        const subscription = Subscription$inboundSchema(
          data as GoPaySubscriptionResponse,
        );

        const subscriptionCreatedWebhookEvent = {
          type: 'subscription.created' as const,
          created: new Date().getTime(),
          id: hashWebhookPayload(
            'subscription.created',
            contentPayload,
          ),
          data: subscription,
        };

        return [
          ...(parentId
            ? [
                paykitEvent$InboundSchema<Subscription>(
                  subscriptionCreatedWebhookEvent,
                ),
              ]
            : []),
          paykitEvent$InboundSchema<Invoice>({
            type: 'invoice.generated',
            created: new Date().getTime(),
            id: hashWebhookPayload(
              'invoice.generated',
              contentPayload,
            ),
            data: invoice,
          }),
          paykitEvent$InboundSchema<Payment>({
            type: 'payment.succeeded',
            created: new Date().getTime(),
            id: hashWebhookPayload(
              'payment.succeeded',
              contentPayload,
            ),
            data: payment,
          }),
        ];
      },
      requires_action: data => {
        const payment = Payment$inboundSchema(data);

        return [
          paykitEvent$InboundSchema<Payment>({
            type: 'payment.updated',
            created: new Date().getTime(),
            id: hashWebhookPayload('payment.updated', contentPayload),
            data: payment,
          }),
        ];
      },
    };

    const handler = webhookHandlers[status];

    if (!handler) {
      throw new WebhookError(
        `Invalid webhook status: ${status}, expected one of ${Object.keys(webhookHandlers).join(', ')}`,
        {
          provider: this.providerName,
        },
      );
    }

    const results = handler(payment.value);

    return results;
  };
}
