import { PAYKIT_METADATA_KEY } from '@paykit-sdk/core';
import { createDecipheriv } from 'crypto';
import { describe, expect, it } from 'vitest';
import { FlutterwaveV3Transaction } from '../schema';
import { encryptV3Payload } from '../utils/encryption';
import {
  AUTHORIZATION_FIELDS_KEY,
  AUTHORIZATION_MODE_KEY,
  Checkout$fromTransaction,
  Payment$fromAuthorization,
  Payment$fromTransaction,
  Refund$inboundSchema,
  Subscription$fromHostedLink,
  Subscription$inboundSchema,
  flutterwaveV3RefundStatus,
  flutterwaveV3StatusToPaymentStatus,
  isPreauthorized,
  toBillingInterval,
} from '../utils/mapper';

const tx = (
  extra: Partial<FlutterwaveV3Transaction> = {},
): FlutterwaveV3Transaction => ({
  id: 10571115,
  tx_ref: 'ref-1',
  flw_ref: 'FLW-MOCK-1',
  amount: 1000,
  currency: 'NGN',
  status: 'successful',
  customer: { id: 1, email: 'a@example.com' },
  ...extra,
});

describe('flutterwaveV3StatusToPaymentStatus', () => {
  it.each([
    ['successful', 'succeeded'],
    ['success', 'succeeded'],
    ['failed', 'failed'],
    ['voided', 'canceled'],
    ['pending-capture', 'requires_capture'],
    ['pending', 'pending'],
    ['something-new', 'pending'],
  ])('maps %s to %s', (status, expected) => {
    expect(flutterwaveV3StatusToPaymentStatus(status)).toBe(expected);
  });

  it('reads a pending charge by what it is waiting on', () => {
    expect(
      flutterwaveV3StatusToPaymentStatus('pending', {
        authorization: { mode: 'otp' },
      }),
    ).toBe('requires_action');
    expect(
      flutterwaveV3StatusToPaymentStatus('pending', {
        preauth: true,
      }),
    ).toBe('requires_capture');
  });

  it('does not let a terminal status be overridden by context', () => {
    expect(
      flutterwaveV3StatusToPaymentStatus('successful', {
        preauth: true,
        authorization: { mode: 'otp' },
      }),
    ).toBe('succeeded');
  });
});

describe('isPreauthorized', () => {
  it('trusts charge_type when present', () => {
    expect(isPreauthorized({ charge_type: 'preauth' })).toBe(true);
    expect(isPreauthorized({ charge_type: 'normal' })).toBe(false);
  });

  it('falls back to the meta Flutterwave adds on verify', () => {
    expect(isPreauthorized({ meta: { trxauthorizeid: 'x' } })).toBe(
      true,
    );
    expect(isPreauthorized({ meta: { a: 'b' } })).toBe(false);
    expect(isPreauthorized({ meta: null })).toBe(false);
    expect(isPreauthorized({ meta: [] })).toBe(false);
  });
});

describe('Payment$fromTransaction', () => {
  it('uses the tx_ref as the id', () => {
    const payment = Payment$fromTransaction(tx());

    expect(payment).toMatchObject({
      id: 'ref-1',
      amount: 1000,
      currency: 'NGN',
      status: 'succeeded',
      customer: { email: 'a@example.com' },
      requires_action: false,
      payment_url: null,
    });
  });

  it('reads item_id and merchant metadata back out of meta', () => {
    const payment = Payment$fromTransaction(
      tx({
        meta: {
          order: 'o-1',
          [PAYKIT_METADATA_KEY]: JSON.stringify({
            item_id: 'item_9',
          }),
        },
      }),
    );

    expect(payment.item_id).toBe('item_9');
    expect(payment.metadata).toEqual({ order: 'o-1' });
  });

  it('accepts the [{ metaname, metavalue }] meta shape', () => {
    const payment = Payment$fromTransaction(
      tx({ meta: [{ metaname: 'order', metavalue: 'o-2' }] }),
    );

    expect(payment.metadata).toEqual({ order: 'o-2' });
  });

  it('keeps Flutterwave-written meta out of the metadata', () => {
    const payment = Payment$fromTransaction(
      tx({
        status: 'pending',
        meta: {
          hold: '1',
          trxauthorizeid: 'a',
          trxreference: 'b',
          old_amount: '7500',
          old_charged_amount: '7500',
          old_fee: '285',
          old_merchant_fee: '0',
        },
      }),
    );

    expect(payment.metadata).toEqual({ hold: '1' });
    expect(payment.status).toBe('requires_capture');
  });

  it('surfaces the next step while requires_action', () => {
    const payment = Payment$fromTransaction(
      tx({ status: 'pending' }),
      { mode: 'redirect', redirect: 'https://bank.example/3ds' },
    );

    expect(payment).toMatchObject({
      status: 'requires_action',
      requires_action: true,
      payment_url: 'https://bank.example/3ds',
    });
    expect(payment.metadata[AUTHORIZATION_MODE_KEY]).toBe('redirect');
  });

  it('drops the next step once the payment is complete', () => {
    const payment = Payment$fromTransaction(tx(), { mode: 'otp' });

    expect(payment.metadata).toEqual({});
    expect(payment.payment_url).toBeNull();
  });

  it('has no customer without an email', () => {
    expect(
      Payment$fromTransaction(tx({ customer: undefined })).customer,
    ).toBeNull();
  });
});

