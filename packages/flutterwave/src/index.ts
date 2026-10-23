import { validateRequiredKeys } from '@paykit-sdk/core';
import {
  FlutterwaveOptions,
  FlutterwaveProvider,
} from './v4/flutterwave-provider';

export const createFlutterwave = (config: FlutterwaveOptions) => {
  return new FlutterwaveProvider(config);
};

export const flutterwave = () => {
  const envVars = validateRequiredKeys(
    ['FLUTTERWAVE_CLIENT_ID', 'FLUTTERWAVE_CLIENT_SECRET'],
    process.env as Record<string, string>,
    'Missing required environment variables: {keys}',
  );

  return createFlutterwave({
    clientId: envVars.FLUTTERWAVE_CLIENT_ID,
    clientSecret: envVars.FLUTTERWAVE_CLIENT_SECRET,
    isSandbox: process.env.FLUTTERWAVE_SANDBOX !== 'false',
  });
};

export { FlutterwaveProvider, type FlutterwaveOptions };

export * from './v4/schema';
