# DeepSeek Harness ChatGPT plugin

This repository builds the standalone `@f4ah6o/dsh-chatgpt` package from [`packages/chatgpt`](packages/chatgpt/README.md). It has no build-time dependency on a sibling DeepSeek Harness checkout.

The package declares compatibility with the DSH `0.2.0-rc.2` and `0.2.1-alpha.1` API lines and their corresponding Cordis runtimes. Its build uses the published Typert generator with the narrow pinned patch in [`patches`](patches); the package tests check the generated Host Remote contract and OAuth lifecycle, while `pnpm run build` also builds the lazy Client entry point.

Run `pnpm install`, `pnpm run build`, and `pnpm test` from this directory. Profile requirements, account setup, headless browser sign-in, and model configuration are in the [package README](packages/chatgpt/README.md).