describe('Payment$fromAuthorization', () => {
  it('describes the step a card still needs', () => {
    const payment = Payment$fromAuthorization(
      { mode: 'avs_noauth', fields: ['city', 'address'] },
      {
        id: 'ref-2',
        amount: 5,
        currency: 'GHS',
        customer: { email: 'a@example.com' },
        metadata: {
          k: 'v',
          [PAYKIT_METADATA_KEY]: JSON.stringify({ item_id: 'i' }),
        },
      },
    );

    expect(payment).toEqual({
      id: 'ref-2',
      amount: 5,
      currency: 'GHS',
      customer: { email: 'a@example.com' },
      status: 'requires_action',
      item_id: 'i',
      metadata: {
        k: 'v',
        [AUTHORIZATION_MODE_KEY]: 'avs_noauth',
        [AUTHORIZATION_FIELDS_KEY]: 'city,address',
      },
      requires_action: true,
      payment_url: null,
    });
  });

  it('carries the redirect url', () => {
    expect(
      Payment$fromAuthorization(
        { mode: 'redirect', redirect: 'https://x.test/pay' },
        {
          id: 'r',
          amount: 1,
          currency: 'GHS',
          customer: null,
          metadata: {},
        },
      ).payment_url,
    ).toBe('https://x.test/pay');
  });
});

describe('Checkout$fromTransaction', () => {
  it('restores what createCheckout stored', () => {
    const checkout = Checkout$fromTransaction(
      tx({
        meta: {
          campaign: 'x',
          [PAYKIT_METADATA_KEY]: JSON.stringify({
            item_id: 'item_1',
            quantity: 3,
            type: 'recurring',
          }),
        },
      }),
    );

    expect(checkout).toMatchObject({
      id: 'ref-1',
      payment_url: '',
      session_type: 'recurring',
      products: [{ id: 'item_1', quantity: 3 }],
      metadata: { campaign: 'x' },
    });
  });

  it('defaults to a one-time checkout with no products', () => {
    expect(Checkout$fromTransaction(tx())).toMatchObject({
      session_type: 'one_time',
      products: [],
    });
  });
});

describe('Refund$inboundSchema', () => {
  it.each([
    ['completed', 'succeeded'],
    ['completed-mpgs', 'succeeded'],
    ['failed', 'failed'],
    ['pending', 'pending'],
    ['new-status', 'pending'],
  ])('maps refund status %s to %s', (status, expected) => {
    expect(flutterwaveV3RefundStatus(status)).toBe(expected);
  });

  it('prefers the reason that was sent', () => {
    expect(
      Refund$inboundSchema(
        { id: 9, amount_refunded: 400, status: 'completed' },
        'NGN',
        'asked',
      ),
    ).toEqual({
      id: '9',
      amount: 400,
      currency: 'NGN',
      reason: 'asked',
      metadata: null,
      status: 'succeeded',
    });
  });

  it('falls back to the comment Flutterwave returns', () => {
    expect(
      Refund$inboundSchema(
        {
          id: 9,
          amount_refunded: 1,
          status: 'completed',
          comment: 'from api',
        },
        'NGN',
        null,
      ).reason,
    ).toBe('from api');
  });
});

describe('toBillingInterval', () => {
  it.each([
    ['daily', 'day'],
    ['weekly', 'week'],
    ['monthly', 'month'],
    ['yearly', 'year'],
    ['annually', 'year'],
    ['unheard-of', 'month'],
  ])('maps %s to %s', (interval, expected) => {
    expect(toBillingInterval(interval)).toBe(expected);
  });

  it('represents hourly and quarterly as custom durations', () => {
    expect(toBillingInterval('hourly')).toEqual({
      type: 'custom',
      durationMs: 3_600_000,
    });
    expect(toBillingInterval('quarterly')).toEqual({
      type: 'custom',
      durationMs: 91 * 86_400_000,
    });
  });
});

