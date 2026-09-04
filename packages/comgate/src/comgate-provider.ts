import {
  Customer,
  HTTPClient,
  PayKitProvider,
  Subscription,
  UpdateCustomerParams,
  UpdateSubscriptionSchema,
  WebhookEventPayload,
  validateRequiredKeys,
  CreatePaymentSchema,
  CreateRefundSchema,
  CreateSubscriptionSchema,
  Payment,
  Refund,
  UpdateCheckoutSchema,
  UpdatePaymentSchema,
  createRefundSchema,
  createPaymentSchema,
  ProviderNotSupportedError,
  WebhookError,
  paykitEvent$InboundSchema,
  Invoice,
  PaykitProviderOptions,
  OperationFailedError,
  Result,
  CapturePaymentSchema,
  capturePaymentSchema,
  ValidationError,
  InvalidTypeError,
  schema,
  AbstractPayKitProvider,
  isIdCustomer,
  isEmailCustomer,
  ProviderMetadataRegistry,
  WebhookHandlerConfig,
  hashWebhookPayload,
} from '@paykit-sdk/core';
import {
  CreateCheckoutSchema,
  CreateCustomerParams,
} from '@paykit-sdk/core';
import { Checkout } from '@paykit-sdk/core';
import { timingSafeEqual } from 'crypto';
import { z } from 'zod';
import {
  ComgatePaymentOperationResponse,
  ComgateRefundResponse,
  ComgateWebhookStatusResponseBase,
  ComgateWebhookStatusSuccessResponse,
} from './schema';
import {
  Invoice$inboundSchema,
  Payment$inboundSchema,
} from './utils/mapper';

interface ComgateMetadata extends ProviderMetadataRegistry {}

interface ComgateRawEvents extends Record<string, any> {}

export interface ComgateOptions extends PaykitProviderOptions {
  /**
   * The merchant ID
   */
  merchant: string;

  /**
   * The secret key
   */
  secret: string;

  /**
   * Whether to use the sandbox environment
   */
  isSandbox: boolean;
}

const comgateOptionsSchema = schema<ComgateOptions>()(
  z.object({
    merchant: z.string(),
    secret: z.string(),
    isSandbox: z.boolean(),
  }),
);

const providerName = 'comgate';

