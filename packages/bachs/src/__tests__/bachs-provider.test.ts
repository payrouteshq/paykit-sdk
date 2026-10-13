import {
  ConfigurationError,
  OperationFailedError,
  ProviderNotSupportedError,
  ResourceNotFoundError,
  ValidationError,
  WebhookError,
} from '@paykit-sdk/core';
import { createHmac } from 'crypto';
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { BachsProvider } from '../bachs-provider';

const SANDBOX_BASE_URL = 'https://sandbox-api.bachs.io';
const SECRET = 'whsec_test_secret';

const makeProvider = (overrides: Record<string, unknown> = {}) =>
  new BachsProvider({
    apiKey: 'sk_sandbox_test',
    isSandbox: true,
    debug: false,
    ...overrides,
  } as never);

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

describe('BachsProvider constructor', () => {
  it('throws ConfigurationError when apiKey is missing', () => {
    expect(
      () => new BachsProvider({ isSandbox: true } as never),
    ).toThrow(ConfigurationError);
  });

  it('exposes provider name and sandbox flag', () => {
    const provider = makeProvider();
    expect(provider.providerName).toBe('bachs');
    expect(provider.isSandbox).toBe(true);
  });

  it('infers isSandbox from the apiKey prefix over the explicit option', () => {
    expect(
      makeProvider({ apiKey: 'sk_live_test', isSandbox: true })
        .isSandbox,
    ).toBe(false);
    expect(
      makeProvider({ apiKey: 'sk_sandbox_test', isSandbox: false })
        .isSandbox,
    ).toBe(true);
  });

  it('falls back to the explicit isSandbox for an unrecognized key prefix', () => {
    expect(
      makeProvider({ apiKey: 'unknown_prefix_key', isSandbox: false })
        .isSandbox,
    ).toBe(false);
  });
});

