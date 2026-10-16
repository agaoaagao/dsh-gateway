# Contributing to dsh-gateway

Thanks for your interest! Contributions are welcome — bug reports, bug fixes,
documentation, and small features.

## Reporting issues

- Search [existing issues](https://github.com/agaoaagao/dsh-gateway/issues)
  first.
- For bugs, use the bug report template and include: gateway version (or commit),
  Node version, OS, how you run it (Docker / bare Node), and the minimal steps
  plus logs to reproduce.
- For security issues, do **not** open a public issue — see
  [SECURITY.md](SECURITY.md).

## Development setup

```sh
git clone https://github.com/agaoaagao/dsh-gateway
cd dsh-gateway
node test-gateway.mjs   # 74 checks, runs against a fake dsh — no dsh needed
node test-spawn.mjs     # 70 checks, needs a real dsh installation
```

Requirements: Node ≥ 18. There are no dependencies and no build step — the
gateway is Node's standard library only.

## Ground rules

- **No new dependencies.** The zero-dependency property is a feature.
- **Keep dsh implementation details out of the README.** The README documents
  observable behaviour, not dsh internals (RPC method names, internal file
  layouts, unpublished identifiers). Deeper material belongs in
  [docs/DESIGN.md](docs/DESIGN.md).
- **Keep both docs in sync.** README.md (English) is the default;
  docs/README.zh-CN.md is the Chinese translation. Changes to one must be
  mirrored in the other.
- **Every bug fix or behaviour change comes with a test** in
  `test-gateway.mjs` or `test-spawn.mjs`.
- Line endings are LF (`* text eol=lf` in `.gitattributes`); the files are
  UTF-8 without BOM.

## Pull requests

1. Fork, create a branch from `master`.
2. Make your change with tests.
3. Run both test suites and make sure they pass.
4. Open a PR describing what changed and why. Keep one logical change per PR.
