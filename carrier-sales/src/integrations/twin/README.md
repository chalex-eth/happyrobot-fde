# Twin adapter — not implemented

Define TwinRepository after checking the actual API and consistency primitives.
Validate request/response data with Zod. Verify conditional updates, operation
deduplication, booking-intent uniqueness and terminal-state protection before
building mutation flows. No in-memory persistence fallback or external database.
