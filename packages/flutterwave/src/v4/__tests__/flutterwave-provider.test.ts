import {
  ConfigurationError,
  OperationFailedError,
  PAYKIT_METADATA_KEY,
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
import { FlutterwaveProvider } from '../flutterwave-provider';

const BASE_URL = 'https://developersandbox-api.flutterwave.com';
const PROD_BASE_URL = 'https://f4bexperience.flutterwave.com';
const TOKEN_URL =
  'https://idp.flutterwave.com/realms/flutterwave/protocol/openid-connect/token';
const SECRET = 'whsec_test_secret_hash';

const makeProvider = (overrides: Record<string, unknown> = {}) =>
  new FlutterwaveProvider({
    clientId: 'client_id_test',
    clientSecret: 'client_secret_test',
    isSandbox: true,
    debug: false,
    ...overrides,
  } as never);

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const ok = (data: unknown, status = 200) =>
  jsonResponse({ status: 'success', message: 'ok', data }, status);

const charge = (extra: Record<string, unknown> = {}) => ({
  id: 'chg_RCDsCBDyaV',
  amount: 1234.56,
  currency: 'NGN',
  customer_id: 'cus_J0PvwvJB2n',
  reference: 'ref-123456',
  status: 'succeeded',
  meta: {},
  created_datetime: '2026-10-19T10:00:00.000Z',
  ...extra,
});

const order = (extra: Record<string, unknown> = {}) => ({
  ...charge({ id: 'ord_WRq7L4TM8p', status: 'authorized' }),
  ...extra,
});

const customer = (extra: Record<string, unknown> = {}) => ({
  id: 'cus_J0PvwvJB2n',
  email: 'james@example.com',
  name: { first: 'King', middle: 'Leo', last: 'James' },
  phone: { country_code: '234', number: '9067985861' },
  address: {
    city: 'Gotham',
    country: 'US',
    line1: '221B Baker Street',
    postal_code: '94105',
    state: 'Colorado',
  },
  meta: {},
  created_datetime: '2026-10-19T10:00:00.000Z',
  ...extra,
});

const refund = (extra: Record<string, unknown> = {}) => ({
  id: 'rfd_8XkQ2pLm4N',
  amount_refunded: 1234.56,
  charge_id: 'chg_RCDsCBDyaV',
  reason: 'requested_by_customer',
  status: 'succeeded',
  meta: {},
  created_datetime: '2026-10-19T11:00:00.000Z',
  ...extra,
});

type Handler = () => Response | Promise<Response>;

/**
 * Routes mocked fetch calls by `"METHOD url"`. The OAuth token endpoint
 * is answered automatically; any other unrouted call fails the test.
 */
const useFetch = (
  routes: Record<string, Handler | Handler[]> = {},
) => {
  const queues = new Map(
    Object.entries(routes).map(([key, value]) => [
      key,
      Array.isArray(value) ? [...value] : [value],
    ]),
  );

  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const key = `${init?.method ?? 'GET'} ${url}`;

    if (key === `POST ${TOKEN_URL}`) {
      return jsonResponse({
        access_token: 'tok_test',
        expires_in: 600,
        token_type: 'Bearer',
      });
    }

    const queue = queues.get(key);
    const handler =
      queue && (queue.length > 1 ? queue.shift() : queue[0]);

    if (!handler) throw new Error(`Unrouted request: ${key}`);

    return handler();
  });

  vi.stubGlobal('fetch', fetchMock);

  const apiCalls = () =>
    fetchMock.mock.calls.filter(([url]) => url !== TOKEN_URL);

  const lastCall = (method: string, path: string) => {
    const call = apiCalls()
      .filter(
        ([url, init]) =>
          url === `${BASE_URL}${path}` && init?.method === method,
      )
      .at(-1);

    if (!call) throw new Error(`No ${method} ${path} call recorded`);

    const [, init] = call;

    return {
      headers: init?.headers as Record<string, string>,
      body: init?.body ? JSON.parse(init.body as string) : undefined,
    };
  };

  return { fetchMock, apiCalls, lastCall };
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('FlutterwaveProvider constructor', () => {
  it('throws ConfigurationError when credentials are missing', () => {
    expect(
      () => new FlutterwaveProvider({ isSandbox: true } as never),
    ).toThrow(ConfigurationError);
    expect(() => makeProvider({ clientSecret: undefined })).toThrow(
      ConfigurationError,
    );
  });

  it('exposes provider name and sandbox flag', () => {
    const provider = makeProvider();

    expect(provider.providerName).toBe('flutterwave');
    expect(provider.isSandbox).toBe(true);
  });

  it('targets the production host when not in sandbox', async () => {
    const { fetchMock } = useFetch({
      [`GET ${PROD_BASE_URL}/customers/cus_1`]: () => ok(customer()),
    });

    await makeProvider({ isSandbox: false }).retrieveCustomer(
      'cus_1',
    );

    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe(
      `${PROD_BASE_URL}/customers/cus_1`,
    );
  });
});

