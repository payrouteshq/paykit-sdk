import { validateRequiredKeys } from '@paykit-sdk/core';
import {
  FlutterwaveV3Options,
  FlutterwaveV3Provider,
} from './v3/flutterwave-v3-provider';
import {
  FlutterwaveOptions,
  FlutterwaveProvider,
} from './v4/flutterwave-provider';

export type FlutterwaveV4Config = FlutterwaveOptions & {
  apiVersion?: 'v4';
};

export type FlutterwaveV3Config = FlutterwaveV3Options & {
  apiVersion: 'v3';
};

export type FlutterwaveConfig =
  | FlutterwaveV3Config
  | FlutterwaveV4Config;

/**
 * Picks the API generation: pass `apiVersion: 'v3'` with a `secretKey`
 * (and `encryptionKey` for cards), or leave it out for v4 with an OAuth
 * `clientId` and `clientSecret`.
 */
export function createFlutterwave(
  config: FlutterwaveV3Config,
): FlutterwaveV3Provider;
export function createFlutterwave(
  config: FlutterwaveV4Config,
): FlutterwaveProvider;
export function createFlutterwave(
  config: FlutterwaveConfig,
): FlutterwaveV3Provider | FlutterwaveProvider {
  return config.apiVersion === 'v3'
    ? new FlutterwaveV3Provider(config)
    : new FlutterwaveProvider(config);
}

/**
 * Builds the provider from the environment. `FLUTTERWAVE_API_VERSION`
 * (`v3` or `v4`) picks the API, and is inferred from which credentials
 * are set when absent.
 */
export const flutterwave = () => {
  const env = process.env as Record<string, string>;
  const isSandbox = env.FLUTTERWAVE_SANDBOX !== 'false';
  const version =
    env.FLUTTERWAVE_API_VERSION ??
    (env.FLUTTERWAVE_SECRET_KEY ? 'v3' : 'v4');

  if (version === 'v3') {
    const envVars = validateRequiredKeys(
      ['FLUTTERWAVE_SECRET_KEY'],
      env,
      'Missing required environment variables: {keys}',
    );

    return createFlutterwave({
      apiVersion: 'v3',
      secretKey: envVars.FLUTTERWAVE_SECRET_KEY,
      encryptionKey: env.FLUTTERWAVE_ENCRYPTION_KEY,
      isSandbox,
    });
  }

  const envVars = validateRequiredKeys(
    ['FLUTTERWAVE_CLIENT_ID', 'FLUTTERWAVE_CLIENT_SECRET'],
    env,
    'Missing required environment variables: {keys}',
  );

  return createFlutterwave({
    clientId: envVars.FLUTTERWAVE_CLIENT_ID,
    clientSecret: envVars.FLUTTERWAVE_CLIENT_SECRET,
    isSandbox,
  });
};

export {
  FlutterwaveProvider,
  FlutterwaveV3Provider,
  type FlutterwaveOptions,
  type FlutterwaveV3Options,
};

export * from './v4/schema';
export * from './v3/schema';
