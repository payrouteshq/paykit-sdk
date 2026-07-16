import {
  paykitEvent$InboundSchema,
  WebhookEventPayload,
  CreateCustomerParams,
  Customer,
  UpdateCustomerParams,
  Checkout,
  CreateCheckoutSchema,
  Subscription,
  UpdateSubscriptionSchema,
  PayKitProvider,
  PaykitProviderOptions,
  Invoice,
  billingModeSchema,
  CreatePaymentSchema,
  Payment,
  UpdatePaymentSchema,
  createPaymentSchema,
  updatePaymentSchema,
  CreateRefundSchema,
  CreateSubscriptionSchema,
  Refund,
  UpdateCheckoutSchema,
  updateCheckoutSchema,
  createRefundSchema,
  createCheckoutSchema,
  retrieveCheckoutSchema,
  createCustomerSchema,
  updateCustomerSchema,
  retrieveCustomerSchema,
  retrieveSubscriptionSchema,
  updateSubscriptionSchema,
  ProviderNotSupportedError,
  OperationFailedError,
  ValidationError,
  ResourceNotFoundError,
  CapturePaymentSchema,
  capturePaymentSchema,
  schema,
  AbstractPayKitProvider,
  PAYKIT_METADATA_KEY,
  stringifyMetadataValues,
  refundReasonMatcher,
  Schema,
  WebhookHandlerConfig,
  ProviderMetadataRegistry,
  parseCustomerName,
  isEmailCustomer,
  isIdCustomer,
  WebhookError,
} from '@paykit-sdk/core';
import { Polar, SDKOptions, ServerList } from '@polar-sh/sdk';
import { AddressInputCountryAlpha2Input } from '@polar-sh/sdk/models/components/addressinput.js';
import { CheckoutCreate } from '@polar-sh/sdk/models/components/checkoutcreate.js';
import { Customer as PolarCustomer } from '@polar-sh/sdk/models/components/customer.js';
import { Order as PolarOrder } from '@polar-sh/sdk/models/components/order.js';
import { PresentmentCurrency } from '@polar-sh/sdk/models/components/presentmentcurrency.js';
import { Refund as PolarRefund } from '@polar-sh/sdk/models/components/refund.js';
import { RefundReason } from '@polar-sh/sdk/models/components/refundreason.js';
import { Subscription as PolarSubscription } from '@polar-sh/sdk/models/components/subscription.js';
import { SubscriptionUpdateBase } from '@polar-sh/sdk/models/components/subscriptionupdatebase.js';
import { Refunds } from '@polar-sh/sdk/sdk/refunds.js';
import { validateEvent } from '@polar-sh/sdk/webhooks';
import {
  Checkout$inboundSchema,
  Customer$inboundSchema,
  Invoice$inboundSchema,
  Payment$inboundSchema,
  Refund$inboundSchema,
  Subscription$inboundSchema,
} from '../lib/mapper';

interface PolarMetadata extends ProviderMetadataRegistry {}

type PolarWebhookPayload = ReturnType<typeof validateEvent>;

type PolarRawEvents = {
  [E in PolarWebhookPayload as `polar.${E['type']}`]: E;
};

export interface PolarOptions
  extends PaykitProviderOptions,
    Pick<SDKOptions, 'userAgent' | 'retryConfig' | 'timeoutMs'> {
  accessToken: string;
  isSandbox: boolean;
}

const polarOptionsSchema = schema<PolarOptions>()(
  Schema.object({
    accessToken: Schema.string(),
    isSandbox: Schema.boolean(),
    debug: Schema.boolean().optional(),
    userAgent: Schema.string().optional(),
    retryConfig: Schema.any().optional(),
    timeoutMs: Schema.number().optional(),
  }),
);

const providerName = 'polar';