describe('FlutterwaveProvider authentication', () => {
  it('exchanges client credentials for a bearer token', async () => {
    const { fetchMock, lastCall } = useFetch({
      [`GET ${BASE_URL}/customers/cus_1`]: () => ok(customer()),
    });

    await makeProvider().retrieveCustomer('cus_1');

    const [, tokenInit] = fetchMock.mock.calls[0];
    const form = new URLSearchParams(
      tokenInit?.body as URLSearchParams,
    );

    expect(form.get('grant_type')).toBe('client_credentials');
    expect(form.get('client_id')).toBe('client_id_test');
    expect(form.get('client_secret')).toBe('client_secret_test');
    expect(
      (tokenInit?.headers as Record<string, string>)['Content-Type'],
    ).toBe('application/x-www-form-urlencoded');

    expect(
      lastCall('GET', '/customers/cus_1').headers.Authorization,
    ).toBe('Bearer tok_test');
  });

  it('reuses the cached token across requests', async () => {
    const { fetchMock } = useFetch({
      [`GET ${BASE_URL}/customers/cus_1`]: () => ok(customer()),
    });
    const provider = makeProvider();

    await provider.retrieveCustomer('cus_1');
    await provider.retrieveCustomer('cus_1');

    const tokenCalls = fetchMock.mock.calls.filter(
      ([url]) => url === TOKEN_URL,
    );
    expect(tokenCalls).toHaveLength(1);
  });

  it('sends a trace id on every request and an idempotency key on writes', async () => {
    const { lastCall } = useFetch({
      [`GET ${BASE_URL}/customers/cus_1`]: () => ok(customer()),
      [`POST ${BASE_URL}/customers`]: () => ok(customer(), 201),
    });
    const provider = makeProvider();

    await provider.retrieveCustomer('cus_1');
    await provider.createCustomer({
      email: 'james@example.com',
      billing: null,
      provider_metadata: { idempotencyKey: 'idem-key-123456' },
    } as never);

    const read = lastCall('GET', '/customers/cus_1').headers;
    expect(read['X-Trace-Id']).toBeTruthy();
    expect(read['X-Idempotency-Key']).toBeUndefined();

    const write = lastCall('POST', '/customers').headers;
    expect(write['X-Idempotency-Key']).toBe('idem-key-123456');
  });

  it('forwards X-Scenario-Key in the sandbox only', async () => {
    const route = {
      [`POST ${BASE_URL}/customers`]: () => ok(customer(), 201),
      [`POST ${PROD_BASE_URL}/customers`]: () => ok(customer(), 201),
    };
    const input = {
      email: 'james@example.com',
      billing: null,
      provider_metadata: { scenarioKey: 'scenario:auth_pin' },
    } as never;

    const { fetchMock } = useFetch(route);

    await makeProvider().createCustomer(input);
    await makeProvider({ isSandbox: false }).createCustomer(input);

    const [sandbox, production] = fetchMock.mock.calls.filter(
      ([url]) => url !== TOKEN_URL,
    );

    expect(
      (sandbox[1]?.headers as Record<string, string>)[
        'X-Scenario-Key'
      ],
    ).toBe('scenario:auth_pin');
    expect(
      (production[1]?.headers as Record<string, string>)[
        'X-Scenario-Key'
      ],
    ).toBeUndefined();
  });

  it('fails the request when the token endpoint rejects the credentials', async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ error: 'unauthorized_client' }, 401),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      makeProvider().retrieveCustomer('cus_1'),
    ).rejects.toThrow(OperationFailedError);
  });
});

