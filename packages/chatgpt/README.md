---
description: "Add local ChatGPT subscription inference and account controls to DeepSeek Harness profiles."
kind: "package-bundle"
---

# `@f4ah6o/dsh-chatgpt`

English | [日本語](README.ja.md) | [中文](README.zh.md)

## Summary

Add ChatGPT subscription models to a DeepSeek Harness profile without a separate API key. Sign in through OpenAI in a browser on the same PC; the Host keeps account grants in the DSH Credentials store, while Web and Desktop show redacted account controls. Base-backed profiles already provide the required services. This package is currently installed from a locally packed tarball.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations](#known-limitations)

-----

<a id="use-this-package"></a>
## Use this package

### Pack and install

From a built plugin checkout, create a tarball and add it to a profile. The commands below were tested with the DSH source CLI and an isolated profile home.

```sh
pnpm --dir packages/chatgpt pack
dsh plugin --profile web add /path/to/deepseek-harness-plugin/packages/chatgpt/f4ah6o-dsh-chatgpt-0.1.0.tgz
dsh plugin --profile headless add /path/to/deepseek-harness-plugin/packages/chatgpt/f4ah6o-dsh-chatgpt-0.1.0.tgz
```

The bundle inserts the ChatGPT plugin row. Remove it with `dsh plugin --profile web remove @f4ah6o/dsh-chatgpt`. The package has not been published to npm yet. Its Host APIs were tested with DSH `0.2.0-rc.2` and `0.2.1-alpha.1`; other DSH API versions are not covered.

The Host needs DSH Credentials, Authorization, and LLM services. The shipped `web`, `desktop`, `headless`, and `sdk` profiles include them through `dsh-base`. The bundle also inserts a startup check. When the DSH launcher signals readiness, the check reports missing services for an enabled ChatGPT Host row and aborts startup; it skips a disabled or deleted Host row. The standalone `sdk-minimal` profile omits Credentials and Authorization. Add matching provider packages to that profile, then add their rows to its `cordis.patch.yml`:

```sh
pnpm --dir "${DSH_HOME:-$HOME/.dsh}/profiles/sdk-minimal" add @deepseek-ai/dsh-authorization@0.2.0-rc.2 @deepseek-ai/dsh-credentials-local@0.2.0-rc.2
```

Use `0.2.1-alpha.1` for both packages when the DSH installation is `0.2.1-alpha.1`; do not mix the two DSH API lines. Add these rows after installing the ChatGPT bundle:

```yaml
- insert:
    - id: authorization
      name: '@deepseek-ai/dsh-authorization'
    - id: credentials
      name: '@deepseek-ai/dsh-credentials-local'
```

The bundle does not replace provider rows in base-backed profiles.

### Sign in on the local machine

Web and Desktop users can open **Settings → ChatGPT**, add one or more accounts, and choose which account the profile uses. The OAuth callback listens only on loopback at `127.0.0.1`; complete sign-in in a browser on the same PC. Remote-hosted browsers and cloud sign-in are unsupported. The Host persists a stable `urn:uuid:` identifier and reuses it for sign-in. The flow uses OpenAI’s [Sign in with ChatGPT registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and does not require a Codex CLI installation.

The OAuth request asks for `openid`, `profile`, `email`, `offline_access`, `resource.invoke`, and `chatgpt.tokens.use.direct`. If a new registration verifies the ChatGPT identity but does not grant every required permission or a renewable token, the Host retains only its issued client ID and verified subject/email as `needs-sign-in`; it stores no token and does not expose models. An incomplete reauthorization leaves the previous connected grant intact. Registrations are distinct by issued client ID and verified subject, not by email.

For a CLI-only run, set `authorizeOnStart` in an invocation overlay. The profile prints a one-time URL and waits for the local loopback callback before continuing:

```sh
cat > /tmp/chatgpt-login.patch.yml <<'YAML'
- id: chatgpt
  config:
    authorizeOnStart: true
YAML

dsh --profile headless --patch /tmp/chatgpt-login.patch.yml "Run a ChatGPT-backed task"
```

This option defaults to `false`. Use it only for a local invocation that needs ChatGPT; it starts sign-in whenever no connected ChatGPT account exists. Install this bundle in each profile that will use the provider. After sign-in, profiles with the same DSH home can reuse the grant from headless and SDK requests without another browser flow. A profile that has multiple connected accounts must have an explicit `activeAccountId`; the provider does not choose the first account silently.

Account records and the stable Host ID live in `$DSH_HOME/.credentials.yaml`. Profiles using the same `$DSH_HOME` share those records, so signing out removes the saved tokens for every such profile. Sign-out requests token revocation and then clears local access, refresh, and ID tokens; it retains the issued client ID and verified subject in `needs-sign-in` so the public Authorization flow can reconnect that registration after restart. The Client and session log never receive token values.

### Choose models and capabilities

The settings page displays every catalog entry OpenAI marks `visibility: "list"`, using its exact `slug` and `display_name`. The provider only advertises models with a known context window. It seeds these seven exact model slugs from the linked official API documentation: [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol), [GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna), [GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra), [GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol), [GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol), [GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra), and [GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna). Each page currently documents a 1,050,000-token context window, 128,000-token maximum output, text and image input, and text output. The maximum output is catalog metadata only; the adapter does not send it as an output cap.

Five non-Astra models—GPT-6 Sol, GPT-6 Luna, GPT-5.6 Sol, GPT-5.6 Terra, and GPT-5.6 Luna—list `none`, `low`, `medium`, `high`, `xhigh`, and `max` reasoning efforts, with `medium` as the default. GPT-6.1 Sol lists `low`, `medium`, `high`, `xhigh`, and `max`, with `medium` as the default. Astra lists the same five efforts, but its page does not state a default. [OpenAI’s reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) confirms the `medium` defaults for GPT-6 Sol and Luna. Model documentation can change; the seven rows are an initial metadata set, not an availability promise.

Use `modelOverrides` in profile config for an unknown exact catalog slug or an SIWC capability difference. Each row can set `contextWindow`, `inputModalities`, `reasoningEfforts`, and `defaultReasoningEffort`:

```yaml
- id: chatgpt
  name: '@f4ah6o/dsh-chatgpt'
  config:
    modelOverrides:
      - model: exact-catalog-slug
        contextWindow: 1000000
        inputModalities: [text, image]
        reasoningEfforts: [low, medium, high]
        defaultReasoningEffort: medium
```

The settings page can write these overrides to the profile. Unknown models without a positive `contextWindow` remain visible in account settings but cannot be selected for inference.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation details — click to expand</summary>

The bundle mounts a Host OAuth/account service, a profile-startup check, a typed Remote namespace, and a lazy Client factory. The Host owns loopback callbacks, dynamic registration identity, serialized token refresh, model catalog admission, and the OpenAI Responses adapter. The check uses the DSH launcher's readiness signal and public Loader entries to validate only an enabled ChatGPT Host row. Remote values contain account status, catalog metadata, and sanitized login progress only. A request pins one account, access token, model configuration, and timeout before it enters the Responses stream.

OpenAI receives the current request’s instructions, conversation messages, image inputs, and function schemas. Requests use `store: false` and stream the full conversation. The package does not upload Session export files; model inference still sends the current request contents to OpenAI and is separate from DSH's session-log upload setting.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [OpenAI SIWC sign-in](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) — dynamic client registration, browser authorization, and callbacks.
- [OpenAI SIWC models and inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) — catalog and Responses requests.
- [OpenAI SIWC limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) — preview-only API restrictions.

-----

<a id="model-experience"></a>
## Model Experience

### ChatGPT subscription request

#### What the model sees

The adapter sends the system instructions as the Responses `instructions` field, maps the complete DSH message history into Responses input, includes selected image bytes, and supplies function definitions through the supported `additional_tools` developer item. OpenAI receives these request contents for inference.

#### Token effect

Conversation history, image inputs, function schemas, and tool results contribute to each request. The seeded context window is 1,050,000 tokens. DSH `maxTokens` options are rejected for ordinary generation, as are `temperature` and `stop`; session-title and compaction calls omit `max_output_tokens`, so the DSH title limit of 64 and compaction limit of 65,536 are not guaranteed by this adapter.

#### KV Cache effect

OpenAI receives the full request history on each call; the adapter does not send `previous_response_id`. Responses use `store: false`, so the adapter retains the completed response items locally in the DSH request state for replay.

## Known Limitations

- **Local browser required for sign-in** — the OAuth redirect must reach a callback on the same PC. Saved grants can serve later local headless and SDK requests.
- **Responses API parameters are restricted** — ordinary `maxTokens`, `temperature`, and `stop` are unsupported. Auxiliary title and compaction output caps are omitted, not enforced.
- **Model metadata can lag OpenAI’s catalog** — new slugs need a positive `contextWindow` override before the provider exposes them to inference. The account catalog still controls availability and order.
- **Plan limits are account-owned** — when OpenAI rejects inference at the plan limit, use the **Manage usage** action to open [ChatGPT usage settings](https://chatgpt.com/settings/usage).
- **Same-home sign-out is shared** — profiles using one `$DSH_HOME` share account grants; signing out in one removes the saved tokens for all of them.
