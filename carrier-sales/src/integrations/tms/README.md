# Legacy TMS adapter — not implemented

Keep TmsEncoder, TmsTransport (node:net), TmsParser and TmsClient separate.
Read the authoritative handbook before defining frames or field schemas.
Allow one bounded retry for eligible reads. LOAD_BOOK is sent once, only after
a durable Twin intent; incomplete results are uncertain, never automatically
retried. Fakes belong under tests/support, not in runtime code.