describe('FlutterwaveProvider.createPayment', () => {
  const baseParams = {
    customer: { email: 'james@example.com' },
    amount: 1234.56,
    currency: 'NGN',
    item_id: 'sku_123',
    metadata: { order_id: 'ORD-1' },
    capture_method: 'automatic',
  };

  const mobileMoney = {
    type: 'mobile_money',
    mobile_money: {
      network: 'MTN',
      country_code: '233',
      phone_number: '9012345678',
    },
  } as const;

  it('creates an orchestrator charge with an inline customer and payment method', async () => {
    const { lastCall } = useFetch({
      [`POST ${BASE_URL}/orchestration/direct-charges`]: () =>
        ok(
          charge({
            status: 'pending',
            next_action: {
              type: 'redirect_url',
              redirect_url: {
                url: 'https://pay.flutterwave.test/3ds',
              },
            },
          }),
          201,
        ),
    });

    const payment = await makeProvider().createPayment({
      ...baseParams,
      provider_metadata: {
        payment_method: mobileMoney,
        redirect_url: 'https://shop.example.com/return',
        reference: 'my-reference-001',
      },
    } as never);

    const { body } = lastCall(
      'POST',
      '/orchestration/direct-charges',
    );

    expect(body).toMatchObject({
      amount: 1234.56,
      currency: 'NGN',
      reference: 'my-reference-001',
      redirect_url: 'https://shop.example.com/return',
      customer: { email: 'james@example.com' },
      payment_method: mobileMoney,
    });
    expect(body.meta.order_id).toBe('ORD-1');
    expect(JSON.parse(body.meta[PAYKIT_METADATA_KEY])).toEqual({
      item_id: 'sku_123',
    });

    expect(payment).toMatchObject({
      id: 'chg_RCDsCBDyaV',
      amount: 1234.56,
      currency: 'NGN',
      status: 'requires_action',
      requires_action: true,
      payment_url: 'https://pay.flutterwave.test/3ds',
      item_id: null,
    });
  });

  it('generates a reference when none is given', async () => {
    const { lastCall } = useFetch({
      [`POST ${BASE_URL}/orchestration/direct-charges`]: () =>
        ok(charge(), 201),
    });

    await makeProvider().createPayment({
      ...baseParams,
      provider_metadata: { payment_method: mobileMoney },
    } as never);

    expect(
      lastCall('POST', '/orchestration/direct-charges').body
        .reference,
    ).toMatch(/^[a-zA-Z0-9-]{6,42}$/);
  });

  it('re-reads an existing customer to build the inline customer', async () => {
    const { lastCall } = useFetch({
      [`GET ${BASE_URL}/customers/cus_J0PvwvJB2n`]: () =>
        ok(customer()),
      [`POST ${BASE_URL}/orchestration/direct-charges`]: () =>
        ok(charge(), 201),
    });

    await makeProvider().createPayment({
      ...baseParams,
      customer: { id: 'cus_J0PvwvJB2n' },
      provider_metadata: { payment_method: mobileMoney },
    } as never);

    expect(
      lastCall('POST', '/orchestration/direct-charges').body.customer,
    ).toEqual({
      email: 'james@example.com',
      name: { first: 'King', middle: 'Leo', last: 'James' },
      phone: { country_code: '234', number: '9067985861' },
      address: customer().address,
    });
  });

  it('uses billing as the inline customer address', async () => {
    const { lastCall } = useFetch({
      [`POST ${BASE_URL}/orchestration/direct-charges`]: () =>
        ok(charge(), 201),
    });

    await makeProvider().createPayment({
      ...baseParams,
      billing: {
        currency: 'NGN',
        address: {
          name: 'James',
          line1: '1 Marina',
          city: 'Lagos',
          postal_code: '100001',
          country: 'NG',
        },
      },
      provider_metadata: { payment_method: mobileMoney },
    } as never);

    expect(
      lastCall('POST', '/orchestration/direct-charges').body.customer
        .address,
    ).toEqual({
      line1: '1 Marina',
      city: 'Lagos',
      state: '',
      postal_code: '100001',
      country: 'NG',
    });
  });

  it('throws ResourceNotFoundError when the existing customer is gone', async () => {
    useFetch({
      [`GET ${BASE_URL}/customers/cus_missing`]: () =>
        jsonResponse({ status: 'failed' }, 404),
    });

    await expect(
      makeProvider({}).createPayment({
        ...baseParams,
        customer: { id: 'cus_missing' },
        provider_metadata: { payment_method: mobileMoney },
      } as never),
    ).rejects.toThrow(ResourceNotFoundError);
  });

  it('charges a saved payment method by id', async () => {
    const { lastCall, apiCalls } = useFetch({
      [`POST ${BASE_URL}/charges`]: () => ok(charge(), 201),
    });

    const payment = await makeProvider().createPayment({
      ...baseParams,
      customer: { id: 'cus_J0PvwvJB2n' },
      provider_metadata: { payment_method_id: 'pmd_wlVhaYmkl2' },
    } as never);

    expect(apiCalls()).toHaveLength(1);
    expect(lastCall('POST', '/charges').body).toMatchObject({
      customer_id: 'cus_J0PvwvJB2n',
      payment_method_id: 'pmd_wlVhaYmkl2',
      recurring: false,
    });
    expect(payment.status).toBe('succeeded');
  });

  it('creates an order for manual capture', async () => {
    const { lastCall } = useFetch({
      [`POST ${BASE_URL}/orders`]: () => ok(order(), 201),
    });

    const payment = await makeProvider().createPayment({
      ...baseParams,
      capture_method: 'manual',
      customer: { id: 'cus_J0PvwvJB2n' },
      provider_metadata: { payment_method_id: 'pmd_wlVhaYmkl2' },
    } as never);

    const { body } = lastCall('POST', '/orders');
    expect(body.customer_id).toBe('cus_J0PvwvJB2n');
    expect(body).not.toHaveProperty('recurring');
    expect(payment).toMatchObject({
      id: 'ord_WRq7L4TM8p',
      status: 'requires_capture',
    });
  });

  it('uses the orchestrator order endpoint for inline manual capture', async () => {
    const { lastCall } = useFetch({
      [`POST ${BASE_URL}/orchestration/direct-orders`]: () =>
        ok(order(), 201),
    });

    await makeProvider().createPayment({
      ...baseParams,
      capture_method: 'manual',
      provider_metadata: { payment_method: mobileMoney },
    } as never);

    expect(
      lastCall('POST', '/orchestration/direct-orders').body
        .payment_method,
    ).toEqual(mobileMoney);
  });

  it('requires exactly one of payment_method or payment_method_id', async () => {
    useFetch();
    const provider = makeProvider();

    await expect(
      provider.createPayment({ ...baseParams } as never),
    ).rejects.toThrow(ConfigurationError);

    await expect(
      provider.createPayment({
        ...baseParams,
        provider_metadata: {
          payment_method: mobileMoney,
          payment_method_id: 'pmd_wlVhaYmkl2',
        },
      } as never),
    ).rejects.toThrow(ConfigurationError);
  });

  it('requires an id customer for a saved payment method', async () => {
    useFetch();

    await expect(
      makeProvider().createPayment({
        ...baseParams,
        provider_metadata: { payment_method_id: 'pmd_wlVhaYmkl2' },
      } as never),
    ).rejects.toThrow(ConfigurationError);
  });

  it('requires a customer', async () => {
    useFetch();

    await expect(
      makeProvider().createPayment({
        ...baseParams,
        customer: null,
        provider_metadata: { payment_method: mobileMoney },
      } as never),
    ).rejects.toThrow(ConfigurationError);
  });

  it('surfaces an API failure as OperationFailedError', async () => {
    useFetch({
      [`POST ${BASE_URL}/orchestration/direct-charges`]: () =>
        jsonResponse(
          { status: 'failed', error: { type: 'REQUEST_NOT_VALID' } },
          400,
        ),
    });

    await expect(
      makeProvider().createPayment({
        ...baseParams,
        provider_metadata: { payment_method: mobileMoney },
      } as never),
    ).rejects.toThrow(OperationFailedError);
  });
});

