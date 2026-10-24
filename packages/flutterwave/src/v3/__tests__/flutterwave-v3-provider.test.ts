import {
  ConfigurationError,
  InvalidTypeError,
  OperationFailedError,
  PAYKIT_METADATA_KEY,
  ProviderNotSupportedError,
  ResourceNotFoundError,
  ValidationError,
  WebhookError,
} from '@paykit-sdk/core';
import { createDecipheriv } from 'crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createFlutterwave, flutterwave } from '../../index';
import { FlutterwaveV3Provider } from '../flutterwave-v3-provider';

const BASE_URL = 'https://api.flutterwave.com/v3';
const SECRET_KEY = 'FLWSECK_TEST-abc-X';
const ENCRYPTION_KEY = 'FLWSECK_TESTf3dc4cb892ac';
const HASH = 'secret-hash';

const makeProvider = (overrides: Record<string, unknown> = {}) =>
  new FlutterwaveV3Provider({
    secretKey: SECRET_KEY,
    encryptionKey: ENCRYPTION_KEY,
    isSandbox: true,
    debug: false,
    ...overrides,
  } as never);

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const ok = (data: unknown, extra: Record<string, unknown> = {}) =>
  jsonResponse({ status: 'success', message: 'ok', data, ...extra });

const fail = (message: string, status = 400, data: unknown = null) =>
  jsonResponse({ status: 'error', message, data }, status);

const notFound = () => fail('No transaction was found for this id');

const tx = (extra: Record<string, unknown> = {}) => ({
  id: 10571115,
  tx_ref: 'ref-1',
  flw_ref: 'FLW-MOCK-1',
  amount: 1000,
  currency: 'NGN',
  status: 'successful',
  payment_type: 'card',
  customer: { id: 1, email: 'a@example.com' },
  meta: {},
  ...extra,
});

const plan = (extra: Record<string, unknown> = {}) => ({
  id: 246704,
  name: 'Pro',
  amount: 3000,
  interval: 'monthly',
  duration: 12,
  status: 'active',
  currency: 'NGN',
  ...extra,
});

const subscription = (extra: Record<string, unknown> = {}) => ({
  id: 53791,
  amount: 3000,
  customer: { id: 1, customer_email: 'a@example.com' },
  plan: 246704,
  status: 'active',
  created_at: '2026-01-15T10:00:00.000Z',
  ...extra,
});

type Handler = () => Response | Promise<Response>;

/** Routes mocked fetch calls by `"METHOD url"`; unrouted calls fail the test. */
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
    const queue = queues.get(key);
    const handler =
      queue && (queue.length > 1 ? queue.shift() : queue[0]);

    if (!handler) throw new Error(`Unrouted request: ${key}`);

    return handler();
  });

  vi.stubGlobal('fetch', fetchMock);

  const bodyOf = (method: string, path: string) => {
    const call = fetchMock.mock.calls.find(
      ([url, init]) =>
        url === `${BASE_URL}${path}` && init?.method === method,
    );

    if (!call) throw new Error(`No ${method} ${path} call recorded`);

    return call[1]?.body
      ? JSON.parse(call[1].body as string)
      : undefined;
  };

  const callsTo = (method: string, path: string) =>
    fetchMock.mock.calls.filter(
      ([url, init]) =>
        url === `${BASE_URL}${path}` && init?.method === method,
    );

  return { fetchMock, bodyOf, callsTo };
};

const decrypt = (client: string) => {
  const decipher = createDecipheriv('des-ede3', ENCRYPTION_KEY, null);

  return JSON.parse(
    Buffer.concat([
      decipher.update(Buffer.from(client, 'base64')),
      decipher.final(),
    ]).toString('utf8'),
  );
};

const card = {
  number: '5531886652142950',
  cvv: '564',
  expiry_month: '09',
  expiry_year: '32',
};

const paymentParams = (extra: Record<string, unknown> = {}) => ({
  customer: { email: 'a@example.com' },
  amount: 1000,
  currency: 'NGN',
  item_id: 'item_1',
  metadata: { order: 'o-1' },
  capture_method: 'automatic' as const,
  provider_metadata: {
    reference: 'ref-1',
    card,
    redirect_url: 'https://example.com/done',
  },
  ...extra,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createFlutterwave', () => {
  it('returns the v3 provider for apiVersion v3', () => {
    expect(
      createFlutterwave({
        apiVersion: 'v3',
        secretKey: SECRET_KEY,
        isSandbox: true,
      }),
    ).toBeInstanceOf(FlutterwaveV3Provider);
  });

  it('returns the v4 provider otherwise', () => {
    expect(
      createFlutterwave({
        clientId: 'a',
        clientSecret: 'b',
        isSandbox: true,
      }).constructor.name,
    ).toBe('FlutterwaveProvider');
  });

  describe('flutterwave() from the environment', () => {
    const original = { ...process.env };

    afterEach(() => {
      process.env = { ...original };
    });

    it('is v3 when FLUTTERWAVE_API_VERSION says so', () => {
      process.env.FLUTTERWAVE_API_VERSION = 'v3';
      process.env.FLUTTERWAVE_SECRET_KEY = SECRET_KEY;

      expect(flutterwave()).toBeInstanceOf(FlutterwaveV3Provider);
    });

    it('is inferred as v3 from a secret key alone', () => {
      delete process.env.FLUTTERWAVE_API_VERSION;
      process.env.FLUTTERWAVE_SECRET_KEY = SECRET_KEY;

      expect(flutterwave()).toBeInstanceOf(FlutterwaveV3Provider);
    });

    it('leaves sandbox mode to the key when FLUTTERWAVE_SANDBOX is unset', () => {
      process.env.FLUTTERWAVE_API_VERSION = 'v3';
      process.env.FLUTTERWAVE_SECRET_KEY = 'FLWSECK-live-X';
      delete process.env.FLUTTERWAVE_SANDBOX;

      expect(flutterwave().isSandbox).toBe(false);
    });

    it('still honours FLUTTERWAVE_SANDBOX when it is set', () => {
      process.env.FLUTTERWAVE_API_VERSION = 'v3';
      process.env.FLUTTERWAVE_SECRET_KEY = SECRET_KEY;
      process.env.FLUTTERWAVE_SANDBOX = 'false';

      expect(() => flutterwave()).toThrow(ConfigurationError);
    });

    it('names the missing variable for v3', () => {
      process.env.FLUTTERWAVE_API_VERSION = 'v3';
      delete process.env.FLUTTERWAVE_SECRET_KEY;

      expect(() => flutterwave()).toThrow(/FLUTTERWAVE_SECRET_KEY/);
    });

    it('is v4 with client credentials', () => {
      delete process.env.FLUTTERWAVE_API_VERSION;
      delete process.env.FLUTTERWAVE_SECRET_KEY;
      process.env.FLUTTERWAVE_CLIENT_ID = 'id';
      process.env.FLUTTERWAVE_CLIENT_SECRET = 'secret';

      expect(flutterwave().constructor.name).toBe(
        'FlutterwaveProvider',
      );
    });
  });
});

