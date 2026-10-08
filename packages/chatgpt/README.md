# `@f4ah6o/dsh-chatgpt`

ChatGPT subscription inference for DeepSeek Harness through OpenAI's Sign in with ChatGPT flow. The package keeps OAuth credentials in the Host Credentials service and exposes only redacted account state to the Client.

Install the bundle in each profile that should provide ChatGPT inference:

```sh
dsh plugin --profile web add @f4ah6o/dsh-chatgpt
dsh plugin --profile headless add @f4ah6o/dsh-chatgpt
```

The Host requires DSH's Credentials store and Authorization service. Standard Web, Desktop, headless, and `sdk` profiles that layer `dsh-base` include both. The standalone `sdk-minimal` profile includes neither; add both services before `@f4ah6o/dsh-chatgpt` in that profile:

```yaml
- insert:
    - id: credentials
      name: '@deepseek-ai/dsh-credentials-local'
    - id: authorization
      name: '@deepseek-ai/dsh-authorization'
```

A profile without these services fails at plugin load instead of leaving sign-in unavailable at runtime.

Web and Desktop users can sign in from ChatGPT account settings. To sign in from a CLI-only profile, opt into a local browser flow for that invocation with a profile patch:

```sh
cat > /tmp/chatgpt-headless-login.patch.yml <<'YAML'
- id: chatgpt
  config:
    authorizeOnStart: true
YAML

dsh --profile headless --patch /tmp/chatgpt-headless-login.patch.yml "List the models available to my ChatGPT account"
```

The command prints a loopback authorization URL and waits for the callback. Open the URL in a browser on the same PC. The account grant is saved in the profile Credentials store; later headless and SDK requests use it without opening a browser. `authorizeOnStart` defaults to `false`.

## Web and Desktop settings

Open **Settings → ChatGPT** to add an account, reconnect an account that needs sign-in, choose the active account, or remove a saved account. The first successful connection shows a welcome message once and links to ChatGPT usage settings. Removing an account deletes its local sign-in; the Client reports when OpenAI does not confirm token revocation.

The model list shows the account's full available catalog. Models without a configured context window remain unavailable until you enter a positive token limit. You can also adjust input modalities and reasoning efforts for a model, or restore its official defaults. Capability settings are saved in the current profile.

The composer shows when the selected provider is using a ChatGPT plan. After a ChatGPT plan usage-limit error, it offers **Manage usage** as the primary action. Both links open [ChatGPT usage settings](https://chatgpt.com/settings/usage).

The provider only selects models with known context metadata. Configure `modelOverrides` for a new model or a capability that differs for your SIWC account; each row is keyed by the exact model slug and may set `contextWindow`, `inputModalities`, `reasoningEfforts`, and `defaultReasoningEffort`.

The package publishes separate Host, Remote, and lazy Client entry points. Its supported DSH compatibility is limited to the explicitly tested `0.2.0-rc.2` and `0.2.1-alpha.1` API lines; install a matching DSH release and Cordis runtime.