export class ComgateProvider
  extends AbstractPayKitProvider
  implements
    PayKitProvider<ComgateMetadata, HTTPClient, ComgateRawEvents>
{
  readonly providerName = providerName;
  private baseUrl: string;
  readonly isSandbox: boolean;
  private _client: HTTPClient;

  constructor(private readonly opts: ComgateOptions) {
    super(comgateOptionsSchema, opts, providerName);

    const debug = opts.debug ?? true;

    this.baseUrl = opts.isSandbox
      ? 'https://sandbox.comgate.cz'
      : 'https://payments.comgate.cz';

    this._client = new HTTPClient({
      baseUrl: this.baseUrl,
      headers: {
        Authorization: `Basic ${Buffer.from(opts.merchant + ':' + opts.secret).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        Accept: 'application/x-www-form-urlencoded',
      },
      retryOptions: { max: 3, baseDelay: 1000, debug },
    });
    this.isSandbox = opts.isSandbox;
  }

  get _native(): HTTPClient {
    return this._client;
  }

  private _throwOnError = <T>(
    req: Result<T extends { code: number } ? T : never>,
    message: string,
  ) => {
    if (!req.ok)
      throw new OperationFailedError(message, this.providerName, {
        cause: new Error(req.error as string),
      });

    if (req.value.code == 1100) {
      throw new OperationFailedError(
        'Unknown error',
        this.providerName,
        {
          cause: new Error('Unknown error'),
        },
      );
    }

    if (req.value.code == 1200) {
      throw new OperationFailedError(
        'Database error',
        this.providerName,
        {
          cause: new Error('Database error'),
        },
      );
    }

    if (req.value.code == 1400) {
      throw new OperationFailedError(
        'Wrong query error',
        this.providerName,
        {
          cause: new Error('Wrong query error'),
        },
      );
    }

    if (req.value.code == 1500) {
      throw new OperationFailedError(
        'Unexpected error',
        this.providerName,
        {
          cause: new Error('Unexpected error'),
        },
      );
    }

    return req.value as T;
  };

  createCheckout = async (
    params: CreateCheckoutSchema,
  ): Promise<Checkout> => {
    const { error, data } = createPaymentSchema.safeParse(params);

    if (error) throw new Error(error.message.split('\n').join(' '));

    if (!isEmailCustomer(data.customer)) {
      throw new InvalidTypeError(
        'customer',
        'object with email',
        data.customer === null ? 'null' : 'object with id',
        {
          provider: this.providerName,
          method: 'createCheckout',
        },
      );
    }

    const requestBody = new URLSearchParams({
      code: '0',
      test: this.opts.isSandbox ? 'true' : 'false',
      refId: JSON.stringify(data.metadata ?? {}),
      email: data.customer.email,
      payerId: data.customer.email,
      price: String(data.amount),
      curr: String(data.currency),
      label: data.provider_metadata?.label
        ? String(data.provider_metadata.label)
        : 'Order from Eshop',
    });

    if (this.opts.debug) {
      console.log(
        'Creating payment with data:',
        requestBody.toString(),
      );
    }

    const response =
      await this._client.post<ComgatePaymentOperationResponse>(
        `/v2.0/paymentRedirect/merchant/${this.opts.merchant}`,
        {
          body: requestBody.toString(),
        },
      );

    if (!response.ok) {
      throw new OperationFailedError(
        `Failed to create payment`,
        this.providerName,
        {
          cause: new Error('Unknown error'),
        },
      );
    }

    this._throwOnError(response, 'Failed to create payment');

    // The user will be automatically redirected to the checkout page
    return null as unknown as Checkout;
  };

  updateCheckout = async (
    id: string,
    params: UpdateCheckoutSchema,
  ): Promise<Checkout> => {
    throw new ProviderNotSupportedError('updateCheckout', 'Comgate', {
      reason: 'Comgate does not support updating checkouts',
      alternative: 'Create a new checkout instead',
    });
  };

  deleteCheckout = async (id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deleteCheckout', 'Comgate', {
      reason: 'Comgate does not support deleting checkouts',
      alternative: 'Create a new checkout instead',
    });
  };

  retrieveCheckout = async (id: string): Promise<Checkout> => {
    throw new ProviderNotSupportedError(
      'retrieveCheckout',
      'Comgate',
      {
        reason:
          'Comgate does not support retrieving checkouts, use the payment API instead',
        alternative: 'Use the payment API instead',
      },
    );
  };

  createCustomer = async (
    params: CreateCustomerParams,
  ): Promise<Customer> => {
    throw new ProviderNotSupportedError('createCustomer', 'Comgate', {
      reason: 'Comgate does not support creating customers',
      alternative: 'Use the payment API instead',
    });
  };

  retrieveCustomer = async (id: string): Promise<Customer | null> => {
    throw new ProviderNotSupportedError(
      'retrieveCustomer',
      'Comgate',
      {
        reason: 'Comgate does not support retrieving customers',
        alternative: 'Use the payment API instead',
      },
    );
  };

  updateCustomer = async (
    id: string,
    params: UpdateCustomerParams,
  ): Promise<Customer> => {
    throw new ProviderNotSupportedError('updateCustomer', 'Comgate', {
      reason: 'Comgate does not support updating customers',
      alternative: 'Use the payment API instead',
    });
  };

  deleteCustomer = async (id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deleteCustomer', 'Comgate', {
      reason: 'Comgate does not support deleting customers',
      alternative: 'Use the payment API instead',
    });
  };

  createPayment = async (
    params: CreatePaymentSchema,
  ): Promise<Payment> => {
    const { error, data } = createPaymentSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createPayment',
      );
    }

    const { customer } = data;

    if (!isIdCustomer(customer)) {
      throw new InvalidTypeError(
        'customer',
        'object with id',
        customer === null ? 'null' : 'object with email',
        {
          provider: this.providerName,
          method: 'createPayment',
        },
      );
    }

    const payerId = String(customer.id);

    const { email, paymentLabel = 'Order from Eshop' } =
      validateRequiredKeys(
        ['email', 'paymentLabel'],
        (data.provider_metadata as Record<string, string>) ?? {},
        'Missing required provider metadata: {keys}',
      );

    if (this.opts.debug) {
      console.log('Creating payment with metadata:', {
        email,
        paymentLabel,
      });
    }

    const requestBody = new URLSearchParams({
      code: '0',
      test: this.opts.isSandbox ? 'true' : 'false',
      refId: JSON.stringify(data.metadata ?? {}),
      payerId,
      price: String(data.amount),
      email,
      curr: String(data.currency),
      label: String(paymentLabel),
    });

    const response =
      await this._client.post<ComgatePaymentOperationResponse>(
        `/v2.0/payment`,
        {
          body: requestBody.toString(),
        },
      );

    this._throwOnError(response, 'Failed to create payment');

    const paymentObject: Payment = {
      id: response.value!.transId!,
      amount: data.amount,
      currency: data.currency,
      status: 'pending',
      metadata: Object.fromEntries(
        Object.entries(data.metadata ?? {}).map(([key, value]) => [
          key,
          String(value),
        ]),
      ),
      customer: isIdCustomer(customer) ? customer : null,
      item_id: data.item_id ?? null,
      requires_action: false,
      payment_url: response.value!.redirect ?? null,
    };

    return paymentObject;
  };

  updatePayment = async (
    _id: string,
    _params: UpdatePaymentSchema,
  ): Promise<Payment> => {
    throw new ProviderNotSupportedError('updatePayment', 'Comgate', {
      reason: 'Comgate does not support payment updates',
      alternative: 'Create a new payment instead',
    });
  };

  deletePayment = async (id: string): Promise<null> => {
    const response = await this._client.delete(
      `/v2.0/payment/${id}.json`,
    );

    if (!response.ok) {
      throw new OperationFailedError(
        `Failed to delete payment`,
        this.providerName,
        {
          cause: new Error('Unknown error'),
        },
      );
    }

    return null;
  };

  retrievePayment = async (id: string): Promise<Payment | null> => {
    const { error } = createPaymentSchema.safeParse({ id });
    if (error)
      throw new Error(
        `Payment retrieval validation failed: ${error.message}`,
      );

    const response = await this._client.get<Record<string, any>>(
      `/v2.0/payment/${id}.json`,
    );

    if (!response.ok) {
      throw new OperationFailedError(
        `Failed to retrieve payment`,
        this.providerName,
        {
          cause: new Error('Unknown error'),
        },
      );
    }

    return response.value as unknown as Payment;
  };

  capturePayment = async (
    id: string,
    params: CapturePaymentSchema,
  ): Promise<Payment> => {
    const { error, data } = capturePaymentSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'capturePayment',
      );
    }

    const response =
      await this._client.post<ComgatePaymentOperationResponse>(
        `/v2.0/preauth/${id}/confirm.json`,
        {
          body: new URLSearchParams({
            amount: String(data.amount),
          }).toString(),
        },
      );

    this._throwOnError(response, 'Failed to capture payment');

    const paymentObject: Payment = {
      id: response.value!.transId!,
      amount: Number(data.amount),
      currency: 'CZK',
      status: 'succeeded',
      metadata: {},
      customer: null,
      item_id: null,
      requires_action: false,
      payment_url: response.value!.redirect ?? null,
    };

    return paymentObject;
  };

  cancelPayment = async (id: string): Promise<Payment> => {
    const response =
      await this._client.delete<ComgatePaymentOperationResponse>(
        `/v2.0/payment/transId/${id}.json`,
        {},
      );

    this._throwOnError(response, 'Failed to cancel payment');

    return response.value as unknown as Payment;
  };

  /**
   * Creates a refund for a paid payment
   */
  createRefund = async (
    params: CreateRefundSchema,
  ): Promise<Refund> => {
    const { error, data } = createRefundSchema.safeParse(params);

    if (error) throw new Error(error.message);

    const requestBody = new URLSearchParams({
      transId: data.payment_id,
      amount: String(data.amount),
      test: this.opts.isSandbox ? 'true' : 'false',
      refId: JSON.stringify(data.metadata ?? {}),
    });

    const response = await this._client.post<ComgateRefundResponse>(
      '/v2.0/refund.json',
      {
        body: requestBody.toString(),
      },
    );

    this._throwOnError(response, 'Failed to create refund');

    const refundObject: Refund = {
      id: `paykit:refund:${Math.random().toString(36).substring(2, 15)}`,
      amount: data.amount,
      currency: 'CZK',
      reason: data.reason,
      metadata: {
        ...Object.fromEntries(
          Object.entries(data.metadata ?? {}).map(([key, value]) => [
            key,
            String(value),
          ]),
        ),
        ...(response.value?.code
          ? { __comgate_refund_code: String(response.value.code) }
          : {}),
        ...(response.value?.message && {
          __comgate_refund_message: response.value.message,
        }),
      },
    };

    return refundObject;
  };

  createSubscription = async (
    params: CreateSubscriptionSchema,
  ): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'createSubscription',
      'Comgate',
      {
        reason: 'Comgate does not support creating subscriptions',
        alternative:
          'Use the payment API instead and create a subscription manually',
      },
    );
  };

  deleteSubscription = async (id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deleteSubscription',
      'Comgate',
      {
        reason: 'Comgate does not support deleting subscriptions',
        alternative:
          'Use the payment API instead and delete the subscription manually',
      },
    );
  };

  updateSubscription = async (
    id: string,
    params: UpdateSubscriptionSchema,
  ): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'updateSubscription',
      'Comgate',
      {
        reason: 'Comgate does not support updating subscriptions',
        alternative:
          'Use the payment API instead and update the subscription manually',
      },
    );
  };

  retrieveSubscription = async (
    id: string,
  ): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'retrieveSubscription',
      'Comgate',
      {
        reason: 'Comgate does not support retrieving subscriptions',
        alternative:
          'Use the payment API instead and retrieve the subscription manually',
      },
    );
  };

  cancelSubscription = async (id: string): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'cancelSubscription',
      'Comgate',
      {
        reason: 'Comgate does not support canceling subscriptions',
        alternative:
          'Use the payment API instead and cancel the subscription manually',
      },
    );
  };

  handleWebhook = async (
    payload: WebhookHandlerConfig,
    webhookSecret: string | null,
  ): Promise<Array<WebhookEventPayload<ComgateRawEvents>>> => {
    const { body: rawBody, headersAsObject } = payload;
    let body: Record<string, unknown>;

    const contentType = headersAsObject['content-type'];

    if (contentType === 'application/json') {
      // REST API (v2.0) - JSON format
      body = JSON.parse(rawBody) as Record<string, unknown>;
    } else {
      // HTTP POST API (v1.0) - x-www-form-urlencoded format
      body = Object.fromEntries(new URLSearchParams(rawBody));
    }

    if (!body || typeof body !== 'object') {
      throw new WebhookError('Invalid webhook payload', {
        provider: this.providerName,
      });
    }

    if (this.opts.debug) {
      console.info('Verifying webhook...');
    }

    const {
      merchant,
      secret,
      transId,
      status: webhookStatusOut,
    } = validateRequiredKeys(
      ['merchant', 'secret', 'transId', 'status'],
      body as Record<string, string>,
      'Missing required webhook parameters: {keys}',
    );

    const secretBuf = Buffer.from(secret);
    const expectedSecretBuf = Buffer.from(this.opts.secret);

    if (
      secretBuf.length !== expectedSecretBuf.length ||
      !timingSafeEqual(secretBuf, expectedSecretBuf)
    ) {
      throw new WebhookError('Webhook secret mismatch', {
        provider: this.providerName,
      });
    }

    if (merchant !== this.opts.merchant) {
      throw new WebhookError('Webhook merchant mismatch', {
        provider: this.providerName,
      });
    }

    // Verify the webhook
    const verifyResponse =
      await this._client.post<ComgateWebhookStatusResponseBase>(
        '/v1.0/status',
        {
          body: new URLSearchParams({
            merchant: this.opts.merchant,
            transId,
            secret: this.opts.secret,
          }).toString(),
        },
      );

    this._throwOnError(verifyResponse, 'Failed to verify webhook');

    const comgateWebhookApiResponse =
      verifyResponse.value as ComgateWebhookStatusSuccessResponse;

    if (this.opts.debug) {
      console.info(
        'Webhook verified successfully, status:',
        comgateWebhookApiResponse.status,
      );
    }

    if (!comgateWebhookApiResponse.status) {
      throw new WebhookError(
        'Failed to verify webhook: no status returned',
      );
    }

    if (comgateWebhookApiResponse.status !== webhookStatusOut) {
      throw new WebhookError(
        `Webhook status mismatch: received ${webhookStatusOut}, verified ${comgateWebhookApiResponse.status}`,
      );
    }

    const statusMap: Record<string, Payment['status']> = {
      PAID: 'succeeded',
      CANCELLED: 'canceled',
      AUTHORIZED: 'requires_capture',
      PENDING: 'pending',
    };

    const status = statusMap[comgateWebhookApiResponse.status];

    const contentHash = hashWebhookPayload(webhookStatusOut, rawBody);

    const webhookHandlers: Partial<
      Record<
        Payment['status'],
        (
          data: ComgateWebhookStatusSuccessResponse,
        ) => Array<WebhookEventPayload>
      >
    > = {
      pending: data => {
        const payment = Payment$inboundSchema(data, 'pending');

        return [
          paykitEvent$InboundSchema<Payment>({
            type: 'payment.created',
            created: new Date().getTime(),
            id: `paykit:payment:${contentHash}`,
            data: payment,
          }),
        ];
      },
      requires_capture: data => {
        const payment = Payment$inboundSchema(
          data,
          'requires_capture',
        );

        return [
          paykitEvent$InboundSchema<Payment>({
            type: 'payment.updated',
            created: new Date().getTime(),
            id: `paykit:payment:${contentHash}`,
            data: payment,
          }),
        ];
      },

      canceled: data => {
        const payment = Payment$inboundSchema(data, 'canceled');

        return [
          paykitEvent$InboundSchema<Payment>({
            type: 'payment.failed',
            created: new Date().getTime(),
            id: `paykit:payment:${contentHash}`,
            data: payment,
          }),
        ];
      },

      succeeded: data => {
        const invoice = Invoice$inboundSchema(data);
        const payment = Payment$inboundSchema(data, 'succeeded');

        return [
          paykitEvent$InboundSchema<Payment>({
            type: 'payment.succeeded',
            created: new Date().getTime(),
            id: `paykit:payment:${contentHash}`,
            data: payment,
          }),
          paykitEvent$InboundSchema<Invoice>({
            type: 'invoice.generated',
            created: new Date().getTime(),
            id: `paykit:invoice:${contentHash}`,
            data: invoice,
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

    const results = handler(comgateWebhookApiResponse);

    return results;
  };
}