describe('BachsProvider.createCheckout / createPayment', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const createResponse = () =>
    jsonResponse({
      checkout_id: 'chk_1a2b3c4d5e',
      checkout_url: 'https://checkout.bachs.io/c/tok_9f8e7d6c5b',
      status: 'OPEN',
      expires_at: '2026-04-27T13:00:00Z',
      created_at: '2026-04-27T12:00:00Z',
    });

  const sessionResponse = (extra: Record<string, unknown> = {}) =>
    jsonResponse({
      checkout_id: 'chk_1a2b3c4d5e',
      status: 'OPEN',
      recurring: null,
      payment_status: 'requires_payment_method',
      amount: '50.00',
      currency: 'USD',
      reference: 'order_9876',
      charge: null,
      customer: {
        id: null,
        email: 'jane@example.com',
        name: 'Jane Doe',
      },
      products: [
        {
          product_id: 'prod_abc123',
          product_name: 'Premium Plan',
          quantity: 1,
          unit_amount: '50.00',
          currency: 'USD',
          price_type: 'fixed',
          line_total: '50.00',
        },
      ],
      metadata: {},
      created_at: '2026-04-27T12:00:00Z',
      updated_at: '2026-04-27T12:00:00Z',
      ...extra,
    });

  it('createCheckout creates a session then resolves the full checkout', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse())
      .mockResolvedValueOnce(sessionResponse());

    const checkout = await makeProvider().createCheckout({
      customer: { email: 'jane@example.com' },
      item_id: 'prod_abc123',
      quantity: 1,
      session_type: 'one_time',
      success_url: 'https://shop.example.com/thanks',
      cancel_url: 'https://shop.example.com/cart',
      metadata: null,
      provider_metadata: {},
    } as never);

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [createUrl, createOptions] = fetchMock.mock.calls[0];
    expect(createUrl).toBe(
      `${SANDBOX_BASE_URL}/v1/checkout-sessions`,
    );
    expect(createOptions.headers.Authorization).toBe(
      'Bearer sk_sandbox_test',
    );
    expect(createOptions.headers['Idempotency-Key']).toBeTruthy();

    const createBody = JSON.parse(createOptions.body as string);
    expect(createBody.customer).toEqual({
      email: 'jane@example.com',
      name: 'jane',
    });
    expect(createBody.product_cart).toEqual([
      { product_id: 'prod_abc123', quantity: 1 },
    ]);
    expect(createBody.success_url).toBe(
      'https://shop.example.com/thanks',
    );
    expect(createBody.cancel_url).toBe(
      'https://shop.example.com/cart',
    );

    const [getUrl] = fetchMock.mock.calls[1];
    expect(getUrl).toBe(
      `${SANDBOX_BASE_URL}/v1/checkout-sessions/chk_1a2b3c4d5e`,
    );

    expect(checkout.id).toBe('chk_1a2b3c4d5e');
    expect(checkout.payment_url).toBe(
      'https://checkout.bachs.io/c/tok_9f8e7d6c5b',
    );
    expect(checkout.amount).toBe(50);
    expect(checkout.currency).toBe('USD');
    expect(checkout.products).toEqual([
      { id: 'prod_abc123', quantity: 1 },
    ]);
    expect(checkout.session_type).toBe('one_time');
  });

  it('createCheckout passes an existing customer_id instead of email/name', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse())
      .mockResolvedValueOnce(sessionResponse());

    await makeProvider().createCheckout({
      customer: { id: 'cust_1a2b3c4d5e6f' },
      item_id: 'prod_abc123',
      quantity: 1,
      session_type: 'one_time',
      success_url: 'https://shop.example.com/thanks',
      cancel_url: 'https://shop.example.com/cart',
      metadata: null,
      provider_metadata: {},
    } as never);

    const createBody = JSON.parse(
      fetchMock.mock.calls[0][1].body as string,
    );
    expect(createBody.customer).toEqual({
      customer_id: 'cust_1a2b3c4d5e6f',
    });
  });

  it('createCheckout throws ValidationError for malformed params', async () => {
    await expect(
      makeProvider().createCheckout({} as never),
    ).rejects.toThrow(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('createCheckout reuses a caller-supplied idempotencyKey across retries', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse())
      .mockResolvedValueOnce(sessionResponse());

    await makeProvider().createCheckout({
      customer: { email: 'jane@example.com' },
      item_id: 'prod_abc123',
      quantity: 1,
      session_type: 'one_time',
      success_url: 'https://shop.example.com/thanks',
      cancel_url: 'https://shop.example.com/cart',
      metadata: null,
      provider_metadata: { idempotencyKey: 'order_9876' },
    } as never);

    const [, createOptions] = fetchMock.mock.calls[0];
    expect(createOptions.headers['Idempotency-Key']).toBe(
      'order_9876',
    );
  });

  it('createCheckout defaults to a fresh random idempotencyKey per call when none is supplied', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse())
      .mockResolvedValueOnce(sessionResponse())
      .mockResolvedValueOnce(createResponse())
      .mockResolvedValueOnce(sessionResponse());

    const provider = makeProvider();
    const params = {
      customer: { email: 'jane@example.com' },
      item_id: 'prod_abc123',
      quantity: 1,
      session_type: 'one_time',
      success_url: 'https://shop.example.com/thanks',
      cancel_url: 'https://shop.example.com/cart',
      metadata: null,
      provider_metadata: {},
    } as never;

    await provider.createCheckout(params);
    await provider.createCheckout(params);

    const firstKey =
      fetchMock.mock.calls[0][1].headers['Idempotency-Key'];
    const secondKey =
      fetchMock.mock.calls[2][1].headers['Idempotency-Key'];
    expect(firstKey).not.toBe(secondKey);
  });

  it('createPayment reuses the checkout-session flow and requires success_url', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse())
      .mockResolvedValueOnce(sessionResponse());

    const payment = await makeProvider().createPayment({
      customer: { email: 'jane@example.com' },
      amount: 50,
      currency: 'USD',
      item_id: 'prod_abc123',
      capture_method: 'automatic',
      provider_metadata: {
        success_url: 'https://shop.example.com/thanks',
      },
    } as never);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(payment.id).toBe('chk_1a2b3c4d5e');
    expect(payment.payment_url).toBe(
      'https://checkout.bachs.io/c/tok_9f8e7d6c5b',
    );
    expect(payment.status).toBe('pending');
    expect(payment.requires_action).toBe(true);
  });

  it('createPayment throws ConfigurationError without success_url in provider_metadata', async () => {
    await expect(
      makeProvider().createPayment({
        customer: { email: 'jane@example.com' },
        amount: 50,
        currency: 'USD',
        item_id: 'prod_abc123',
        capture_method: 'automatic',
      } as never),
    ).rejects.toThrow(/success_url/);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('createPayment sends raw pricing instead of product_cart without item_id', async () => {
    fetchMock
      .mockResolvedValueOnce(createResponse())
      .mockResolvedValueOnce(sessionResponse());

    await makeProvider().createPayment({
      customer: { email: 'jane@example.com' },
      amount: 50,
      currency: 'USD',
      item_id: null,
      capture_method: 'automatic',
      provider_metadata: {
        success_url: 'https://shop.example.com/thanks',
      },
    } as never);

    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.product_cart).toBeUndefined();
    expect(body.pricing).toEqual({
      amount: '50',
      currency: 'USD',
      price_type: 'fixed',
    });
  });

  it('createPayment throws ConfigurationError without item_id or amount', async () => {
    await expect(
      makeProvider().createPayment({
        customer: { email: 'jane@example.com' },
        amount: 0,
        currency: 'USD',
        item_id: null,
        capture_method: 'automatic',
        provider_metadata: {
          success_url: 'https://shop.example.com/thanks',
        },
      } as never),
    ).rejects.toThrow(ConfigurationError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws OperationFailedError when session creation fails', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse(
        { detail: 'Invalid product', error_code: 'VALIDATION_ERROR' },
        422,
      ),
    );

    await expect(
      makeProvider().createCheckout({
        customer: { email: 'jane@example.com' },
        item_id: 'prod_missing',
        quantity: 1,
        session_type: 'one_time',
        success_url: 'https://shop.example.com/thanks',
        cancel_url: 'https://shop.example.com/cart',
        metadata: null,
        provider_metadata: {},
      } as never),
    ).rejects.toThrow(OperationFailedError);
  });
});

