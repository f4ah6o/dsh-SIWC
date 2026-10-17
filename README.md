# dsh-SIWC

Sign in with ChatGPT on deepseek harness

The current source package is `@f12o/dsh-siwc@0.1.0-alpha.5`, with source and setup guidance in [`packages/chatgpt`](packages/chatgpt/README.md). Prereleases use the `alpha` dist-tag; the last published version is `0.1.0-alpha.4`, and `0.1.0-alpha.5` is not published yet. The preserved v5 artifact under the former identity `@f4ah6o/dsh-chatgpt@0.1.0` is historical only. This repository has no build-time dependency on a sibling DeepSeek Harness checkout.

The package declares compatibility with the DSH `0.2.0-rc.2`, `0.2.1-alpha.1` through `0.2.1-alpha.4`, and `0.2.1-rc.2` API lines and their corresponding Cordis runtimes. Its build uses the published Typert generator with the narrow pinned patch in [`patches`](patches); the package tests check the generated Host Remote contract and OAuth lifecycle, while `pnpm run build` also builds the lazy Client entry point.

Run `pnpm install`, `pnpm run build`, and `pnpm test` from this directory. Profile requirements, account setup, headless browser sign-in, and model configuration are in the [package README](packages/chatgpt/README.md). Release operators can follow the [npm publishing guide](PUBLISHING.md).

## Install from npm

After `0.1.0-alpha.5` is published to npm with the `alpha` dist-tag, install the exact prerelease into an initialized Desktop profile with Desktop's managed `dsh` command (fully quit Desktop first):

```sh
dsh plugin --profile desktop add @f12o/dsh-siwc@0.1.0-alpha.5
```

`0.1.0-alpha.5` is not published yet, so this command will not resolve until publication. The published `0.1.0-alpha.4` does not accept DSH `0.2.1-rc.2` in its compatibility range, so it is not a substitute for a current-DSH installation. Use Desktop's bundled CLI or Plugin Manager, not an npm-installed `dsh` command. If the profile has the former package installed, fully quit Desktop and remove it before installing the renamed package:

```sh
dsh plugin --profile desktop remove @f4ah6o/dsh-chatgpt
```

Do not keep both package names in one profile. The historical v5 artifact is [`@f4ah6o/dsh-chatgpt@0.1.0`](dist/f4ah6o-dsh-chatgpt-0.1.0.tgz), SHA-256 `66ed59d58fe7d241d2cfcfc777939a7a3d7d49710cdce4cbecc9dcee8ffeeb2d`; it is an ignored, untracked workspace file. The prior prepublication `0.1.0` candidate is [`@f12o/dsh-siwc@0.1.0`](dist/f12o-dsh-siwc-0.1.0.tgz), SHA-256 `15c16502dc658f752c5551b116d98dae286f32c69de3cc9e4d54a279ef1c4110`; its official and fork consumer matrix passed for that exact tarball. The current `0.1.0-alpha.5` candidate is [`@f12o/dsh-siwc@0.1.0-alpha.5`](dist/f12o-dsh-siwc-0.1.0-alpha.5.tgz), SHA-256 `7425bc6ed094e2c9e560b9d9700bb204271f7e37fd2a126bfa9c2df08ea10039`; it is an ignored, untracked workspace file. Its packed artifact passed the build, typecheck, and 75-test suite, the auxiliary wire probe against published DSH `0.2.1-rc.2` packages, and an installed Web smoke on the current `0.2.1-rc.2` runtime, where the Host Remote loaded and the ChatGPT settings section rendered the empty-account state. No live ChatGPT inference was performed for this candidate. The earlier [`@f12o/dsh-siwc@0.1.0-alpha.1`](dist/f12o-dsh-siwc-0.1.0-alpha.1.tgz) tarball, SHA-256 `3c5f83e28a590c804245d05791b5cbead7fbbcc400649ed861bf775c02524a02`, remains historical. The [alpha artifact comparison](validation/alpha-artifact-proof.json) records that the alpha.1 and `0.1.0` tarballs differ in the three package READMEs, the version-only manifest change, and generated CSS-map property ordering in `lib/client.js`; the CSS maps have the same key/value pairs. Desktop acceptance remains pending. A Windows Desktop attempt with official DSH `0.2.0-rc.2` failed after plugin installation because `ctx.connection` was missing when Desktop read `authenticatedUrl`; the underlying composition cause is unresolved. See the [verification report](validation/fork-verification.md) and [installed-Desktop checklist](validation/desktop-verification.md).

## Validation artifacts

- [Japanese package setup](packages/chatgpt/README.ja.md)
- Prior prepublication candidate: [`@f12o/dsh-siwc@0.1.0`](dist/f12o-dsh-siwc-0.1.0.tgz), ignored and untracked; its SHA-256 is `15c16502dc658f752c5551b116d98dae286f32c69de3cc9e4d54a279ef1c4110`.
- Current alpha candidate: [`@f12o/dsh-siwc@0.1.0-alpha.5`](dist/f12o-dsh-siwc-0.1.0-alpha.5.tgz), SHA-256 `7425bc6ed094e2c9e560b9d9700bb204271f7e37fd2a126bfa9c2df08ea10039`; build, typecheck, 75 tests, the auxiliary wire probe, and an installed Web smoke passed on DSH `0.2.1-rc.2`. npm publication with the `alpha` dist-tag is pending.
- Historical alpha tarball: [`@f12o/dsh-siwc@0.1.0-alpha.1`](dist/f12o-dsh-siwc-0.1.0-alpha.1.tgz), SHA-256 `3c5f83e28a590c804245d05791b5cbead7fbbcc400649ed861bf775c02524a02`; its earlier CLI/SDK/Web smoke matrix passed on official DSH `0.2.0-rc.2`, official `0.2.1-alpha.1`, and the then-current fork.
- [Alpha artifact comparison](validation/alpha-artifact-proof.json) — content comparison of the alpha.1 and prior `0.1.0` tarballs.
- Historical v5 tarball: [`@f4ah6o/dsh-chatgpt@0.1.0`](dist/f4ah6o-dsh-chatgpt-0.1.0.tgz), ignored and untracked; it may be absent in a fresh clone and is not the current package identity.
- [Fork verification report](validation/fork-verification.md)
- [Pending installed-Desktop verification checklist](validation/desktop-verification.md)