describe('FlutterwaveV3Provider constructor', () => {
  it('requires a secret key', () => {
    expect(() => makeProvider({ secretKey: undefined })).toThrow(
      ConfigurationError,
    );
  });

  it('rejects a live key in sandbox mode and a test key in live mode', () => {
    expect(() =>
      makeProvider({ secretKey: 'FLWSECK-live-X' }),
    ).toThrow(ConfigurationError);
    expect(() => makeProvider({ isSandbox: false })).toThrow(
      ConfigurationError,
    );
    expect(() =>
      makeProvider({ secretKey: 'FLWSECK-live-X', isSandbox: false }),
    ).not.toThrow();
  });

  it('infers sandbox mode from the key when isSandbox is omitted', () => {
    expect(makeProvider({ isSandbox: undefined }).isSandbox).toBe(
      true,
    );
    expect(
      makeProvider({
        secretKey: 'FLWSECK-live-X',
        isSandbox: undefined,
      }).isSandbox,
    ).toBe(false);
  });

  it('builds through createFlutterwave without isSandbox', () => {
    const provider = createFlutterwave({
      apiVersion: 'v3',
      secretKey: SECRET_KEY,
    });

    expect(provider).toBeInstanceOf(FlutterwaveV3Provider);
    expect(provider.isSandbox).toBe(true);
  });

  it('only throws when an explicit isSandbox contradicts the key', () => {
    expect(() =>
      makeProvider({ secretKey: 'FLWSECK-live-X', isSandbox: true }),
    ).toThrow(/live key/);
    expect(() => makeProvider({ isSandbox: false })).toThrow(
      /test key/,
    );
  });

  it('sends the secret key as a bearer token', async () => {
    const { fetchMock } = useFetch({
      [`GET ${BASE_URL}/transactions/10/verify`]: () => ok(tx()),
    });

    await makeProvider().retrievePayment('10');

    expect(
      (fetchMock.mock.calls[0][1]?.headers as Record<string, string>)
        .Authorization,
    ).toBe(`Bearer ${SECRET_KEY}`);
  });
});