describe('BachsProvider.retrieveCheckout / retrievePayment', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sessionWithCharge = () =>
    jsonResponse({
      checkout_id: 'chk_1a2b3c4d5e',
      status: 'COMPLETED',
      recurring: null,
      amount: '50.00',
      currency: 'USD',
      charge: {
        payment_id: 'chr_1a2b3c4d5e6f',
        status: 'succeeded',
        amount: '50.00',
        currency: 'USD',
        customer: { name: 'Jane Doe', email: 'jane@example.com' },
        line_items: [
          {
            product_id: 'prod_abc123',
            product_name: 'Premium Plan',
            quantity: 1,
            unit_amount: '50.00',
            currency: 'USD',
            line_total: '50.00',
          },
        ],
        created_at: '2026-04-27T12:00:00Z',
        updated_at: '2026-04-27T12:04:00Z',
      },
      customer: {
        id: null,
        email: 'jane@example.com',
        name: 'Jane Doe',
      },
      products: [],
      metadata: {},
      created_at: '2026-04-27T12:00:00Z',
      updated_at: '2026-04-27T12:04:00Z',
    });

  const openSessionNoCharge = () =>
    jsonResponse({
      checkout_id: 'chk_1a2b3c4d5e',
      status: 'OPEN',
      recurring: null,
      amount: '50.00',
      currency: 'USD',
      charge: null,
      customer: {
        id: null,
        email: 'jane@example.com',
        name: 'Jane Doe',
      },
      products: [
        {
          product_id: 'prod_abc123',
          product_name: 'Premium Plan',
          quantity: 1,
          unit_amount: '50.00',
          currency: 'USD',
          price_type: 'fixed',
          line_total: '50.00',
        },
      ],
      metadata: {},
      created_at: '2026-04-27T12:00:00Z',
      updated_at: '2026-04-27T12:00:00Z',
    });

  it('retrieveCheckout maps a session with no checkout_url (empty payment_url)', async () => {
    fetchMock.mockResolvedValueOnce(openSessionNoCharge());

    const checkout =
      await makeProvider().retrieveCheckout('chk_1a2b3c4d5e');

    expect(checkout?.payment_url).toBe('');
    expect(checkout?.products).toEqual([
      { id: 'prod_abc123', quantity: 1 },
    ]);
  });

  it('retrieveCheckout returns null on 404', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Not found', { status: 404 }),
    );

    const checkout = await makeProvider().retrieveCheckout('missing');
    expect(checkout).toBeNull();
  });

  it('retrievePayment maps the nested charge once payment succeeds', async () => {
    fetchMock.mockResolvedValueOnce(sessionWithCharge());

    const payment =
      await makeProvider().retrievePayment('chk_1a2b3c4d5e');

    expect(payment?.status).toBe('succeeded');
    expect(payment?.item_id).toBe('prod_abc123');
    expect(payment?.customer).toEqual({ email: 'jane@example.com' });
  });

  it('retrievePayment falls back to checkout-level status while charge is still null', async () => {
    fetchMock.mockResolvedValueOnce(openSessionNoCharge());

    const payment =
      await makeProvider().retrievePayment('chk_1a2b3c4d5e');

    expect(payment?.status).toBe('pending');
    expect(payment?.requires_action).toBe(true);
  });

  it('retrievePayment returns null when the session does not exist', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Not found', { status: 404 }),
    );

    const payment = await makeProvider().retrievePayment('missing');
    expect(payment).toBeNull();
  });
});