describe('FlutterwaveProvider.retrievePayment', () => {
  it('reads a charge and maps its status and metadata', async () => {
    useFetch({
      [`GET ${BASE_URL}/charges/chg_RCDsCBDyaV`]: () =>
        ok(
          charge({
            billing_details: { email: 'james@example.com' },
            meta: {
              order_id: 'ORD-1',
              [PAYKIT_METADATA_KEY]: JSON.stringify({
                item_id: 'sku_123',
              }),
            },
          }),
        ),
    });

    const payment =
      await makeProvider().retrievePayment('chg_RCDsCBDyaV');

    expect(payment).toMatchObject({
      id: 'chg_RCDsCBDyaV',
      status: 'succeeded',
      customer: { email: 'james@example.com' },
      item_id: 'sku_123',
      metadata: { order_id: 'ORD-1' },
      payment_url: null,
    });
  });

  it('routes ord_ ids to the orders endpoint', async () => {
    useFetch({
      [`GET ${BASE_URL}/orders/ord_WRq7L4TM8p`]: () => ok(order()),
    });

    const payment =
      await makeProvider().retrievePayment('ord_WRq7L4TM8p');

    expect(payment?.status).toBe('requires_capture');
  });

  it.each([
    ['pending', undefined, 'pending'],
    ['pending', { type: 'requires_pin' }, 'requires_action'],
    ['pending', { type: 'requires_otp' }, 'requires_action'],
    [
      'pending',
      {
        type: 'payment_instruction',
        payment_instruction: { note: 'x' },
      },
      'requires_action',
    ],
    ['pending', { type: 'requires_requery' }, 'processing'],
    ['pending', { type: 'requires_capture' }, 'requires_capture'],
    ['failed', undefined, 'failed'],
    ['voided', undefined, 'canceled'],
  ])(
    'maps a %s charge with next_action %j to %s',
    async (status, nextAction, expected) => {
      useFetch({
        [`GET ${BASE_URL}/charges/chg_1`]: () =>
          ok(
            charge({ id: 'chg_1', status, next_action: nextAction }),
          ),
      });

      const payment = await makeProvider().retrievePayment('chg_1');

      expect(payment?.status).toBe(expected);
      expect(payment?.requires_action).toBe(
        expected === 'requires_action',
      );
    },
  );

  it.each([
    ['completed', 'succeeded'],
    ['partially-completed', 'succeeded'],
    ['authorized', 'requires_capture'],
    ['voided', 'canceled'],
    ['failed', 'failed'],
    ['pending', 'pending'],
  ])('maps a %s order to %s', async (status, expected) => {
    useFetch({
      [`GET ${BASE_URL}/orders/ord_1`]: () =>
        ok(order({ id: 'ord_1', status })),
    });

    expect(
      (await makeProvider().retrievePayment('ord_1'))?.status,
    ).toBe(expected);
  });

  it('returns null when the payment does not exist', async () => {
    useFetch({
      [`GET ${BASE_URL}/charges/chg_missing`]: () =>
        jsonResponse({ status: 'failed' }, 404),
    });

    expect(
      await makeProvider().retrievePayment('chg_missing'),
    ).toBeNull();
  });
});

