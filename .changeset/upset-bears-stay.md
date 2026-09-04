---
'@paykit-sdk/lemonsqueezy': patch
'@paykit-sdk/mercadopago': patch
'@paykit-sdk/paystack': patch
'@paykit-sdk/razorpay': patch
'@paykit-sdk/comgate': patch
'@paykit-sdk/monnify': patch
'@paykit-sdk/core': patch
'@paykit-sdk/redsys': patch
'@paykit-sdk/remita': patch
'@paykit-sdk/xendit': patch
'@paykit-sdk/bachs': patch
'@paykit-sdk/chapa': patch
'@paykit-sdk/gopay': patch
---

fix: derive deterministic webhook event ids from payload content instead of random uuids so retries dedupe correctly