describe('BachsProvider customer operations', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const customerResponse = () =>
    jsonResponse({
      customer_id: 'cust_1a2b3c4d5e6f',
      email: 'jane@example.com',
      name: 'Jane Doe',
      phone_number: '+2348012345678',
      metadata: { plan: 'pro' },
      created_at: '2026-01-24T12:00:00.000Z',
      updated_at: '2026-01-24T12:00:00.000Z',
    });

  it('createCustomer maps the response', async () => {
    fetchMock.mockResolvedValueOnce(customerResponse());

    const customer = await makeProvider().createCustomer({
      email: 'jane@example.com',
      name: 'Jane Doe',
      billing: null,
    } as never);

    expect(customer.id).toBe('cust_1a2b3c4d5e6f');
    expect(customer.email).toBe('jane@example.com');
    expect(customer.name).toBe('Jane Doe');
    expect(customer.created_at).toBeInstanceOf(Date);
  });

  it('retrieveCustomer returns null on 404', async () => {
    fetchMock.mockResolvedValueOnce(
      new Response('Not found', { status: 404 }),
    );
    expect(
      await makeProvider().retrieveCustomer('missing'),
    ).toBeNull();
  });

  it('updateCustomer PATCHes and maps the response', async () => {
    fetchMock.mockResolvedValueOnce(customerResponse());

    const customer = await makeProvider().updateCustomer(
      'cust_1a2b3c4d5e6f',
      {
        name: 'Jane Doe',
      } as never,
    );

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${SANDBOX_BASE_URL}/v1/customers/cust_1a2b3c4d5e6f`,
    );
    expect(JSON.parse(options.body as string)).toMatchObject({
      name: 'Jane Doe',
    });
    expect(customer.id).toBe('cust_1a2b3c4d5e6f');
  });

  it('deleteCustomer throws ProviderNotSupportedError', async () => {
    await expect(makeProvider().deleteCustomer('id')).rejects.toThrow(
      ProviderNotSupportedError,
    );
  });
});

describe('BachsProvider subscription operations', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const subscriptionResponse = (
    extra: Record<string, unknown> = {},
  ) =>
    jsonResponse({
      id: 'sub_1a2b3c4d5e6f',
      customer: {
        customer_id: 'cust_1',
        email: 'jane@example.com',
        name: 'Jane',
      },
      status: 'active',
      collection_method: 'charge_automatically',
      currency: 'USD',
      amount: '10.00',
      billing_cycle: { interval: 'month', frequency: 1 },
      quantity: 1,
      current_period_start: '2026-04-01T00:00:00Z',
      current_period_end: '2026-05-01T00:00:00Z',
      cancel_at_period_end: false,
      created_at: '2026-03-01T12:00:00Z',
      product: { id: 'prod_abc123', name: 'Pro plan' },
      items: [],
      ...extra,
    });

  it('createSubscription throws ProviderNotSupportedError', async () => {
    await expect(
      makeProvider().createSubscription({} as never),
    ).rejects.toThrow(ProviderNotSupportedError);
  });

  it('retrieveSubscription maps the response', async () => {
    fetchMock.mockResolvedValueOnce(subscriptionResponse());

    const subscription = await makeProvider().retrieveSubscription(
      'sub_1a2b3c4d5e6f',
    );

    expect(subscription?.status).toBe('active');
    expect(subscription?.item_id).toBe('prod_abc123');
    expect(subscription?.billing_interval).toBe('month');
    expect(subscription?.amount).toBe(10);
  });

  it('updateSubscription PATCHes with provider_metadata fields', async () => {
    fetchMock.mockResolvedValueOnce(
      subscriptionResponse({ status: 'active' }),
    );

    await makeProvider().updateSubscription('sub_1a2b3c4d5e6f', {
      metadata: {},
      provider_metadata: { product_id: 'prod_xyz456' },
    } as never);

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe(
      `${SANDBOX_BASE_URL}/v1/subscriptions/sub_1a2b3c4d5e6f`,
    );
    expect(JSON.parse(options.body as string)).toEqual({
      product_id: 'prod_xyz456',
    });
  });

  it('cancelSubscription DELETEs immediately', async () => {
    fetchMock.mockResolvedValueOnce(
      subscriptionResponse({ status: 'canceled' }),
    );

    const subscription = await makeProvider().cancelSubscription(
      'sub_1a2b3c4d5e6f',
    );

    const [, options] = fetchMock.mock.calls[0];
    expect(JSON.parse(options.body as string)).toEqual({
      cancel_at_period_end: false,
    });
    expect(subscription.status).toBe('canceled');
  });

  it('deleteSubscription throws ProviderNotSupportedError', async () => {
    await expect(
      makeProvider().deleteSubscription('id'),
    ).rejects.toThrow(ProviderNotSupportedError);
  });
});

describe('BachsProvider.createRefund', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sessionWithCharge = () =>
    jsonResponse({
      checkout_id: 'chk_1a2b3c4d5e',
      status: 'COMPLETED',
      amount: '50.00',
      currency: 'USD',
      charge: {
        payment_id: 'chr_1a2b3c4d5e6f',
        status: 'succeeded',
        amount: '50.00',
        currency: 'USD',
        created_at: '2026-04-27T12:00:00Z',
        updated_at: '2026-04-27T12:04:00Z',
      },
      customer: {
        id: null,
        email: 'jane@example.com',
        name: 'Jane Doe',
      },
      metadata: {},
      created_at: '2026-04-27T12:00:00Z',
      updated_at: '2026-04-27T12:04:00Z',
    });

  it('resolves the charge_id from the checkout session and creates a refund', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionWithCharge())
      .mockResolvedValueOnce(
        jsonResponse({
          refund_id: 'ref_1a2b3c4d5e',
          charge_id: 'chr_1a2b3c4d5e6f',
          reference: 'ref_9876',
          status: 'processing',
          requested_amount: '29.00',
          refunded_amount: null,
          reason: 'Customer request',
          created_at: '2026-04-27T12:00:00Z',
          updated_at: '2026-04-27T12:00:00Z',
        }),
      );

    const refund = await makeProvider().createRefund({
      payment_id: 'chk_1a2b3c4d5e',
      amount: 29,
      reason: 'Customer request',
      metadata: null,
    } as never);

    const [refundUrl, refundOptions] = fetchMock.mock.calls[1];
    expect(refundUrl).toBe(`${SANDBOX_BASE_URL}/v1/refunds`);
    const body = JSON.parse(refundOptions.body as string);
    expect(body.charge_id).toBe('chr_1a2b3c4d5e6f');
    expect(body.amount).toBe('29');

    expect(refund.id).toBe('ref_1a2b3c4d5e');
    expect(refund.currency).toBe('USD');
    expect(refund.amount).toBe(29);
  });

  it('reuses a caller-supplied idempotencyKey as the reference, idempotency_key body field, and header', async () => {
    fetchMock
      .mockResolvedValueOnce(sessionWithCharge())
      .mockResolvedValueOnce(
        jsonResponse({
          refund_id: 'ref_1a2b3c4d5e',
          charge_id: 'chr_1a2b3c4d5e6f',
          reference: 'refund_order_9876',
          status: 'processing',
          requested_amount: '29.00',
          refunded_amount: null,
          reason: null,
          created_at: '2026-04-27T12:00:00Z',
          updated_at: '2026-04-27T12:00:00Z',
        }),
      );

    await makeProvider().createRefund({
      payment_id: 'chk_1a2b3c4d5e',
      amount: 29,
      reason: null,
      metadata: null,
      provider_metadata: { idempotencyKey: 'refund_order_9876' },
    } as never);

    const [, refundOptions] = fetchMock.mock.calls[1];
    const body = JSON.parse(refundOptions.body as string);

    expect(body.reference).toBe('refund_order_9876');
    expect(body.idempotency_key).toBe('refund_order_9876');
    expect(refundOptions.headers['Idempotency-Key']).toBe(
      'refund_order_9876',
    );
  });

  it('throws ResourceNotFoundError when the payment has no charge yet', async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        checkout_id: 'chk_1a2b3c4d5e',
        status: 'OPEN',
        amount: '50.00',
        currency: 'USD',
        charge: null,
        customer: {
          id: null,
          email: 'jane@example.com',
          name: 'Jane Doe',
        },
        metadata: {},
        created_at: '2026-04-27T12:00:00Z',
        updated_at: '2026-04-27T12:00:00Z',
      }),
    );

    await expect(
      makeProvider().createRefund({
        payment_id: 'chk_1a2b3c4d5e',
        amount: 29,
        reason: null,
        metadata: null,
      } as never),
    ).rejects.toThrow(ResourceNotFoundError);
  });
});

describe('BachsProvider.handleWebhook', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const sign = (
    timestamp: number,
    rawBody: string,
    secret = SECRET,
  ) =>
    createHmac('sha256', secret)
      .update(`${timestamp}.${rawBody}`)
      .digest('hex');

  const dto = (
    body: string,
    timestamp: number,
    signature?: string,
  ) => ({
    body,
    headersAsObject: {
      'x-bachs-timestamp': String(timestamp),
      ...(signature ? { 'x-bachs-signature': signature } : {}),
    } as Record<string, string>,
    fullUrl: 'https://app.example.com/api/webhook',
  });

  it('rejects when no webhook secret is configured', async () => {
    await expect(
      makeProvider().handleWebhook(dto('{}', 0), null),
    ).rejects.toThrow(WebhookError);
  });

  it('rejects when signature/timestamp headers are missing', async () => {
    await expect(
      makeProvider().handleWebhook(
        { body: '{}', headersAsObject: {}, fullUrl: 'x' },
        SECRET,
      ),
    ).rejects.toThrow(
      'Missing X-Bachs-Timestamp or X-Bachs-Signature header',
    );
  });

  it('rejects a stale timestamp', async () => {
    const timestamp = Math.floor(Date.now() / 1000) - 10_000;
    const body = JSON.stringify({ type: 'customer.created' });

    await expect(
      makeProvider().handleWebhook(
        dto(body, timestamp, sign(timestamp, body)),
        SECRET,
      ),
    ).rejects.toThrow('stale or invalid');
  });

  it('rejects an invalid signature', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({ type: 'customer.created' });

    await expect(
      makeProvider().handleWebhook(
        dto(body, timestamp, sign(timestamp, body, 'wrong-secret')),
        SECRET,
      ),
    ).rejects.toThrow('Invalid Bachs webhook signature');
  });

  it('maps collection.succeeded to payment.succeeded by re-fetching the session', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'collection.succeeded',
      created_at: '2026-04-27T12:04:00Z',
      organization_id: 'org_abc123',
      data: {
        charge_id: 'chr_1a2b3c4d5e6f',
        checkout_id: 'chk_1a2b3c4d5e',
        status: 'SUCCEEDED',
        amount: '29.00',
        currency: 'USD',
      },
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        checkout_id: 'chk_1a2b3c4d5e',
        status: 'COMPLETED',
        amount: '29.00',
        currency: 'USD',
        charge: {
          payment_id: 'chr_1a2b3c4d5e6f',
          status: 'succeeded',
          amount: '29.00',
          currency: 'USD',
          created_at: '2026-04-27T12:00:00Z',
          updated_at: '2026-04-27T12:04:00Z',
        },
        customer: {
          id: null,
          email: 'jane@example.com',
          name: 'Jane Doe',
        },
        metadata: {},
        created_at: '2026-04-27T12:00:00Z',
        updated_at: '2026-04-27T12:04:00Z',
      }),
    );

    const events = await makeProvider().handleWebhook(
      dto(body, timestamp, sign(timestamp, body)),
      SECRET,
    );

    expect(events.map(e => e.type)).toEqual([
      'bachs.collection.succeeded',
      'payment.succeeded',
    ]);
    expect(events[0].is_raw).toBe(true);
  });

  it('maps refund.created by fetching the charge for currency', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'refund.created',
      created_at: '2026-04-27T12:00:00Z',
      organization_id: 'org_abc123',
      data: {
        refund_id: 'ref_1a2b3c4d5e',
        charge_id: 'chr_1a2b3c4d5e6f',
        reference: 'refund_9876',
        status: 'processing',
        requested_amount: '10.00',
        refunded_amount: '0.00',
        reason: 'Customer request',
      },
    });

    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        payment_id: 'chr_1a2b3c4d5e6f',
        status: 'succeeded',
        amount: '10.00',
        currency: 'USD',
        created_at: '2026-04-27T12:00:00Z',
        updated_at: '2026-04-27T12:00:00Z',
      }),
    );

    const events = await makeProvider().handleWebhook(
      dto(body, timestamp, sign(timestamp, body)),
      SECRET,
    );

    expect(events.map(e => e.type)).toEqual([
      'bachs.refund.created',
      'refund.created',
    ]);
    expect(events[1].data).toMatchObject({
      id: 'ref_1a2b3c4d5e',
      currency: 'USD',
    });
  });

  it('maps customer.created directly without an extra fetch', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'customer.created',
      created_at: '2026-04-27T12:00:00Z',
      organization_id: 'org_abc123',
      data: {
        customer_id: 'cust_1a2b3c4d5e6f',
        email: 'jane@example.com',
        name: 'Jane Doe',
        phone_number: '+2348012345678',
        metadata: {},
        created_at: '2026-04-27T12:00:00Z',
        updated_at: '2026-04-27T12:00:00Z',
      },
    });

    const events = await makeProvider().handleWebhook(
      dto(body, timestamp, sign(timestamp, body)),
      SECRET,
    );

    expect(fetchMock).not.toHaveBeenCalled();
    expect(events.map(e => e.type)).toEqual([
      'bachs.customer.created',
      'customer.created',
    ]);
  });

  it('emits only the raw event for unmapped event types', async () => {
    const timestamp = Math.floor(Date.now() / 1000);
    const body = JSON.stringify({
      id: 'evt_1',
      type: 'payout.created',
      created_at: '2026-04-27T12:00:00Z',
      organization_id: 'org_abc123',
      data: { payout_id: 'po_1' },
    });

    const events = await makeProvider().handleWebhook(
      dto(body, timestamp, sign(timestamp, body)),
      SECRET,
    );

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('bachs.payout.created');
  });
});

describe('BachsProvider unsupported operations', () => {
  it('throws ProviderNotSupportedError for checkout mutation operations', async () => {
    const provider = makeProvider();

    await expect(
      provider.updateCheckout('id', {} as never),
    ).rejects.toThrow(ProviderNotSupportedError);
    await expect(provider.deleteCheckout('id')).rejects.toThrow(
      ProviderNotSupportedError,
    );
  });

  it('throws ProviderNotSupportedError for updatePayment / deletePayment / capturePayment / cancelPayment', async () => {
    const provider = makeProvider();

    await expect(
      provider.updatePayment('id', {} as never),
    ).rejects.toThrow(ProviderNotSupportedError);
    await expect(provider.deletePayment('id')).rejects.toThrow(
      ProviderNotSupportedError,
    );
    await expect(
      provider.capturePayment('id', { amount: 100 }),
    ).rejects.toThrow(ProviderNotSupportedError);
    await expect(provider.cancelPayment('id')).rejects.toThrow(
      ProviderNotSupportedError,
    );
  });
});