describe('Subscription$inboundSchema', () => {
  const plan = {
    id: 246704,
    name: 'Pro',
    amount: 3000,
    interval: 'monthly',
    duration: 12,
    status: 'active',
    currency: 'NGN',
  };
  const sub = {
    id: 53791,
    amount: 3000,
    customer: { id: 1, customer_email: 'a@example.com' },
    plan: 246704,
    status: 'active',
    created_at: '2026-01-15T10:00:00.000Z',
  };

  it('maps the subscription and its plan', () => {
    const subscription = Subscription$inboundSchema(
      sub,
      plan,
      new Date('2026-01-20T00:00:00.000Z'),
    );

    expect(subscription).toMatchObject({
      id: '53791',
      customer: { email: 'a@example.com' },
      amount: 3000,
      currency: 'NGN',
      status: 'active',
      item_id: '246704',
      billing_interval: 'month',
      requires_action: false,
      payment_url: null,
      custom_fields: { plan_name: 'Pro' },
    });
  });

  it('works out the current period from when it started', () => {
    const { current_period_start, current_period_end } =
      Subscription$inboundSchema(
        sub,
        plan,
        new Date('2026-04-20T00:00:00.000Z'),
      );

    expect(current_period_start.toISOString()).toBe(
      '2026-04-15T10:00:00.000Z',
    );
    expect(current_period_end.toISOString()).toBe(
      '2026-05-15T10:00:00.000Z',
    );
  });

  it.each([
    ['cancelled', 'canceled'],
    ['deactivated', 'canceled'],
    ['completed', 'expired'],
    ['active', 'active'],
  ])('maps %s to %s', (status, expected) => {
    expect(
      Subscription$inboundSchema({ ...sub, status }, plan).status,
    ).toBe(expected);
  });

  it('steps by the plan interval', () => {
    const at = (interval: string) =>
      Subscription$inboundSchema(
        sub,
        { ...plan, interval },
        new Date('2026-01-15T10:30:00.000Z'),
      ).current_period_end.toISOString();

    expect(at('hourly')).toBe('2026-01-15T11:00:00.000Z');
    expect(at('daily')).toBe('2026-01-16T10:00:00.000Z');
    expect(at('weekly')).toBe('2026-01-22T10:00:00.000Z');
    expect(at('quarterly')).toBe('2026-04-15T10:00:00.000Z');
    expect(at('yearly')).toBe('2027-01-15T10:00:00.000Z');
  });
});

describe('Subscription$fromHostedLink', () => {
  it('is pending and points at the hosted link', () => {
    const now = new Date('2026-01-01T00:00:00.000Z');
    const subscription = Subscription$fromHostedLink(
      { link: 'https://checkout.example/pay' },
      {
        id: 'ref-sub',
        email: 'a@example.com',
        plan: {
          id: 7,
          name: 'Pro',
          amount: 100,
          interval: 'weekly',
          duration: 0,
          status: 'active',
          currency: 'GHS',
        },
        metadata: { who: 'me' },
      },
      now,
    );

    expect(subscription).toMatchObject({
      id: 'ref-sub',
      status: 'pending',
      requires_action: true,
      payment_url: 'https://checkout.example/pay',
      amount: 100,
      currency: 'GHS',
      item_id: '7',
      billing_interval: 'week',
      metadata: { who: 'me' },
    });
    expect(subscription.current_period_end.toISOString()).toBe(
      '2026-01-08T00:00:00.000Z',
    );
  });
});

describe('encryptV3Payload', () => {
  it('is 3DES-ECB with the 24 character key, base64 encoded', () => {
    const key = 'FLWSECK_TESTf3dc4cb892ac';
    const payload = { card_number: '5531886652142950', cvv: '564' };

    const encrypted = encryptV3Payload(payload, key);
    const decipher = createDecipheriv('des-ede3', key, null);
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encrypted, 'base64')),
      decipher.final(),
    ]).toString('utf8');

    expect(JSON.parse(decrypted)).toEqual(payload);
  });

  it('is deterministic, as ECB without an IV must be', () => {
    const key = 'FLWSECK_TESTf3dc4cb892ac';

    expect(encryptV3Payload({ a: 1 }, key)).toBe(
      encryptV3Payload({ a: 1 }, key),
    );
  });
});
