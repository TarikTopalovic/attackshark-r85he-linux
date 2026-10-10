# Contributing

## Setup

```bash
bun install
bun run build
bun run typecheck
```

## Development Rules

- Keep protocol behavior changes small and trace-backed.
- For compatibility changes, attach before/after evidence from `.db` traces.
- Do not commit generated artifacts (`dist`, `.db`, `node_modules`).

## PR Checklist

- `bun run ci` passes.
- Behavior changes are documented in `README.md` and/or `CHANGELOG.md`.
- New RPC behavior is validated against live traffic or conformance script output.