describe('createCheckout', () => {
  const params = (extra: Record<string, unknown> = {}) => ({
    customer: { email: 'a@example.com' },
    session_type: 'one_time' as const,
    item_id: 'item_1',
    quantity: 2,
    metadata: { campaign: 'x' },
    success_url: 'https://example.com/ok',
    cancel_url: 'https://example.com/no',
    provider_metadata: {
      reference: 'chk-1',
      amount: '2500',
      currency: 'ngn',
    },
    ...extra,
  });

  it('creates a hosted link', async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/payments`]: () =>
        ok({ link: 'https://checkout.example/pay/1' }),
    });

    const checkout = await makeProvider().createCheckout(params());

    expect(checkout).toEqual({
      id: 'chk-1',
      customer: { email: 'a@example.com' },
      payment_url: 'https://checkout.example/pay/1',
      metadata: { campaign: 'x' },
      session_type: 'one_time',
      products: [{ id: 'item_1', quantity: 2 }],
      currency: 'NGN',
      amount: 2500,
      subscription: null,
    });

    const body = bodyOf('POST', '/payments');

    expect(body).toMatchObject({
      tx_ref: 'chk-1',
      amount: 2500,
      currency: 'NGN',
      redirect_url: 'https://example.com/ok',
      customer: { email: 'a@example.com' },
    });
    expect(body.meta.campaign).toBe('x');
    expect(JSON.parse(body.meta[PAYKIT_METADATA_KEY])).toEqual({
      item_id: 'item_1',
      quantity: 2,
      type: 'one_time',
    });
    expect(body.payment_plan).toBeUndefined();
  });

  it('generates a reference when none is given', async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/payments`]: () =>
        ok({ link: 'https://x.test' }),
    });

    const checkout = await makeProvider().createCheckout(
      params({ provider_metadata: { amount: 1, currency: 'NGN' } }),
    );

    expect(checkout.id).toMatch(/^pk_/);
    expect(bodyOf('POST', '/payments').tx_ref).toBe(checkout.id);
  });

  it('passes through name, phone, payment options and customizations', async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/payments`]: () =>
        ok({ link: 'https://x.test' }),
    });

    await makeProvider().createCheckout(
      params({
        provider_metadata: {
          amount: 1,
          currency: 'NGN',
          customer_name: 'Ada',
          phone_number: '0801',
          payment_options: 'card,ussd',
          customizations: { title: 'Shop' },
        },
      }),
    );

    expect(bodyOf('POST', '/payments')).toMatchObject({
      customer: {
        email: 'a@example.com',
        name: 'Ada',
        phone_number: '0801',
      },
      payment_options: 'card,ussd',
      customizations: { title: 'Shop' },
    });
  });

  it('takes amount and currency from the plan for a recurring checkout', async () => {
    const { bodyOf } = useFetch({
      [`GET ${BASE_URL}/payment-plans/246704`]: () => ok(plan()),
      [`POST ${BASE_URL}/payments`]: () =>
        ok({ link: 'https://x.test' }),
    });

    const checkout = await makeProvider().createCheckout({
      customer: { email: 'a@example.com' },
      session_type: 'recurring',
      item_id: '246704',
      quantity: 1,
      metadata: null,
      subscription: {
        billing_interval: 'month',
        billing_interval_count: 1,
      },
      provider_metadata: { redirect_url: 'https://example.com/ok' },
    });

    expect(checkout).toMatchObject({
      amount: 3000,
      currency: 'NGN',
      session_type: 'recurring',
      subscription: {
        billing_interval: 'month',
        billing_interval_count: 1,
      },
    });
    expect(bodyOf('POST', '/payments')).toMatchObject({
      payment_plan: 246704,
      amount: 3000,
      redirect_url: 'https://example.com/ok',
    });
  });

  it('sends the session length and retry limit as configuration', async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/payments`]: () =>
        ok({ link: 'https://x.test' }),
    });

    await makeProvider().createCheckout(
      params({
        provider_metadata: {
          amount: 1,
          currency: 'NGN',
          session_duration: 1440,
          max_retry_attempt: 3,
        },
      }),
    );

    expect(bodyOf('POST', '/payments').configuration).toEqual({
      session_duration: 1440,
      max_retry_attempt: 3,
    });
  });

  it('sends only the option that was given', async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/payments`]: () =>
        ok({ link: 'https://x.test' }),
    });

    await makeProvider().createCheckout(
      params({
        provider_metadata: {
          amount: 1,
          currency: 'NGN',
          session_duration: 120,
        },
      }),
    );

    expect(bodyOf('POST', '/payments').configuration).toEqual({
      session_duration: 120,
    });
  });

  it('sends no configuration at all when neither is set', async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/payments`]: () =>
        ok({ link: 'https://x.test' }),
    });

    await makeProvider().createCheckout(params());

    expect(bodyOf('POST', '/payments')).not.toHaveProperty(
      'configuration',
    );
  });

  it.each([
    [
      "above Flutterwave's 1440 minute maximum",
      { session_duration: 1441 },
    ],
    ['zero', { session_duration: 0 }],
    ['negative', { session_duration: -5 }],
    ['fractional', { session_duration: 1.5 }],
    ['a zero retry limit', { max_retry_attempt: 0 }],
    ['a fractional retry limit', { max_retry_attempt: 1.5 }],
  ])('rejects %s instead of sending it', async (_name, extra) => {
    const { fetchMock } = useFetch();

    await expect(
      makeProvider().createCheckout(
        params({
          provider_metadata: { amount: 1, currency: 'NGN', ...extra },
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('carries the session options through createSubscription', async () => {
    const { bodyOf } = useFetch({
      [`GET ${BASE_URL}/payment-plans/246704`]: () => ok(plan()),
      [`POST ${BASE_URL}/payments`]: () =>
        ok({ link: 'https://x.test' }),
    });

    await makeProvider().createSubscription({
      customer: { email: 'a@example.com' },
      amount: 0,
      currency: 'NGN',
      item_id: '246704',
      billing_interval: 'month',
      metadata: null,
      quantity: 1,
      provider_metadata: {
        redirect_url: 'https://example.com/ok',
        session_duration: 600,
        max_retry_attempt: 2,
      },
    });

    expect(bodyOf('POST', '/payments').configuration).toEqual({
      session_duration: 600,
      max_retry_attempt: 2,
    });
  });

  it('needs amount and currency for a one-time checkout', async () => {
    useFetch();

    await expect(
      makeProvider().createCheckout(
        params({ provider_metadata: undefined }),
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('needs a redirect url when recurring', async () => {
    useFetch({
      [`GET ${BASE_URL}/payment-plans/246704`]: () => ok(plan()),
    });

    await expect(
      makeProvider().createCheckout({
        customer: { email: 'a@example.com' },
        session_type: 'recurring',
        item_id: '246704',
        quantity: 1,
        metadata: null,
        subscription: {
          billing_interval: 'month',
          billing_interval_count: 1,
        },
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('rejects an id customer and an all-digit reference', async () => {
    useFetch();

    await expect(
      makeProvider().createCheckout(
        params({ customer: { id: 'cus_1' } }),
      ),
    ).rejects.toBeInstanceOf(InvalidTypeError);
    await expect(
      makeProvider().createCheckout(
        params({
          provider_metadata: {
            amount: 1,
            currency: 'NGN',
            reference: '123',
          },
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("surfaces Flutterwave's reason when it refuses", async () => {
    useFetch({
      [`POST ${BASE_URL}/payments`]: () =>
        fail('One or more required parameters missing'),
    });

    await expect(
      makeProvider().createCheckout(params()),
    ).rejects.toThrow(/One or more required parameters missing/);
  });

  it('retrieves a paid checkout by reference', async () => {
    const { callsTo } = useFetch({
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=chk-1`]:
        () =>
          ok(
            tx({
              tx_ref: 'chk-1',
              meta: {
                [PAYKIT_METADATA_KEY]: JSON.stringify({
                  item_id: 'item_1',
                  quantity: 2,
                  type: 'one_time',
                }),
              },
            }),
          ),
    });

    const checkout = await makeProvider().retrieveCheckout('chk-1');

    expect(checkout).toMatchObject({
      id: 'chk-1',
      products: [{ id: 'item_1', quantity: 2 }],
    });
    expect(
      callsTo(
        'GET',
        '/transactions/verify_by_reference?tx_ref=chk-1',
      ),
    ).toHaveLength(1);
  });

  it('returns null until the checkout has been paid', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=chk-1`]:
        notFound,
    });

    expect(await makeProvider().retrieveCheckout('chk-1')).toBeNull();
  });

  it('cannot update or delete a checkout', async () => {
    await expect(
      makeProvider().updateCheckout('x', {}),
    ).rejects.toBeInstanceOf(ProviderNotSupportedError);
    await expect(
      makeProvider().deleteCheckout('x'),
    ).rejects.toBeInstanceOf(ProviderNotSupportedError);
  });
});

describe('createPayment', () => {
  it('encrypts the card and returns the step Flutterwave asks for', async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/charges?type=card`]: () =>
        jsonResponse({
          status: 'success',
          message: 'Charge authorization data required',
          meta: { authorization: { mode: 'pin', fields: ['pin'] } },
        }),
    });

    const payment =
      await makeProvider().createPayment(paymentParams());

    expect(payment).toMatchObject({
      id: 'ref-1',
      amount: 1000,
      currency: 'NGN',
      status: 'requires_action',
      requires_action: true,
      item_id: 'item_1',
      customer: { email: 'a@example.com' },
      metadata: {
        order: 'o-1',
        flutterwave_authorization_mode: 'pin',
        flutterwave_authorization_fields: 'pin',
      },
    });

    const body = bodyOf('POST', '/charges?type=card');

    expect(Object.keys(body)).toEqual(['client']);
    expect(decrypt(body.client)).toMatchObject({
      card_number: card.number,
      cvv: '564',
      expiry_month: '09',
      expiry_year: '32',
      tx_ref: 'ref-1',
      amount: 1000,
      currency: 'NGN',
      email: 'a@example.com',
      redirect_url: 'https://example.com/done',
    });
    expect(decrypt(body.client).authorization).toBeUndefined();
    expect(decrypt(body.client).meta.order).toBe('o-1');
  });

  it("sends the customer's authorization back with the card", async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/charges?type=card`]: () =>
        jsonResponse({
          status: 'success',
          message: 'Charge initiated',
          data: tx({ status: 'pending' }),
          meta: { authorization: { mode: 'otp' } },
        }),
    });

    const payment = await makeProvider().createPayment(
      paymentParams({
        provider_metadata: {
          reference: 'ref-1',
          card,
          authorization: { mode: 'pin', pin: '3310' },
        },
      }),
    );

    expect(
      decrypt(bodyOf('POST', '/charges?type=card').client),
    ).toMatchObject({
      authorization: { mode: 'pin', pin: '3310' },
    });
    expect(payment.status).toBe('requires_action');
    expect(payment.metadata.flutterwave_authorization_mode).toBe(
      'otp',
    );
    expect(payment.metadata.order).toBe('o-1');
    expect(payment.item_id).toBe('item_1');
  });

  it('returns the redirect for a 3DS card', async () => {
    useFetch({
      [`POST ${BASE_URL}/charges?type=card`]: () =>
        jsonResponse({
          status: 'success',
          message: 'Charge initiated',
          data: tx({ status: 'pending' }),
          meta: {
            authorization: {
              mode: 'redirect',
              redirect: 'https://bank.example/3ds',
            },
          },
        }),
    });

    expect(
      await makeProvider().createPayment(paymentParams()),
    ).toMatchObject({
      status: 'requires_action',
      payment_url: 'https://bank.example/3ds',
    });
  });

  it('completes straight away when no further step is needed', async () => {
    useFetch({
      [`POST ${BASE_URL}/charges?type=card`]: () => ok(tx(), {}),
    });

    expect(
      await makeProvider().createPayment(paymentParams()),
    ).toMatchObject({ status: 'succeeded', requires_action: false });
  });

  it('preauthorizes a card for capture_method manual', async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/charges?type=card`]: () =>
        ok(tx({ status: 'pending', charge_type: 'preauth' })),
    });

    const payment = await makeProvider().createPayment(
      paymentParams({ capture_method: 'manual' }),
    );

    expect(payment.status).toBe('requires_capture');
    expect(
      decrypt(bodyOf('POST', '/charges?type=card').client)
        .preauthorize,
    ).toBe(true);
  });

  it('charges a saved card token with a tokenized charge', async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/tokenized-charges`]: () =>
        ok(
          tx({
            status: 'pending',
            meta: {
              authorization: {
                mode: 'redirect',
                redirect: 'https://bank.example/3ds',
              },
            },
          }),
        ),
    });

    const payment = await makeProvider().createPayment(
      paymentParams({
        provider_metadata: {
          reference: 'ref-1',
          token: 'flw-t1nf-abc',
          fullname: 'Ada Lovelace Byron',
          redirect_url: 'https://example.com/done',
        },
      }),
    );

    expect(bodyOf('POST', '/tokenized-charges')).toMatchObject({
      token: 'flw-t1nf-abc',
      country: 'NG',
      first_name: 'Ada',
      last_name: 'Lovelace Byron',
      tx_ref: 'ref-1',
      email: 'a@example.com',
    });
    expect(payment).toMatchObject({
      status: 'requires_action',
      payment_url: 'https://bank.example/3ds',
    });
    expect(payment.metadata).not.toHaveProperty('authorization');
  });

  it('sends other payment types as plain JSON to their own endpoint', async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/charges?type=mobile_money_ghana`]: () =>
        jsonResponse({
          status: 'success',
          message: 'Charge initiated',
          meta: {
            authorization: {
              mode: 'redirect',
              redirect: 'https://checkout.example/captcha',
            },
          },
        }),
    });

    const payment = await makeProvider().createPayment(
      paymentParams({
        currency: 'GHS',
        provider_metadata: {
          reference: 'momo-1',
          payment_type: 'mobile_money_ghana',
          phone_number: '0551234987',
          fullname: 'Ada',
          fields: { network: 'MTN' },
        },
      }),
    );

    expect(
      bodyOf('POST', '/charges?type=mobile_money_ghana'),
    ).toMatchObject({
      tx_ref: 'momo-1',
      amount: 1000,
      currency: 'GHS',
      email: 'a@example.com',
      phone_number: '0551234987',
      fullname: 'Ada',
      network: 'MTN',
    });
    expect(payment).toMatchObject({
      id: 'momo-1',
      status: 'requires_action',
      payment_url: 'https://checkout.example/captcha',
    });
  });

  it('subscribes the customer when given a payment plan', async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/charges?type=card`]: () => ok(tx()),
    });

    await makeProvider().createPayment(
      paymentParams({
        provider_metadata: {
          reference: 'ref-1',
          card,
          payment_plan: '246704',
        },
      }),
    );

    expect(
      decrypt(bodyOf('POST', '/charges?type=card').client)
        .payment_plan,
    ).toBe('246704');
  });

  it('stores item_id under the PayKit key and merchant metadata beside it', async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/charges?type=card`]: () => ok(tx()),
    });

    await makeProvider().createPayment(paymentParams());

    const meta = decrypt(
      bodyOf('POST', '/charges?type=card').client,
    ).meta;

    expect(meta.order).toBe('o-1');
    expect(JSON.parse(meta[PAYKIT_METADATA_KEY])).toEqual({
      item_id: 'item_1',
    });
  });

  it('generates a reference when none is given', async () => {
    const { bodyOf } = useFetch({
      [`POST ${BASE_URL}/charges?type=card`]: () => ok(tx()),
    });

    await makeProvider().createPayment(
      paymentParams({ provider_metadata: { card } }),
    );

    expect(
      decrypt(bodyOf('POST', '/charges?type=card').client).tx_ref,
    ).toMatch(/^pk_/);
  });

  it('validates its input before calling Flutterwave', async () => {
    const { fetchMock } = useFetch();
    const provider = makeProvider();

    await expect(
      provider.createPayment(
        paymentParams({ customer: { id: 'cus_1' } }),
      ),
    ).rejects.toBeInstanceOf(InvalidTypeError);
    await expect(
      provider.createPayment(
        paymentParams({ provider_metadata: { reference: 'r' } }),
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      makeProvider({ encryptionKey: undefined }).createPayment(
        paymentParams(),
      ),
    ).rejects.toBeInstanceOf(ConfigurationError);
    await expect(
      provider.createPayment(
        paymentParams({
          provider_metadata: { card, reference: '12345' },
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      provider.createPayment(
        paymentParams({
          capture_method: 'manual',
          provider_metadata: { payment_type: 'mpesa' },
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
    await expect(
      provider.createPayment({ amount: 'x' } as never),
    ).rejects.toBeInstanceOf(ValidationError);

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("throws Flutterwave's reason when the charge is declined", async () => {
    useFetch({
      [`POST ${BASE_URL}/charges?type=card`]: () =>
        fail('Insufficient Funds', 400),
    });

    const error = await makeProvider()
      .createPayment(paymentParams())
      .catch(e => e);

    expect(error).toBeInstanceOf(OperationFailedError);
    expect(error.message).toMatch(/Insufficient Funds/);
  });

  it('throws when Flutterwave answers with neither a transaction nor a next step', async () => {
    useFetch({
      [`POST ${BASE_URL}/charges?type=card`]: () =>
        jsonResponse({ status: 'success', message: 'huh' }),
    });

    await expect(
      makeProvider().createPayment(paymentParams()),
    ).rejects.toBeInstanceOf(OperationFailedError);
  });

  it('never retries a write, since there is no idempotency key', async () => {
    const { callsTo } = useFetch({
      [`POST ${BASE_URL}/charges?type=card`]: () =>
        fail('Service unavailable', 503),
    });

    await expect(
      makeProvider().createPayment(paymentParams()),
    ).rejects.toBeInstanceOf(OperationFailedError);
    expect(callsTo('POST', '/charges?type=card')).toHaveLength(1);
  });
});

describe('retrievePayment', () => {
  it('looks up a reference with verify_by_reference', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=ref%2F1`]:
        () => ok(tx({ tx_ref: 'ref/1' })),
    });

    expect((await makeProvider().retrievePayment('ref/1'))?.id).toBe(
      'ref/1',
    );
  });

  it('looks up a numeric id with verify', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/10571115/verify`]: () =>
        ok(tx()),
    });

    expect(
      (await makeProvider().retrievePayment('10571115'))?.id,
    ).toBe('ref-1');
  });

  it('returns null when the transaction does not exist', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/9/verify`]: notFound,
    });

    expect(await makeProvider().retrievePayment('9')).toBeNull();
  });

  it('throws on any other failure rather than reporting not found', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/9/verify`]: () =>
        fail('Invalid secret key passed', 401),
    });

    const error = await makeProvider()
      .retrievePayment('9')
      .catch(e => e);

    expect(error).toBeInstanceOf(OperationFailedError);
    expect(error.message).toMatch(/Invalid secret key passed/);
  });

  it('marks a pending preauthorization as requires_capture', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/9/verify`]: () =>
        ok(
          tx({
            status: 'pending',
            meta: { trxauthorizeid: 'a', hold: '1' },
          }),
        ),
    });

    expect(await makeProvider().retrievePayment('9')).toMatchObject({
      status: 'requires_capture',
      metadata: { hold: '1' },
    });
  });
});