describe('FlutterwaveProvider.updatePayment', () => {
  it('sends authorization and metadata to a charge', async () => {
    const { lastCall } = useFetch({
      [`PUT ${BASE_URL}/charges/chg_1`]: () =>
        ok(charge({ id: 'chg_1', status: 'pending' })),
    });
    const authorization = { type: 'otp', otp: { code: '123456' } };

    await makeProvider().updatePayment('chg_1', {
      metadata: { note: 'retry' },
      provider_metadata: { authorization },
    } as never);

    expect(lastCall('PUT', '/charges/chg_1').body).toEqual({
      meta: { note: 'retry' },
      authorization,
    });
  });

  it('only sends metadata to an order', async () => {
    const { lastCall } = useFetch({
      [`PUT ${BASE_URL}/orders/ord_1`]: () =>
        ok(order({ id: 'ord_1' })),
    });

    await makeProvider().updatePayment('ord_1', {
      metadata: { note: 'x' },
    } as never);

    expect(lastCall('PUT', '/orders/ord_1').body).toEqual({
      meta: { note: 'x' },
    });
  });

  it('rejects an update with nothing to send', async () => {
    useFetch();
    const provider = makeProvider();

    await expect(
      provider.updatePayment('chg_1', {} as never),
    ).rejects.toThrow(ValidationError);
    await expect(
      provider.updatePayment('ord_1', {} as never),
    ).rejects.toThrow(ValidationError);
  });
});

describe('FlutterwaveProvider.capturePayment / cancelPayment', () => {
  it('captures an authorized order for its full amount', async () => {
    const { lastCall } = useFetch({
      [`GET ${BASE_URL}/orders/ord_WRq7L4TM8p`]: () => ok(order()),
      [`PUT ${BASE_URL}/orders/ord_WRq7L4TM8p`]: () =>
        ok(order({ status: 'completed' })),
    });

    const payment = await makeProvider().capturePayment(
      'ord_WRq7L4TM8p',
      {
        amount: 1234.56,
      },
    );

    expect(lastCall('PUT', '/orders/ord_WRq7L4TM8p').body).toEqual({
      action: 'capture',
    });
    expect(payment.status).toBe('succeeded');
  });

  it('rejects a partial capture instead of capturing the full amount', async () => {
    const { apiCalls } = useFetch({
      [`GET ${BASE_URL}/orders/ord_WRq7L4TM8p`]: () => ok(order()),
    });

    await expect(
      makeProvider().capturePayment('ord_WRq7L4TM8p', { amount: 10 }),
    ).rejects.toThrow(ValidationError);

    expect(
      apiCalls().some(([, init]) => init?.method === 'PUT'),
    ).toBe(false);
  });

  it('throws ResourceNotFoundError when the order is missing', async () => {
    useFetch({
      [`GET ${BASE_URL}/orders/ord_missing`]: () =>
        jsonResponse({ status: 'failed' }, 404),
    });

    await expect(
      makeProvider().capturePayment('ord_missing', { amount: 1 }),
    ).rejects.toThrow(ResourceNotFoundError);
  });

  it('refuses to capture a charge', async () => {
    useFetch();

    await expect(
      makeProvider().capturePayment('chg_1', { amount: 1 }),
    ).rejects.toThrow(ProviderNotSupportedError);
  });

  it('voids an order', async () => {
    const { lastCall } = useFetch({
      [`PUT ${BASE_URL}/orders/ord_WRq7L4TM8p`]: () =>
        ok(order({ status: 'voided' })),
    });

    const payment =
      await makeProvider().cancelPayment('ord_WRq7L4TM8p');

    expect(lastCall('PUT', '/orders/ord_WRq7L4TM8p').body).toEqual({
      action: 'void',
    });
    expect(payment.status).toBe('canceled');
  });

  it('refuses to cancel a charge', async () => {
    useFetch();

    await expect(
      makeProvider().cancelPayment('chg_1'),
    ).rejects.toThrow(ProviderNotSupportedError);
  });
});

