# SIWC auxiliary wire probe

Run this probe after installing the packed ChatGPT plugin in a profile and installing the matching public DSH packages in a consumer. It accepts DSH `0.2.0-rc.2` and `0.2.1-alpha.1`.

Set `DSH_CONSUMER_DIR` to the consumer directory and `DSH_PLUGIN_DIR` to the installed `@f12o/dsh-siwc` package directory, then run `auxiliary-wire-probe.mjs` with Node `^22.19.0 || >=24.0.0`. For example:

```sh
DSH_CONSUMER_DIR=/path/to/consumer \
DSH_PLUGIN_DIR=/path/to/profile/node_modules/@f12o/dsh-siwc \
node /path/to/plugin-checkout/packages/chatgpt/validation/auxiliary-wire-probe.mjs
```

When the plugin is installed directly in the consumer, `DSH_PLUGIN_DIR` may be omitted. Without `DSH_CONSUMER_DIR`, the current working directory is used as the consumer directory. The probe resolves both packages through their public exports; it does not import repository source files.

The fixture generates a local signing key, fake OAuth tokens, a local callback server, and a fake Responses SSE endpoint. Requests to the OpenAI hosts are redirected to that local fixture; any other external request is blocked. The probe needs no account, secret, or live API call. It checks the login host ID, title generation through the public title helper with a 64-token policy, compaction through `BasicCompactionEngine` with a 65,536-token policy, Responses tool calls and usage mapping, and rejection of an ordinary `maxTokens` request before HTTP.

Responses requests omit `max_output_tokens`. The policy values remain recorded by DSH and guide the title and compaction callers, but the provider cannot enforce those values as output ceilings when the Responses API request omits the cap.

## Recorded compatibility run

The current probe targets `@f12o/dsh-siwc`. The recorded v5 runs below used the preserved `@f4ah6o/dsh-chatgpt` tarball from before the package identity changed; that artifact and its historical results remain unchanged.

The validated v5 package has SHA-256 `66ed59d58fe7d241d2cfcfc777939a7a3d7d49710cdce4cbecc9dcee8ffeeb2d` and is preserved at `dist/f4ah6o-dsh-chatgpt-0.1.0.tgz`. The run completed on 2026-10-08 against published DSH `0.2.0-rc.2` and `0.2.1-alpha.1` installations and the `f4ah6o/deepseek-harness` fork.

Both published DSH versions passed the SDK Host probe, initialize/shutdown and disposal checks, a headless task against a local DeepSeek stub, the Web account-empty state with the generated Remote, `sdk-minimal` with matching public provider packages, and the preflight failure case with required providers disabled. Both versions passed the auxiliary wire probe described above, including the persisted `urn:uuid:` host ID, title and compaction invocation policies, Responses tool and usage mapping, and rejection of an ordinary output-cap request before HTTP. Logs are under `/tmp/dsh-chatgpt-compat-nan9yvg1/harness-v5-final/<version>/logs/` on the validation host.

The same v5 tarball passed the fork matrix: SDK initialize/shutdown, a headless task against a local DeepSeek stub, the Web account-empty state in the fork's Japanese default locale, `sdk-minimal`, and the disabled-provider failure case. Its auxiliary wire probe passed with the fork consumer and official DSH compatibility helper `0.2.1-alpha.1`. Logs are under `/tmp/dsh-chatgpt-compat-nan9yvg1/harness-P4gNBj/fork-main-v5/logs/`.

A real browser run used the v5 package in the official DSH `0.2.1-alpha.1` consumer's preserved local Web profile. With GPT-6-Luna at medium reasoning and no tools, the first request returned exactly `SIWC_OK` in 52 seconds and the second returned exactly `SIWC_SECOND_OK` in 4 seconds. The title helper produced the visible title `Reply Exactly SIWC_OK`; the composer showed **Using ChatGPT plan** and **Manage usage**. The screenshot records this two-turn run without account identifiers or credentials: [SIWC Web two-turn result](../../../validation/siwc-web-two-turn.jpg).

Using the same saved account grant without starting another OAuth flow, a headless profile returned exactly `SIWC_OK` and exited successfully with no tool events. The public `@deepseek-ai/dsh-sdk-client@0.2.1-alpha.1` SDK client also completed a GPT-6-Luna medium request with a final `SIWC_OK` and disposed its runtime; no tool events occurred.

The live inference checks cover two Web turns, one headless turn, and one public SDK turn on GPT-6-Luna medium without tool calls. They do not establish live behavior for every model, tool, plan limit, host platform, or remote-browser arrangement. The fixture probes use local OAuth and Responses fixtures; they do not authorize a ChatGPT account or make live requests. The compatibility headless task used a local DeepSeek stub, while the SDK Host checks cover initialization, shutdown, and disposal.

Local package checks passed: `pnpm test` reported 10 files and 75 tests passed, `pnpm run typecheck` passed for Host and Client, the package prepack build passed for Host and Client, and `git diff --check` passed. The official-version and fork auxiliary probe commands described above also exited successfully. This workspace has no lint script or linter configuration.
