# @paykit-sdk/lemonsqueezy

## 1.1.2

### Patch Changes

- afd9941: fix: derive deterministic webhook event ids from payload content instead of random uuids so retries dedupe correctly

## 1.1.1

### Patch Changes

- a9f7b4a: chore: expose the http client on API providers

## 1.1.0

### Minor Changes

- 860a134: Added complete LemonSqueezy provider implementation featuring strict JSON:API schema validation, HMAC-SHA256 webhook verification, and full support for Checkouts, Customers, Orders (Payments), Subscriptions, and Refunds.
