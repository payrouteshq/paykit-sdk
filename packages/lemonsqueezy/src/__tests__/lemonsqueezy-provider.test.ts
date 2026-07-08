import { describe, it, expect, vi } from 'vitest'; // swap for 'jest' if that's what the repo uses
import crypto from 'node:crypto';
import { LemonSqueezyProvider } from '../lemonsqueezy-provider';

function mockClient(responses: Record<string, unknown>) {
  return {
    get: vi.fn(async (path: string) => ({ ok: true, value: responses[path] })),
    post: vi.fn(async () => ({ ok: true, value: {} })),
    delete: vi.fn(async () => ({ ok: true, value: {} })),
  };
}

function makeProvider(client: ReturnType<typeof mockClient>, webhookSecret?: string) {
  const provider = new LemonSqueezyProvider({
    apiKey: 'test-api-key',
    storeId: '1',
    isSandbox: true,
    webhookSecret,
  });
  // constructor always builds its own real HTTPClient — swap it out for the mock
  (provider as any)._client = client;
  return provider;
}

describe('LemonSqueezyProvider', () => {
  it('maps retrieveCustomer to paykit Customer shape', async () => {
    const client = mockClient({
      '/customers/1': {
        type: 'customers',
        id: '1',
        attributes: { name: 'John Doe', email: 'john@example.com', city: null, region: null, country: 'US', status: 'subscribed' },
      },
    });
    const provider = makeProvider(client);
    const customer = await provider.retrieveCustomer('1');
    expect(customer.id).toBe('1');
    expect(customer.email).toBe('john@example.com');
  });

  it('maps retrieveSubscription to paykit Subscription shape', async () => {
    const client = mockClient({
      '/subscriptions/1': {
        type: 'subscriptions',
        id: '1',
        attributes: { customer_id: 1, product_id: 1, variant_id: 1, status: 'active', cancelled: false, trial_ends_at: null },
      },
    });
    const provider = makeProvider(client);
    const sub = await provider.retrieveSubscription('1');
    expect(sub.id).toBe('1');
    expect(sub.status).toBe('active');
  });

  it('verifies a valid webhook signature and maps the event', async () => {
    const secret = 'test-secret';
    const rawBody = JSON.stringify({ meta: { event_name: 'order_created' }, data: { id: '1' } });
    const signature = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');

    const provider = makeProvider(mockClient({}), secret);
    const events = await provider.handleWebhook(
      { headersAsObject: { 'X-Signature': signature }, rawBody } as any,
      secret,
    );

    expect(events[0].rawType).toBe('lemonsqueezy.order_created');
    expect(events[0].type).toBe('payment.succeeded'); // per LEMONSQUEEZY_EVENT_MAP
  });

  it('rejects an invalid webhook signature', async () => {
    const provider = makeProvider(mockClient({}), 'test-secret');
    await expect(
      provider.handleWebhook({ headersAsObject: { 'X-Signature': 'bad-signature' }, rawBody: '{}' } as any, 'test-secret'),
    ).rejects.toThrow();
  });
});