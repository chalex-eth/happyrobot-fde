<!-- BEGIN:nextjs-agent-rules -->

# This is NOT the Next.js you know

This version has breaking changes — APIs, conventions, and file structure may all differ from your training data. Read the relevant guide in `node_modules/next/dist/docs/` (resolved from this file's directory; in monorepos the `next` package may not be visible from the repo root) before writing any code. Heed deprecation notices.

This block is written and re-added by `next dev` — verify at `node_modules/next/dist/server/lib/generate-agent-files.js`. Removing it from a diff only re-creates the uncommitted change; committing it with your work keeps the tree clean.

<!-- END:nextjs-agent-rules -->

## HappyRobot integration

Before changing or troubleshooting the HappyRobot integration, workflow prompts, MCP tools, or test scripts, read [the agent runbook](docs/happyrobot-agent-runbook.md). It explains the code structure, tool sequencing, draft updates, test commands, and development rollout procedure.

Treat its dated rollout snapshot as historical context. Check current source, configuration, and remote state before using version IDs or publishing. Keep the runbook current when changing these procedures.