describe('updatePayment', () => {
  it('validates the OTP against the charge', async () => {
    const { bodyOf } = useFetch({
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=ref-1`]:
        () => ok(tx({ status: 'pending', meta: { order: 'o-1' } })),
      [`POST ${BASE_URL}/validate-charge`]: () => ok(tx()),
    });

    const payment = await makeProvider().updatePayment('ref-1', {
      provider_metadata: { otp: '12345' },
    });

    expect(bodyOf('POST', '/validate-charge')).toEqual({
      otp: '12345',
      flw_ref: 'FLW-MOCK-1',
      type: 'card',
    });
    expect(payment).toMatchObject({
      status: 'succeeded',
      metadata: { order: 'o-1' },
    });
  });

  it('uses the account type for bank charges', async () => {
    const { bodyOf } = useFetch({
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=ref-1`]:
        () => ok(tx({ payment_type: 'account' })),
      [`POST ${BASE_URL}/validate-charge`]: () => ok(tx()),
    });

    await makeProvider().updatePayment('ref-1', {
      provider_metadata: { otp: '1' },
    });

    expect(bodyOf('POST', '/validate-charge').type).toBe('account');
  });

  it('only supports completing a charge with an OTP', async () => {
    useFetch();

    await expect(
      makeProvider().updatePayment('ref-1', { metadata: { a: 'b' } }),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('is not found for an unknown payment', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=ref-1`]:
        notFound,
    });

    await expect(
      makeProvider().updatePayment('ref-1', {
        provider_metadata: { otp: '1' },
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('surfaces a failed validation', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=ref-1`]:
        () => ok(tx({ status: 'pending' })),
      [`POST ${BASE_URL}/validate-charge`]: () =>
        fail('Charge validation failed'),
    });

    await expect(
      makeProvider().updatePayment('ref-1', {
        provider_metadata: { otp: '5548' },
      }),
    ).rejects.toThrow(/Charge validation failed/);
  });
});

