import { createCipheriv } from 'crypto';

/**
 * Flutterwave v3 only accepts card details encrypted with 3DES: ECB
 * mode, PKCS#7 padding and the 24-character encryption key from the
 * dashboard, then base64 encoded and sent as `{ client }`.
 */
export const encryptV3Payload = (
  payload: Record<string, unknown>,
  encryptionKey: string,
): string => {
  const cipher = createCipheriv('des-ede3', encryptionKey, null);

  return Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]).toString('base64');
};
