import { validateRequiredKeys } from '@paykit-sdk/core';
import { LemonSqueezyOptions, LemonSqueezyProvider } from './lemonsqueezy-provider';

export const createLemonSqueezy = (config: LemonSqueezyOptions) =>
  new LemonSqueezyProvider(config);

export const lemonsqueezy = () => {
  const envVars = validateRequiredKeys(
    ['LEMONSQUEEZY_API_KEY', 'LEMONSQUEEZY_STORE_ID'],
    process.env as Record<string, string>,
    'Missing required environment variables: {keys}',
  );

  return createLemonSqueezy({
    apiKey: envVars.LEMONSQUEEZY_API_KEY,
    storeId: envVars.LEMONSQUEEZY_STORE_ID,
    webhookSecret: process.env.LEMONSQUEEZY_WEBHOOK_SECRET,
    isSandbox: process.env.NODE_ENV !== 'production',
  });
};

export { LemonSqueezyProvider, type LemonSqueezyOptions };