describe('capturePayment and cancelPayment', () => {
  const preauth = () =>
    ok(
      tx({
        amount: 7500,
        status: 'pending',
        meta: { trxauthorizeid: 'a', hold: '1' },
      }),
    );

  const verifyRoute = {
    [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=ref-1`]:
      preauth,
  };

  it('captures part of a preauthorization by flw_ref', async () => {
    const { bodyOf } = useFetch({
      ...verifyRoute,
      [`POST ${BASE_URL}/charges/FLW-MOCK-1/capture`]: () =>
        ok(tx({ amount: 5000, charge_type: 'preauth' })),
    });

    const payment = await makeProvider().capturePayment('ref-1', {
      amount: 5000,
    });

    expect(bodyOf('POST', '/charges/FLW-MOCK-1/capture')).toEqual({
      amount: '5000',
    });
    expect(payment).toMatchObject({
      status: 'succeeded',
      amount: 5000,
      metadata: { hold: '1' },
    });
  });

  it('refuses to capture more than was authorized', async () => {
    const { callsTo } = useFetch(verifyRoute);

    await expect(
      makeProvider().capturePayment('ref-1', { amount: 9000 }),
    ).rejects.toBeInstanceOf(ValidationError);
    expect(
      callsTo('POST', '/charges/FLW-MOCK-1/capture'),
    ).toHaveLength(0);
  });

  it('voids a preauthorization', async () => {
    useFetch({
      ...verifyRoute,
      [`POST ${BASE_URL}/charges/FLW-MOCK-1/void`]: () =>
        ok(tx({ amount: 7500, status: 'voided' })),
    });

    expect(await makeProvider().cancelPayment('ref-1')).toMatchObject(
      {
        status: 'canceled',
      },
    );
  });

  it('only acts on a pending preauthorization', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=ref-1`]:
        () => ok(tx()),
    });

    await expect(
      makeProvider().capturePayment('ref-1', { amount: 1000 }),
    ).rejects.toBeInstanceOf(ProviderNotSupportedError);
    await expect(
      makeProvider().cancelPayment('ref-1'),
    ).rejects.toBeInstanceOf(ProviderNotSupportedError);
  });

  it('is not found for an unknown payment', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=ref-1`]:
        notFound,
    });

    await expect(
      makeProvider().capturePayment('ref-1', { amount: 1 }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
    await expect(
      makeProvider().cancelPayment('ref-1'),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('cannot delete a payment', async () => {
    await expect(
      makeProvider().deletePayment('ref-1'),
    ).rejects.toBeInstanceOf(ProviderNotSupportedError);
  });
});

describe('createRefund', () => {
  const route = {
    [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=ref-1`]:
      () => ok(tx()),
  };
  const refundResponse = (extra: Record<string, unknown> = {}) =>
    ok({
      id: 109890,
      amount_refunded: 400,
      status: 'completed',
      flw_ref: 'FLW-REFUND',
      ...extra,
    });

  it('refunds by the numeric transaction id', async () => {
    const { bodyOf } = useFetch({
      ...route,
      [`POST ${BASE_URL}/transactions/10571115/refund`]:
        refundResponse,
    });

    const refund = await makeProvider().createRefund({
      payment_id: 'ref-1',
      amount: 400,
      reason: 'customer asked',
      metadata: null,
    });

    expect(bodyOf('POST', '/transactions/10571115/refund')).toEqual({
      amount: 400,
      comments: 'customer asked',
    });
    expect(refund).toEqual({
      id: '109890',
      amount: 400,
      currency: 'NGN',
      reason: 'customer asked',
      metadata: null,
      status: 'succeeded',
    });
  });

  it('omits the amount to refund everything', async () => {
    const { bodyOf } = useFetch({
      ...route,
      [`POST ${BASE_URL}/transactions/10571115/refund`]: () =>
        refundResponse({ amount_refunded: 1000 }),
    });

    const refund = await makeProvider().createRefund({
      payment_id: 'ref-1',
      amount: 0,
      reason: null,
      metadata: null,
    });

    expect(bodyOf('POST', '/transactions/10571115/refund')).toEqual(
      {},
    );
    expect(refund).toMatchObject({ amount: 1000, reason: null });
  });

  it('accepts a numeric transaction id as the payment id', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/10571115/verify`]: () =>
        ok(tx()),
      [`POST ${BASE_URL}/transactions/10571115/refund`]:
        refundResponse,
    });

    await expect(
      makeProvider().createRefund({
        payment_id: '10571115',
        amount: 1,
        reason: null,
        metadata: null,
      }),
    ).resolves.toMatchObject({ currency: 'NGN' });
  });

  it('is not found for an unknown payment', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=ref-1`]:
        notFound,
    });

    await expect(
      makeProvider().createRefund({
        payment_id: 'ref-1',
        amount: 1,
        reason: null,
        metadata: null,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('surfaces why Flutterwave refused', async () => {
    useFetch({
      ...route,
      [`POST ${BASE_URL}/transactions/10571115/refund`]: () =>
        fail(
          'Some error occured',
          400,
          'Error: Cannot refund an amount greater than the charged amount',
        ),
    });

    await expect(
      makeProvider().createRefund({
        payment_id: 'ref-1',
        amount: 99999,
        reason: null,
        metadata: null,
      }),
    ).rejects.toThrow(/Cannot refund an amount greater/);
  });

  it('rejects a negative amount', async () => {
    useFetch();

    await expect(
      makeProvider().createRefund({
        payment_id: 'ref-1',
        amount: -1,
        reason: null,
        metadata: null,
      }),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

describe('customers', () => {
  it('are not supported by Flutterwave v3', async () => {
    const provider = makeProvider();

    await expect(
      provider.createCustomer({ email: 'a@example.com' } as never),
    ).rejects.toBeInstanceOf(ProviderNotSupportedError);
    await expect(
      provider.retrieveCustomer('1'),
    ).rejects.toBeInstanceOf(ProviderNotSupportedError);
    await expect(
      provider.updateCustomer('1', {}),
    ).rejects.toBeInstanceOf(ProviderNotSupportedError);
    await expect(provider.deleteCustomer('1')).rejects.toBeInstanceOf(
      ProviderNotSupportedError,
    );
  });
});

describe('subscriptions', () => {
  const planRoute = {
    [`GET ${BASE_URL}/payment-plans/246704`]: () => ok(plan()),
  };

  it('createSubscription returns a pending hosted link', async () => {
    const { bodyOf } = useFetch({
      ...planRoute,
      [`POST ${BASE_URL}/payments`]: () =>
        ok({ link: 'https://checkout.example/sub' }),
    });

    const created = await makeProvider().createSubscription({
      customer: { email: 'a@example.com' },
      amount: 0,
      currency: 'NGN',
      item_id: '246704',
      billing_interval: 'month',
      metadata: { who: 'me' },
      quantity: 1,
      provider_metadata: {
        reference: 'sub-1',
        redirect_url: 'https://example.com/ok',
      },
    });

    expect(created).toMatchObject({
      id: 'sub-1',
      status: 'pending',
      requires_action: true,
      payment_url: 'https://checkout.example/sub',
      amount: 3000,
      currency: 'NGN',
      item_id: '246704',
      billing_interval: 'month',
      metadata: { who: 'me' },
    });
    expect(bodyOf('POST', '/payments').payment_plan).toBe(246704);
  });

  it('createSubscription needs an email customer and a redirect url', async () => {
    useFetch();

    await expect(
      makeProvider().createSubscription({
        customer: { id: 'cus_1' },
        amount: 0,
        currency: 'NGN',
        item_id: '1',
        billing_interval: 'month',
        metadata: null,
        quantity: 1,
        provider_metadata: { redirect_url: 'https://example.com' },
      }),
    ).rejects.toBeInstanceOf(InvalidTypeError);
    await expect(
      makeProvider().createSubscription({
        customer: { email: 'a@example.com' },
        amount: 0,
        currency: 'NGN',
        item_id: '1',
        billing_interval: 'month',
        metadata: null,
        quantity: 1,
      }),
    ).rejects.toBeInstanceOf(ConfigurationError);
  });

  it('resolves a checkout reference through the transaction that paid it', async () => {
    useFetch({
      ...planRoute,
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=sub-1`]:
        () => ok(tx({ id: 77, tx_ref: 'sub-1' })),
      [`GET ${BASE_URL}/subscriptions?transaction_id=77`]: () =>
        ok([subscription()]),
    });

    expect(
      await makeProvider().retrieveSubscription('sub-1'),
    ).toMatchObject({
      id: '53791',
      status: 'active',
      item_id: '246704',
      billing_interval: 'month',
    });
  });

  it('is null when the reference was never paid or never subscribed', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=a`]:
        notFound,
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=b`]:
        () => ok(tx({ id: 78 })),
      [`GET ${BASE_URL}/subscriptions?transaction_id=78`]: () =>
        ok([]),
    });

    const provider = makeProvider();

    expect(await provider.retrieveSubscription('a')).toBeNull();
    expect(await provider.retrieveSubscription('b')).toBeNull();
  });

  it('finds a numeric id by paging through the list', async () => {
    const { callsTo } = useFetch({
      ...planRoute,
      [`GET ${BASE_URL}/subscriptions?page=1`]: () =>
        ok([subscription({ id: 1 })], {
          meta: {
            page_info: { total: 2, current_page: 1, total_pages: 2 },
          },
        }),
      [`GET ${BASE_URL}/subscriptions?page=2`]: () =>
        ok([subscription({ id: 53791 })], {
          meta: {
            page_info: { total: 2, current_page: 2, total_pages: 2 },
          },
        }),
    });

    const found = await makeProvider().retrieveSubscription('53791');

    expect(found?.id).toBe('53791');
    expect(callsTo('GET', '/subscriptions?page=2')).toHaveLength(1);
  });

  it('stops paging at the last page', async () => {
    const { callsTo } = useFetch({
      [`GET ${BASE_URL}/subscriptions?page=1`]: () =>
        ok([subscription({ id: 1 })], {
          meta: {
            page_info: { total: 1, current_page: 1, total_pages: 1 },
          },
        }),
    });

    expect(
      await makeProvider().retrieveSubscription('999'),
    ).toBeNull();
    expect(callsTo('GET', '/subscriptions?page=2')).toHaveLength(0);
  });

  it('stops when there are no subscriptions at all', async () => {
    useFetch({
      [`GET ${BASE_URL}/subscriptions?page=1`]: () =>
        ok([], {
          meta: {
            page_info: { total: 0, current_page: 0, total_pages: 0 },
          },
        }),
    });

    expect(await makeProvider().retrieveSubscription('1')).toBeNull();
  });

  it('cancels a subscription', async () => {
    useFetch({
      ...planRoute,
      [`GET ${BASE_URL}/subscriptions?page=1`]: () =>
        ok([subscription()], {
          meta: {
            page_info: { total: 1, current_page: 1, total_pages: 1 },
          },
        }),
      [`PUT ${BASE_URL}/subscriptions/53791/cancel`]: () =>
        ok(subscription({ status: 'cancelled' })),
    });

    expect(
      await makeProvider().cancelSubscription('53791'),
    ).toMatchObject({ id: '53791', status: 'canceled' });
  });

  it('cancelling an unknown subscription is not found', async () => {
    useFetch({
      [`GET ${BASE_URL}/subscriptions?page=1`]: () =>
        ok([], {
          meta: {
            page_info: { total: 0, current_page: 0, total_pages: 0 },
          },
        }),
    });

    await expect(
      makeProvider().cancelSubscription('1'),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('cannot update or delete a subscription', async () => {
    await expect(
      makeProvider().updateSubscription('1', { metadata: {} }),
    ).rejects.toBeInstanceOf(ProviderNotSupportedError);
    await expect(
      makeProvider().deleteSubscription('1'),
    ).rejects.toBeInstanceOf(ProviderNotSupportedError);
  });
});

describe('handleWebhook', () => {
  const send = (
    body: unknown,
    headers: Record<string, string> = { 'verif-hash': HASH },
    secret: string | null = HASH,
  ) =>
    makeProvider().handleWebhook(
      {
        body: typeof body === 'string' ? body : JSON.stringify(body),
        headersAsObject: headers,
      } as never,
      secret,
    );

  const verifyRoute = (ref = 'ref-1', extra = {}) => ({
    [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=${ref}`]:
      () => ok(tx({ tx_ref: ref, ...extra })),
  });

  it('maps a legacy charge payload, after re-reading the payment', async () => {
    const { callsTo } = useFetch(verifyRoute());

    const events = await send({
      id: 1,
      txRef: 'ref-1',
      flwRef: 'x',
      status: 'successful',
      amount: 1000,
      currency: 'NGN',
      'event.type': 'CARD_TRANSACTION',
    });

    expect(events.map(e => e.type)).toEqual([
      'flutterwave.charge.completed',
      'payment.succeeded',
    ]);
    expect(events[0].is_raw).toBe(true);
    expect(events[1].data).toMatchObject({
      id: 'ref-1',
      status: 'succeeded',
    });
    expect(
      callsTo(
        'GET',
        '/transactions/verify_by_reference?tx_ref=ref-1',
      ),
    ).toHaveLength(1);
  });

  it('trusts the re-read, not the notification, for the outcome', async () => {
    useFetch(verifyRoute('ref-1', { status: 'failed' }));

    const events = await send({
      event: 'charge.completed',
      data: { id: 1, tx_ref: 'ref-1', status: 'successful' },
    });

    expect(events.map(e => e.type)).toEqual([
      'flutterwave.charge.completed',
      'payment.failed',
    ]);
  });

  it('maps a pending preauthorization to payment.updated', async () => {
    useFetch(
      verifyRoute('ref-1', {
        status: 'pending',
        meta: { trxauthorizeid: 'a' },
      }),
    );

    const events = await send({
      id: 1,
      txRef: 'ref-1',
      status: 'pending-capture',
      charge_type: 'preauth',
    });

    expect(events[1]).toMatchObject({
      type: 'payment.updated',
      data: { status: 'requires_capture' },
    });
  });

  it('says so, apart from a bad signature, when the payment is unknown', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=gone`]:
        notFound,
    });

    const error = await send({
      id: 1,
      txRef: 'gone',
      status: 'successful',
    }).catch(e => e);

    expect(error).toBeInstanceOf(ResourceNotFoundError);
    expect(error).not.toBeInstanceOf(WebhookError);
    expect(error.message).toMatch(/gone/);
  });

  it('keeps failing with an operational error when the lookup itself fails', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/verify_by_reference?tx_ref=ref-1`]:
        () => fail('Invalid secret key passed', 401),
    });

    const error = await send({
      id: 1,
      txRef: 'ref-1',
      status: 'successful',
    }).catch(e => e);

    expect(error).toBeInstanceOf(OperationFailedError);
    expect(error).not.toBeInstanceOf(ResourceNotFoundError);
    expect(error).not.toBeInstanceOf(WebhookError);
  });

  it('rejects a charge payload that names no transaction', async () => {
    useFetch();

    await expect(
      send({
        event: 'charge.completed',
        data: { status: 'successful' },
      }),
    ).rejects.toBeInstanceOf(WebhookError);
  });

  it('maps a refund, taking its currency from the transaction', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/10571115/verify`]: () =>
        ok(tx()),
    });

    const events = await send({
      id: 55,
      AmountRefunded: 250,
      status: 'completed',
      FlwRef: 'r',
      comments: null,
      TransactionId: 10571115,
    });

    expect(events.map(e => e.type)).toEqual([
      'flutterwave.refund.completed',
      'refund.created',
    ]);
    expect(events[1].data).toEqual({
      id: '55',
      amount: 250,
      currency: 'NGN',
      reason: null,
      metadata: null,
      status: 'succeeded',
    });
  });

  it('says so when a refund is for an unknown transaction', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/9/verify`]: notFound,
    });

    await expect(
      send({
        id: 1,
        AmountRefunded: 1,
        status: 'completed',
        TransactionId: 9,
      }),
    ).rejects.toBeInstanceOf(ResourceNotFoundError);
  });

  it('keeps failing with an operational error when a refund lookup fails', async () => {
    useFetch({
      [`GET ${BASE_URL}/transactions/9/verify`]: () =>
        fail('Invalid secret key passed', 401),
    });

    await expect(
      send({
        id: 1,
        AmountRefunded: 1,
        status: 'completed',
        TransactionId: 9,
      }),
    ).rejects.toBeInstanceOf(OperationFailedError);
  });

  it('rejects a refund payload that names no transaction', async () => {
    useFetch();

    await expect(
      send({ id: 1, AmountRefunded: 1, status: 'completed' }),
    ).rejects.toBeInstanceOf(WebhookError);
  });

  it('maps subscription.cancelled straight from the payload', async () => {
    const { fetchMock } = useFetch();

    const events = await send({
      event: 'subscription.cancelled',
      data: {
        id: '53791',
        status: 'deactivated',
        currency: 'NGN',
        amount: 3000,
        customer: { email: 'a@example.com', full_name: 'A B' },
        plan: plan(),
      },
    });

    expect(events.map(e => e.type)).toEqual([
      'flutterwave.subscription.cancelled',
      'subscription.canceled',
    ]);
    expect(events[1].data).toMatchObject({
      id: '53791',
      status: 'canceled',
      item_id: '246704',
      billing_interval: 'month',
      customer: { email: 'a@example.com' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('leaves other events as raw only', async () => {
    useFetch();

    const events = await send({
      event: 'transfer.completed',
      'event.type': 'Transfer',
      data: { id: 1 },
    });

    expect(events.map(e => e.type)).toEqual([
      'flutterwave.transfer.completed',
    ]);
  });

  it('gives the same delivery the same event ids', async () => {
    useFetch(verifyRoute());
    const body = { id: 1, txRef: 'ref-1', status: 'successful' };

    const [a, b] = await Promise.all([send(body), send(body)]);

    expect(a.map(e => e.id)).toEqual(b.map(e => e.id));
  });

  it('rejects a wrong or missing hash, secret, or a bad body', async () => {
    useFetch();

    await expect(
      send({ a: 1 }, { 'verif-hash': 'wrong' }),
    ).rejects.toThrow(/Invalid Flutterwave webhook secret hash/);
    await expect(send({ a: 1 }, {})).rejects.toThrow(
      /Missing verif-hash/,
    );
    await expect(
      send({ a: 1 }, { 'verif-hash': HASH }, null),
    ).rejects.toThrow(/webhookSecret is required/);
    await expect(send('not json')).rejects.toThrow(/not valid JSON/);
    await expect(send({ hello: 'world' })).rejects.toThrow(
      /Unrecognized/,
    );
  });
});
