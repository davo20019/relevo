# Contributing

## Local Setup

```bash
npm install
npm run build
npm test
```

Use `npm run dev` while working on the Ink UI. The CLI uses the current working
directory as the shared workspace for all configured agents.

## Config And State

- User config lives at `~/.config/relevo/agents.json` by default.
- A project-local `./agents.json` overrides the user config when present.
- `RELEVO_CONFIG=/path/to/agents.json` can point at an explicit config file.
- Runtime state is stored in `./.relay/`; do not commit it.

## Tests

Tests live in `tests/` and run with Vitest:

```bash
npm test
```

Run `npm run build` before CLI contract changes, because those tests execute the
compiled `dist/cli.js` entrypoint.

## Good First Issues

Good starter changes are usually bounded and testable:

- add or update an agent command template in the default config
- improve parser coverage for a supported CLI
- add tests around routing, autocomplete, or config behavior
- improve docs for an existing command or workflow

Keep changes focused. If a change touches agent execution, routing, or session
resume behavior, include a regression test.