describe('FlutterwaveProvider.createRefund', () => {
  const refundRoutes = (refundData = refund()) => ({
    [`GET ${BASE_URL}/charges/chg_RCDsCBDyaV`]: () => ok(charge()),
    [`POST ${BASE_URL}/refunds`]: () => ok(refundData, 201),
  });

  it('refunds a charge using its currency', async () => {
    const { lastCall } = useFetch(refundRoutes());

    const result = await makeProvider().createRefund({
      payment_id: 'chg_RCDsCBDyaV',
      amount: 500,
      reason: 'duplicate',
      metadata: { ticket: 'T-1' },
      provider_metadata: { idempotencyKey: 'refund-idem-0001' },
    } as never);

    const { body, headers } = lastCall('POST', '/refunds');
    expect(body).toEqual({
      charge_id: 'chg_RCDsCBDyaV',
      amount: 500,
      reason: 'duplicate',
      meta: { ticket: 'T-1' },
    });
    expect(headers['X-Idempotency-Key']).toBe('refund-idem-0001');

    expect(result).toEqual({
      id: 'rfd_8XkQ2pLm4N',
      amount: 1234.56,
      currency: 'NGN',
      reason: 'requested_by_customer',
      metadata: {},
      status: 'succeeded',
    });
  });

  it('refunds the full payment when amount is 0', async () => {
    const { lastCall } = useFetch(refundRoutes());

    await makeProvider().createRefund({
      payment_id: 'chg_RCDsCBDyaV',
      amount: 0,
      reason: null,
      metadata: null,
    } as never);

    expect(lastCall('POST', '/refunds').body.amount).toBe(1234.56);
  });

  it('keeps a free-text reason in meta and round-trips it', async () => {
    const { lastCall } = useFetch(
      refundRoutes(
        refund({
          meta: {
            reason_note: 'Customer changed their mind',
            ticket: 'T-1',
          },
        }),
      ),
    );

    const result = await makeProvider().createRefund({
      payment_id: 'chg_RCDsCBDyaV',
      amount: 10,
      reason: 'Customer changed their mind',
      metadata: { ticket: 'T-1' },
    } as never);

    const { body } = lastCall('POST', '/refunds');
    expect(body.reason).toBe('requested_by_customer');
    expect(body.meta).toEqual({
      ticket: 'T-1',
      reason_note: 'Customer changed their mind',
    });

    expect(result.reason).toBe('Customer changed their mind');
    expect(result.metadata).toEqual({ ticket: 'T-1' });
  });

  it.each([
    ['new', 'pending'],
    ['pending', 'pending'],
    ['requires_action', 'pending'],
    ['succeeded', 'succeeded'],
    ['completed', 'succeeded'],
    ['failed', 'failed'],
    ['cancelled', 'failed'],
  ])('maps refund status %s to %s', async (status, expected) => {
    useFetch(refundRoutes(refund({ status })));

    const result = await makeProvider().createRefund({
      payment_id: 'chg_RCDsCBDyaV',
      amount: 10,
      reason: null,
      metadata: null,
    } as never);

    expect(result.status).toBe(expected);
  });

  it('throws ResourceNotFoundError for an unknown payment', async () => {
    useFetch({
      [`GET ${BASE_URL}/charges/chg_missing`]: () =>
        jsonResponse({ status: 'failed' }, 404),
    });

    await expect(
      makeProvider().createRefund({
        payment_id: 'chg_missing',
        amount: 10,
        reason: null,
        metadata: null,
      } as never),
    ).rejects.toThrow(ResourceNotFoundError);
  });
});

