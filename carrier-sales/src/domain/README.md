# Domain boundary

Pure, deterministic state transitions, negotiation and booking policy belong here.
Do not import Next.js, React, MCP transport, Node I/O, server orchestration or
provider SDKs. Use contracts from ../contracts. No state machine or policy is
implemented in this scaffold; the approved specification must precede them.