export class PolarProvider
  extends AbstractPayKitProvider
  implements PayKitProvider<PolarMetadata, Polar, PolarRawEvents>
{
  readonly providerName = providerName;

  private polar: Polar;
  private refunds: Refunds;

  readonly isSandbox: boolean;

  private readonly productionURL = ServerList['production'];
  private readonly sandboxURL = ServerList['sandbox'];

  constructor(private config: PolarOptions) {
    super(polarOptionsSchema, config, providerName);

    const { accessToken, isSandbox, debug = true, ...rest } = config;

    const serverURL = isSandbox
      ? this.sandboxURL
      : this.productionURL;

    this.polar = new Polar({ accessToken, serverURL, ...rest });
    this.refunds = new Refunds({ accessToken, serverURL, ...rest });
    this.isSandbox = isSandbox;
  }

  get _native() {
    return this.polar;
  }

  private applyCustomer(
    options: CheckoutCreate,
    customer: unknown,
  ): void {
    if (isIdCustomer(customer)) {
      options.customerId = String(customer.id);
    } else if (isEmailCustomer(customer)) {
      options.customerEmail = customer.email;
    }
  }

  createCheckout = async (
    params: CreateCheckoutSchema,
  ): Promise<Checkout> => {
    const { error, data } = createCheckoutSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createCheckout',
      );
    }

    const { metadata, item_id, provider_metadata } = data;

    const checkoutMetadata = stringifyMetadataValues(metadata ?? {});

    const checkoutCreateOptions: CheckoutCreate = {
      ...provider_metadata,
      metadata: checkoutMetadata,
      products: [item_id],
      successUrl: data.success_url,
    };

    this.applyCustomer(checkoutCreateOptions, data.customer);

    if (data.billing) {
      checkoutCreateOptions.customerBillingAddress = {
        line1: data.billing.address.line1,
        line2: data.billing.address.line2,
        postalCode: data.billing.address.postal_code,
        city: data.billing.address.city,
        country: data.billing.address
          .country as AddressInputCountryAlpha2Input,
        state: data.billing.address.state,
      };

      checkoutCreateOptions.metadata = {
        ...checkoutMetadata,
        _shipping_phone: data.billing.address.phone ?? '',
        _shipping_carrier: data.billing.carrier ?? '',
      };
    }

    const response = await this.polar.checkouts.create(
      checkoutCreateOptions,
    );

    return Checkout$inboundSchema(response);
  };

  updateCheckout = async (
    id: string,
    params: UpdateCheckoutSchema,
  ): Promise<Checkout> => {
    const { error, data } = updateCheckoutSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'updateCheckout',
      );
    }

    const { metadata, item_id, provider_metadata, ...restData } =
      data;

    const response = await this.polar.checkouts.update({
      id,
      checkoutUpdate: {
        ...restData,
        ...(metadata && {
          metadata: stringifyMetadataValues(metadata ?? {}),
        }),
        ...(item_id && { products: [item_id] }),
        ...provider_metadata,
      },
    });

    return Checkout$inboundSchema(response);
  };

  retrieveCheckout = async (id: string): Promise<Checkout> => {
    const { error } = retrieveCheckoutSchema.safeParse({ id });

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'retrieveCheckout',
      );
    }

    const response = await this.polar.checkouts.get({ id });

    return Checkout$inboundSchema(response);
  };

  deleteCheckout = async (id: string): Promise<null> => {
    throw new ProviderNotSupportedError('deleteCheckout', 'Polar', {
      reason: 'Polar does not support deleting checkouts',
    });
  };

  /**
   * Customer management
   */
  createCustomer = async (
    params: CreateCustomerParams,
  ): Promise<Customer> => {
    const { error, data } = createCustomerSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createCustomer',
      );
    }

    const { email, metadata } = data;

    const { fullName: name } = parseCustomerName({
      name: data.name,
      email,
    });

    const response = await this.polar.customers.create({
      email,
      name,
      metadata: {
        ...metadata,
        [PAYKIT_METADATA_KEY]: JSON.stringify({
          phone: data?.phone ?? null,
        }),
      },
      ...data.provider_metadata,
    });

    return Customer$inboundSchema(response);
  };

  updateCustomer = async (
    id: string,
    params: UpdateCustomerParams,
  ): Promise<Customer> => {
    const { error, data } = updateCustomerSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'retrieveCustomer',
      );
    }

    const { email, name, metadata, provider_metadata } = data;

    const response = await this.polar.customers.update({
      id,
      customerUpdate: {
        ...(email && { email }),
        ...(name && { name }),
        ...(metadata && { metadata }),
        ...provider_metadata,
      },
    });

    return Customer$inboundSchema(response);
  };

  retrieveCustomer = async (id: string): Promise<Customer> => {
    const { error } = retrieveCustomerSchema.safeParse({ id });

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'retrieveCustomer',
      );
    }

    const response = await this.polar.customers.get({ id });

    return Customer$inboundSchema(response);
  };

  deleteCustomer = async (id: string): Promise<null> => {
    const customer = await this.polar.customers.get({ id });

    if (customer) await this.polar.customers.delete({ id });

    return null;
  };

  /**
   * Subscription management
   */
  createSubscription = async (
    params: CreateSubscriptionSchema,
  ): Promise<Subscription> => {
    throw new ProviderNotSupportedError(
      'createSubscription',
      'Polar',
      {
        reason: 'Subscriptions can only be created through checkouts',
      },
    );
  };

  cancelSubscription = async (id: string): Promise<Subscription> => {
    const { error } = retrieveSubscriptionSchema.safeParse({ id });

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'retrieveSubscription',
      );
    }

    const subscription = await this.polar.subscriptions.revoke({
      id,
    });

    return Subscription$inboundSchema(subscription);
  };

  retrieveSubscription = async (
    id: string,
  ): Promise<Subscription> => {
    const { error } = retrieveSubscriptionSchema.safeParse({ id });

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'retrieveSubscription',
      );
    }

    const response = await this.polar.subscriptions.get({ id });

    return Subscription$inboundSchema(response);
  };

  updateSubscription = async (
    id: string,
    params: UpdateSubscriptionSchema,
  ): Promise<Subscription> => {
    const { error, data } = updateSubscriptionSchema.safeParse({
      id,
      ...params,
    });

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'updateSubscription',
      );
    }

    if (
      !data.provider_metadata ||
      Object.keys(data.provider_metadata).length === 0
    ) {
      throw new ValidationError(
        'Polar requires specific update type via provider_metadata. ' +
          'Use one of: { productId: string } | { discountId: string } | { trialEnd: Date }',
        { provider: this.providerName, method: 'updateSubscription' },
      );
    }

    const response = await this.polar.subscriptions.update({
      id,
      subscriptionUpdate:
        data.provider_metadata as SubscriptionUpdateBase,
    });

    return Subscription$inboundSchema(response);
  };

  deleteSubscription = async (id: string): Promise<null> => {
    const { error } = retrieveSubscriptionSchema.safeParse({ id });

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'deleteSubscription',
      );
    }

    return (await this.cancelSubscription(id)) === null ? null : null;
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

    const paymentMetadata = stringifyMetadataValues(
      data.metadata ?? {},
    );

    const checkoutCreateOptions: CheckoutCreate = {
      ...(data.provider_metadata && { ...data.provider_metadata }),
      amount: data.amount,
      metadata: paymentMetadata,
      products: data.item_id ? [data.item_id] : [],
    };

    this.applyCustomer(checkoutCreateOptions, data.customer);

    if (data.billing) {
      checkoutCreateOptions.customerBillingAddress = {
        line1: data.billing.address.line1,
        line2: data.billing.address.line2,
        postalCode: data.billing.address.postal_code,
        city: data.billing.address.city,
        country: data.billing.address
          .country as AddressInputCountryAlpha2Input,
        state: data.billing.address.state,
      };

      checkoutCreateOptions.metadata = {
        ...paymentMetadata,
        [PAYKIT_METADATA_KEY]: JSON.stringify({
          _shipping_phone: data.billing.address.phone ?? '',
          _shipping_carrier: data.billing.carrier ?? '',
        }),
      };
    }

    const checkoutResponse = await this.polar.checkouts.create(
      checkoutCreateOptions,
    );

    return Payment$inboundSchema(checkoutResponse);
  };

  updatePayment = async (
    id: string,
    params: UpdatePaymentSchema,
  ): Promise<Payment> => {
    const { error, data } = updatePaymentSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'updatePayment',
      );
    }

    const { provider_metadata, ...rest } = data;

    const paymentMetadata = stringifyMetadataValues(
      rest.metadata ?? {},
    );

    const checkoutResponse = await this.polar.checkouts.update({
      id,
      checkoutUpdate: {
        ...provider_metadata,
        ...(rest.metadata && { metadata: paymentMetadata }),
        ...(rest.item_id && { products: [rest.item_id] }),
        ...(rest.amount && { amount: rest.amount }),
        ...(rest.currency && {
          currency:
            rest.currency.toLowerCase() as PresentmentCurrency,
        }),
      },
    });

    return Payment$inboundSchema(checkoutResponse);
  };

  capturePayment = async (
    id: string,
    params: CapturePaymentSchema,
  ): Promise<Payment> => {
    const { data: _, error } = capturePaymentSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'capturePayment',
      );
    }

    return this.retrievePayment(id); // payments are auto-captured by polar, just return the current state
  };

  cancelPayment = async (id: string): Promise<Payment> => {
    throw new ProviderNotSupportedError(
      'cancelPayment',
      this.providerName,
      {
        reason: 'Polar does not support canceling payments',
      },
    );
  };

  deletePayment = async (id: string): Promise<null> => {
    throw new ProviderNotSupportedError(
      'deletePayment',
      this.providerName,
      {
        reason: 'Polar does not support deleting payments',
      },
    );
  };

  retrievePayment = async (id: string): Promise<Payment> => {
    const response = await this.polar.checkouts.get({ id });

    return Payment$inboundSchema(response);
  };

  createRefund = async (
    params: CreateRefundSchema,
  ): Promise<Refund> => {
    const { error, data } = createRefundSchema.safeParse(params);

    if (error) {
      throw ValidationError.fromZodError(
        error,
        this.providerName,
        'createRefund',
      );
    }

    const order = await this.polar.orders.get({
      id: data.payment_id,
    });

    if (!order) {
      throw new ResourceNotFoundError(
        'Order',
        data.payment_id,
        this.providerName,
      );
    }

    const matched = refundReasonMatcher(data.reason ?? '');

    const reasonMap: Record<string, RefundReason> = {
      duplicate: 'duplicate',
      fraudulent: 'fraudulent',
      requested_by_customer: 'customer_request',
      customer_request: 'customer_request',
    };

    const reason = reasonMap[matched] ?? 'other';

    if (reason === 'other') {
      console.warn(
        `[Polar Provider] Unmapped refund reason: "${data.reason}" -> defaulting to "other"`,
      );
    }

    const refund = await this.refunds.create({
      orderId: order.id,
      reason,
      amount: data.amount,
      ...(data.provider_metadata && { ...data.provider_metadata }),
    });

    if (!refund) {
      throw new OperationFailedError(
        'Failed to create refund',
        this.providerName,
      );
    }

    return Refund$inboundSchema(refund);
  };

  handleWebhook = async (
    params: WebhookHandlerConfig,
    webhookSecret: string | null,
  ): Promise<Array<WebhookEventPayload<PolarRawEvents>>> => {
    if (!webhookSecret) {
      throw new WebhookError(
        'webhookSecret is required for Polar webhook verification',
        { provider: this.providerName },
      );
    }

    const { body, headersAsObject } = params;

    const webhookId = (headersAsObject['webhook-id'] || '') as string;
    const webhookTimestamp = (headersAsObject['webhook-timestamp'] ||
      '0') as string;

    const { data, type } = validateEvent(
      body,
      headersAsObject,
      webhookSecret,
    );

    const results: Array<WebhookEventPayload<PolarRawEvents>> = [];

    results.push({
      id: webhookId,
      type: `polar.${type}`,
      created: parseInt(webhookTimestamp),
      data: data as any,
      is_raw: true,
    });

    const processStandard = (): Array<
      WebhookEventPayload<PolarRawEvents>
    > | null => {
      switch (type) {
        case 'order.paid': {
          const polarOrder = data as PolarOrder;
          const isSubscription = [
            'subscription_create',
            'subscription_cycle',
          ].includes(polarOrder.billingReason);

          return [
            paykitEvent$InboundSchema<Payment>({
              type: 'payment.succeeded',
              created: parseInt(webhookTimestamp),
              id: webhookId,
              data: {
                id: polarOrder.id,
                amount: polarOrder.totalAmount,
                currency: polarOrder.currency,
                customer: polarOrder.customerId
                  ? { id: polarOrder.customerId }
                  : polarOrder.customer?.email
                    ? { email: polarOrder.customer.email }
                    : null,
                status: 'succeeded',
                metadata: stringifyMetadataValues(
                  polarOrder.metadata ?? {},
                ),
                item_id:
                  polarOrder.product?.id ?? polarOrder.productId,
                requires_action: false,
                payment_url: null,
              },
            }),
            paykitEvent$InboundSchema<Invoice>({
              type: 'invoice.generated',
              created: parseInt(webhookTimestamp),
              id: webhookId,
              data: Invoice$inboundSchema({
                ...polarOrder,
                billingMode: billingModeSchema.parse(
                  isSubscription ? 'recurring' : 'one_time',
                ),
                metadata: { ...(polarOrder.metadata ?? {}) },
              }),
            }),
          ];
        }

        case 'order.created': {
          const polarOrder = data as PolarOrder;
          return [
            paykitEvent$InboundSchema<Payment>({
              type: 'payment.created',
              created: parseInt(webhookTimestamp),
              id: webhookId,
              data: {
                id: polarOrder.id,
                amount: polarOrder.totalAmount,
                currency: polarOrder.currency,
                customer: polarOrder.customerId
                  ? { id: polarOrder.customerId }
                  : polarOrder.customer?.email
                    ? { email: polarOrder.customer.email }
                    : null,
                status:
                  polarOrder.status === 'paid'
                    ? 'succeeded'
                    : 'pending',
                metadata: stringifyMetadataValues(
                  polarOrder.metadata ?? {},
                ),
                item_id:
                  polarOrder.product?.id ?? polarOrder.productId,
                requires_action: polarOrder.status !== 'paid',
                payment_url: null,
              },
            }),
          ];
        }

        case 'customer.created':
        case 'customer.updated':
          return [
            paykitEvent$InboundSchema<Customer>({
              type:
                type === 'customer.created'
                  ? 'customer.created'
                  : 'customer.updated',
              created: parseInt(webhookTimestamp),
              id: webhookId,
              data: Customer$inboundSchema(data as PolarCustomer),
            }),
          ];

        case 'customer.deleted':
          return [
            paykitEvent$InboundSchema<null>({
              type: 'customer.deleted',
              created: parseInt(webhookTimestamp),
              id: webhookId,
              data: null,
            }),
          ];

        case 'subscription.created':
        case 'subscription.updated':
          return [
            paykitEvent$InboundSchema<Subscription>({
              type:
                type === 'subscription.created'
                  ? 'subscription.created'
                  : 'subscription.updated',
              created: parseInt(webhookTimestamp),
              id: webhookId,
              data: Subscription$inboundSchema(
                data as PolarSubscription,
              ),
            }),
          ];

        case 'subscription.revoked':
          return [
            paykitEvent$InboundSchema<Subscription>({
              type: 'subscription.canceled',
              created: parseInt(webhookTimestamp),
              id: webhookId,
              data: Subscription$inboundSchema(
                data as PolarSubscription,
              ),
            }),
          ];

        case 'refund.created':
          return [
            paykitEvent$InboundSchema<Refund>({
              type: 'refund.created',
              created: parseInt(webhookTimestamp),
              id: webhookId,
              data: Refund$inboundSchema(data as PolarRefund),
            }),
          ];

        default:
          return null;
      }
    };

    const standardMapped = processStandard();
    if (standardMapped) results.push(...standardMapped);

    return results;
  };
}