describe('FlutterwaveProvider customer operations', () => {
  it('creates a customer, splitting name and phone', async () => {
    const { lastCall } = useFetch({
      [`POST ${BASE_URL}/customers`]: () => ok(customer(), 201),
    });

    const result = await makeProvider().createCustomer({
      email: 'james@example.com',
      name: 'King Leo James',
      phone: '+2349067985861',
      metadata: { plan: 'pro' },
      billing: {
        currency: 'NGN',
        address: {
          name: 'King James',
          line1: '221B Baker Street',
          city: 'Gotham',
          state: 'Colorado',
          postal_code: '94105',
          country: 'US',
        },
      },
    } as never);

    expect(lastCall('POST', '/customers').body).toEqual({
      email: 'james@example.com',
      name: { first: 'King', middle: 'Leo', last: 'James' },
      phone: { country_code: '234', number: '9067985861' },
      address: {
        line1: '221B Baker Street',
        city: 'Gotham',
        state: 'Colorado',
        postal_code: '94105',
        country: 'US',
      },
      meta: { plan: 'pro' },
    });

    expect(result).toMatchObject({
      id: 'cus_J0PvwvJB2n',
      email: 'james@example.com',
      name: 'King Leo James',
      phone: '+2349067985861',
      custom_fields: { address: customer().address },
    });
    expect(result.created_at).toEqual(
      new Date('2026-10-19T10:00:00.000Z'),
    );
  });

  it('rejects a phone number that is not E.164', async () => {
    useFetch();

    await expect(
      makeProvider().createCustomer({
        email: 'james@example.com',
        phone: '09067985861',
        billing: null,
      } as never),
    ).rejects.toThrow(ValidationError);
  });

  it('retrieves a customer, or null when missing', async () => {
    useFetch({
      [`GET ${BASE_URL}/customers/cus_J0PvwvJB2n`]: () =>
        ok(customer()),
      [`GET ${BASE_URL}/customers/cus_missing`]: () =>
        jsonResponse({ status: 'failed' }, 404),
    });
    const provider = makeProvider();

    expect(
      (await provider.retrieveCustomer('cus_J0PvwvJB2n'))?.email,
    ).toBe('james@example.com');
    expect(await provider.retrieveCustomer('cus_missing')).toBeNull();
  });

  it('updates name, phone and metadata', async () => {
    const { lastCall } = useFetch({
      [`PUT ${BASE_URL}/customers/cus_J0PvwvJB2n`]: () =>
        ok(customer()),
    });

    await makeProvider().updateCustomer('cus_J0PvwvJB2n', {
      name: 'Jane Doe',
      phone: '+233201234567',
      metadata: { plan: 'free' },
    });

    expect(lastCall('PUT', '/customers/cus_J0PvwvJB2n').body).toEqual(
      {
        name: { first: 'Jane', last: 'Doe' },
        phone: { country_code: '233', number: '201234567' },
        meta: { plan: 'free' },
      },
    );
  });

  it('rejects an email change', async () => {
    useFetch();

    await expect(
      makeProvider().updateCustomer('cus_1', {
        email: 'new@example.com',
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('FlutterwaveProvider.handleWebhook', () => {
  const sign = (body: string, secret = SECRET) =>
    createHmac('sha256', secret).update(body).digest('base64');

  const dto = (body: string, signature?: string) => ({
    body,
    headersAsObject: {
      ...(signature && { 'flutterwave-signature': signature }),
    } as Record<string, string>,
    fullUrl: 'https://app.example.com/api/webhook',
  });

  const signed = (event: Record<string, unknown>) => {
    const body = JSON.stringify(event);
    return dto(body, sign(body));
  };

  const webhook = (type: string, data: Record<string, unknown>) => ({
    id: 'wbk_W5p6ktwU0jQ8RO4By860',
    timestamp: 1735116884019,
    type,
    data,
  });

  it('rejects when no webhook secret is configured', async () => {
    await expect(
      makeProvider().handleWebhook(dto('{}'), null),
    ).rejects.toThrow(WebhookError);
  });

  it('rejects a missing signature header', async () => {
    await expect(
      makeProvider().handleWebhook(dto('{}'), SECRET),
    ).rejects.toThrow('Missing flutterwave-signature header');
  });

  it('rejects an invalid signature', async () => {
    const body = JSON.stringify(webhook('charge.completed', {}));

    await expect(
      makeProvider().handleWebhook(
        dto(body, sign(body, 'wrong-secret')),
        SECRET,
      ),
    ).rejects.toThrow('Invalid Flutterwave webhook signature');
  });

  it('rejects a signature of the wrong length without throwing a comparison error', async () => {
    await expect(
      makeProvider().handleWebhook(dto('{}', 'short'), SECRET),
    ).rejects.toThrow('Invalid Flutterwave webhook signature');
  });

  it('rejects a signed body that is not JSON', async () => {
    const body = 'not json';

    await expect(
      makeProvider().handleWebhook(dto(body, sign(body)), SECRET),
    ).rejects.toThrow('not valid JSON');
  });

  it('emits a raw event and payment.succeeded after re-reading the charge', async () => {
    const { lastCall } = useFetch({
      [`GET ${BASE_URL}/charges/chg_RCDsCBDyaV`]: () => ok(charge()),
    });

    const events = await makeProvider().handleWebhook(
      signed(
        webhook('charge.completed', {
          id: 'chg_RCDsCBDyaV',
          status: 'succeeded',
        }),
      ),
      SECRET,
    );

    expect(lastCall('GET', '/charges/chg_RCDsCBDyaV')).toBeTruthy();
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      type: 'flutterwave.charge.completed',
      is_raw: true,
    });
    expect(events[1]).toMatchObject({
      type: 'payment.succeeded',
      data: { id: 'chg_RCDsCBDyaV', status: 'succeeded' },
    });
    expect(events[0].id).toMatch(/^flutterwave:charge\.completed:/);
    expect(events[1].id).toMatch(/^paykit:charge\.completed:/);
  });

  it('trusts the re-read status over the webhook payload', async () => {
    useFetch({
      [`GET ${BASE_URL}/charges/chg_1`]: () =>
        ok(charge({ id: 'chg_1', status: 'failed' })),
    });

    const events = await makeProvider().handleWebhook(
      signed(
        webhook('charge.completed', {
          id: 'chg_1',
          status: 'succeeded',
        }),
      ),
      SECRET,
    );

    expect(events[1].type).toBe('payment.failed');
  });

  it('emits payment.updated for an order authorization', async () => {
    useFetch({
      [`GET ${BASE_URL}/orders/ord_WRq7L4TM8p`]: () => ok(order()),
    });

    const events = await makeProvider().handleWebhook(
      signed(
        webhook('order.authorization', { id: 'ord_WRq7L4TM8p' }),
      ),
      SECRET,
    );

    expect(events[1]).toMatchObject({
      type: 'payment.updated',
      data: { id: 'ord_WRq7L4TM8p', status: 'requires_capture' },
    });
  });

  it('throws so Flutterwave retries when the payment cannot be verified', async () => {
    useFetch({
      [`GET ${BASE_URL}/charges/chg_1`]: () =>
        jsonResponse({ status: 'failed' }, 404),
    });

    await expect(
      makeProvider().handleWebhook(
        signed(webhook('charge.completed', { id: 'chg_1' })),
        SECRET,
      ),
    ).rejects.toThrow(WebhookError);
  });

  it('emits refund.created with the charge currency', async () => {
    useFetch({
      [`GET ${BASE_URL}/charges/chg_RCDsCBDyaV`]: () => ok(charge()),
    });

    const events = await makeProvider().handleWebhook(
      signed(webhook('refund.completed', refund())),
      SECRET,
    );

    expect(events[1]).toMatchObject({
      type: 'refund.created',
      data: {
        id: 'rfd_8XkQ2pLm4N',
        amount: 1234.56,
        currency: 'NGN',
        status: 'succeeded',
      },
    });
  });

  it('delivers unmapped events as raw only', async () => {
    const { apiCalls } = useFetch();

    const events = await makeProvider().handleWebhook(
      signed(webhook('transfer.disburse', { id: 'trf_1' })),
      SECRET,
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: 'flutterwave.transfer.disburse',
      is_raw: true,
    });
    expect(apiCalls()).toHaveLength(0);
  });

  it('derives stable ids from the payload', async () => {
    useFetch();
    const request = signed(
      webhook('transfer.disburse', { id: 'trf_1' }),
    );
    const provider = makeProvider();

    const [first] = await provider.handleWebhook(request, SECRET);
    const [second] = await provider.handleWebhook(request, SECRET);

    expect(first.id).toBe(second.id);
  });
});

describe('FlutterwaveProvider unsupported operations', () => {
  const provider = makeProvider();

  it.each([
    ['createCheckout', () => provider.createCheckout({} as never)],
    ['retrieveCheckout', () => provider.retrieveCheckout('x')],
    [
      'updateCheckout',
      () => provider.updateCheckout('x', {} as never),
    ],
    ['deleteCheckout', () => provider.deleteCheckout('x')],
    ['deleteCustomer', () => provider.deleteCustomer('x')],
    [
      'createSubscription',
      () => provider.createSubscription({} as never),
    ],
    [
      'retrieveSubscription',
      () => provider.retrieveSubscription('x'),
    ],
    [
      'updateSubscription',
      () => provider.updateSubscription('x', {} as never),
    ],
    ['cancelSubscription', () => provider.cancelSubscription('x')],
    ['deleteSubscription', () => provider.deleteSubscription('x')],
    ['deletePayment', () => provider.deletePayment('x')],
  ])('%s throws ProviderNotSupportedError', async (_name, call) => {
    await expect(call()).rejects.toThrow(ProviderNotSupportedError);
  });
});
