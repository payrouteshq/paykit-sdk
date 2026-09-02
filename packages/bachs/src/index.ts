import { validateRequiredKeys } from '@paykit-sdk/core';
import { BachsOptions, BachsProvider } from './bachs-provider';

export const createBachs = (config: BachsOptions) => {
  return new BachsProvider(config);
};

export const bachs = () => {
  const envVars = validateRequiredKeys(
    ['BACHS_API_KEY'],
    process.env as Record<string, string>,
    'Missing required environment variables: {keys}',
  );

  const apiKey = envVars.BACHS_API_KEY;
  const isSandbox = apiKey.includes('sandbox');

  return createBachs({ apiKey, isSandbox });
};

export { BachsProvider, type BachsOptions };

export * from './schema';
