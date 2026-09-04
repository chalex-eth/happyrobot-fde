# FMCSA adapter — not implemented

FmcsaClient will wrap native fetch with deadlines, validated responses and safe
error mapping. Fail closed if authority cannot be established. Never log full
URLs containing webKey. No seeded carrier fallback.
