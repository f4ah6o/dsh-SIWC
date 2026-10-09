# dsh-SIWC

Sign in with ChatGPT on deepseek harness

This repository builds the standalone `@f4ah6o/dsh-chatgpt` package from [`packages/chatgpt`](packages/chatgpt/README.md). It has no build-time dependency on a sibling DeepSeek Harness checkout.

The package declares compatibility with the DSH `0.2.0-rc.2` and `0.2.1-alpha.1` API lines and their corresponding Cordis runtimes. Its build uses the published Typert generator with the narrow pinned patch in [`patches`](patches); the package tests check the generated Host Remote contract and OAuth lifecycle, while `pnpm run build` also builds the lazy Client entry point.

Run `pnpm install`, `pnpm run build`, and `pnpm test` from this directory. Profile requirements, account setup, headless browser sign-in, and model configuration are in the [package README](packages/chatgpt/README.md).

## Validation artifacts

- [Japanese package setup](packages/chatgpt/README.ja.md)
- [Preserved v5 package tarball](dist/f4ah6o-dsh-chatgpt-0.1.0.tgz) — ignored, untracked artifact available only in this workspace; it is not published on npm and may be absent in a fresh clone.
- [Fork verification report](validation/fork-verification.md)
- [Pending installed-Desktop verification checklist](validation/desktop-verification.md)
