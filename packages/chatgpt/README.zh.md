---
description: "为 DeepSeek Harness profile 添加 ChatGPT 订阅推理和账号管理。"
kind: "package-bundle"
---

# `@f12o/dsh-siwc`

[English](README.md) | [日本語](README.ja.md) | 中文

## 概述

无需单独的 API key，即可在 DeepSeek Harness profile 中使用 ChatGPT 订阅模型。请在同一台电脑上的浏览器中登录 OpenAI；Host 将账号 grant 保存在 DSH Credentials 存储中，Web 和 Desktop 只显示脱敏的账号信息。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步阅读](#further-exploration)
- [模型体验](#model-experience)
- [已知限制](#known-limitations)

-----

<a id="use-this-package"></a>
## 使用本包

### 从 npm 安装

npm 发布预发布版 `0.1.0-alpha.2` 后，在每个需要使用 ChatGPT 的 profile 中添加 bundle：

```sh
dsh plugin --profile web add @f12o/dsh-siwc@0.1.0-alpha.2
dsh plugin --profile headless add @f12o/dsh-siwc@0.1.0-alpha.2
dsh plugin --profile desktop add @f12o/dsh-siwc@0.1.0-alpha.2
```

通过 Desktop CLI 安装时，先启动应用一次以创建 profile，然后在执行 package 命令前彻底退出应用。请使用该 release 自带的 `dsh` CLI，不要使用 `PATH` 中的其他 `dsh`。当前 fork 将 CLI 放在 `resources/runtime/cli/bin/dsh`（Windows 为 `dsh.cmd`），请确认已安装 release 的实际路径。创建 profile 后，也可以使用 Desktop 自带的 Plugin Manager 安装。通过 CLI 操作 package 后再重新打开 Desktop。

如果 profile 已安装旧 package `@f4ah6o/dsh-chatgpt`，请先从同一 profile 移除旧 package，再添加新 package：

```sh
dsh plugin --profile <profile> remove @f4ah6o/dsh-chatgpt
dsh plugin --profile <profile> add @f12o/dsh-siwc@0.1.0-alpha.2
```

旧 package 和新 package 使用相同的 provider identity、Remote namespace 和 credential ID。保留相同的 `$DSH_HOME` 即可保留 Credentials store；有效的已保存 grant 无需重新登录即可使用，但过期或已撤销的 grant 可能需要重新登录。Desktop 中的两条命令都要在应用退出时通过其自带 CLI 执行。

### 从本地 Pack 安装

从 checkout 安装时，可 Pack standalone plugin 并将 tarball 添加到 profile：

```sh
pnpm --dir packages/chatgpt pack
dsh plugin --profile web add /path/to/deepseek-harness-plugin/packages/chatgpt/f12o-dsh-siwc-0.1.0-alpha.2.tgz
dsh plugin --profile headless add /path/to/deepseek-harness-plugin/packages/chatgpt/f12o-dsh-siwc-0.1.0-alpha.2.tgz
dsh plugin --profile desktop add /path/to/deepseek-harness-plugin/packages/chatgpt/f12o-dsh-siwc-0.1.0-alpha.2.tgz
```

bundle 会添加 ChatGPT plugin 配置项。运行 `dsh plugin --profile <profile> remove @f12o/dsh-siwc` 可移除该项。已验证的 DSH Host API 版本为 `0.2.0-rc.2` 和 `0.2.1-alpha.1`。

Host 需要 DSH Credentials、Authorization 和 LLM 服务。随附的 `web`、`desktop`、`headless`、`sdk` profile 通过 `dsh-base` 提供这些服务。bundle 还会添加启动检查。DSH launcher 发出 readiness 信号时，检查会报告启用的 ChatGPT Host entry 缺少哪些服务并中止启动；如果 Host entry 已禁用或删除，则跳过检查。独立的 `sdk-minimal` profile 不包含 Credentials 和 Authorization。请在该 profile 中安装与 DSH 版本匹配的 provider package，并在其 `cordis.patch.yml` 中添加对应 entry：

```sh
pnpm --dir "${DSH_HOME:-$HOME/.dsh}/profiles/sdk-minimal" add @deepseek-ai/dsh-authorization@0.2.0-rc.2 @deepseek-ai/dsh-credentials-local@0.2.0-rc.2
```

若 DSH 版本为 `0.2.1-alpha.1`，两个 package 都使用 `0.2.1-alpha.1`；请勿混用两条 DSH API 版本线。安装 ChatGPT bundle 后，添加以下 entry：

```yaml
- insert:
    - id: authorization
      name: '@deepseek-ai/dsh-authorization'
    - id: credentials
      name: '@deepseek-ai/dsh-credentials-local'
```

bundle 不会替换 base-backed profile 中的 provider entry。

### 在本机登录

Web 和 Desktop 用户可在 **Settings → ChatGPT** 添加账号，并选择该 profile 使用的账号。OAuth callback 只监听 `127.0.0.1`，请在同一台电脑上的浏览器完成登录。不支持远程主机浏览器或云端登录。Host 会保存稳定的 `urn:uuid:` 标识，并在每次登录时重用。此流程使用 OpenAI 的 [Sign in with ChatGPT 动态注册](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)，不依赖 Codex CLI。

OAuth 请求以下权限：`openid`、`profile`、`email`、`offline_access`、`resource.invoke` 和 `chatgpt.tokens.use.direct`。新注册即使验证了 ChatGPT 身份，如果缺少任何必需权限或可续期 token，Host 也只会以 `needs-sign-in` 保存已签发的 client ID 和已验证的 subject/email。它不会保存 token，也不会提供模型。不完整的重新授权不会替换旧的已连接 grant。注册按已签发的 client ID 和已验证 subject 区分，而不是按 email 区分。

仅使用 CLI 时，可在本次启动的 overlay 中设置 `authorizeOnStart`。profile 会显示一次性 URL，并等待本机 loopback callback 完成后再继续：

```sh
cat > /tmp/chatgpt-login.patch.yml <<'YAML'
- id: chatgpt
  config:
    authorizeOnStart: true
YAML

dsh --profile headless --patch /tmp/chatgpt-login.patch.yml "运行一个使用 ChatGPT 的任务"
```

默认值为 `false`。仅对需要 ChatGPT 的本地运行启用此选项；只要没有已连接的 ChatGPT 账号，它就会启动登录。每个要使用 provider 的 profile 都需要安装本 bundle。登录后，同一 DSH home 中的 profile 可复用该 grant。如果 profile 有多个已连接账号，必须明确设置 `activeAccountId`，provider 不会静默选择第一个账号。

账号记录和稳定 Host ID 保存在 `$DSH_HOME/.credentials.yaml`。使用同一 `$DSH_HOME` 的 profile 共享这些记录，因此在任一 profile 登出都会清除所有这些 profile 的本地 token。登出会请求撤销 token，然后删除本地 access、refresh 和 ID token；它保留已签发的 client ID 和已验证 subject，并标记为 `needs-sign-in`，以便重启后通过公开 Authorization flow 重新连接。Client 和 Session log 不会收到 token 值。

### 选择模型和能力

设置页面展示 OpenAI 标记为 `visibility: "list"` 的所有目录模型，并保留精确的 `slug` 和 `display_name`。Provider 只会公布已知 context window 的模型。初始元数据覆盖官方文档中的七个精确 slug：[GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)、[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)、[GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)、[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna)。每个页面目前都列出 1,050,000 token context、128,000 token 最大输出、text/image 输入和 text 输出。最大输出仅作为目录元数据；adapter 不会将其作为输出上限发送。

GPT-6 Sol、GPT-6 Luna、GPT-5.6 Sol、GPT-5.6 Terra 和 GPT-5.6 Luna 这五个模型支持 `none`、`low`、`medium`、`high`、`xhigh`、`max`，默认值为 `medium`。GPT-6.1 Sol 支持 `low`、`medium`、`high`、`xhigh`、`max`，默认值为 `medium`。Astra 也支持这五种 effort，但官方页面没有列出默认值。[OpenAI reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) 确认 GPT-6 Sol 和 Luna 的 `medium` 默认值。官方模型文档可能变化；这七个条目只是初始元数据，并不保证账号一定能使用它们。

如果账号 catalog 出现新 slug 或 SIWC 能力不同，请在 profile 的 `modelOverrides` 中配置。每项可以设置 `contextWindow`、`inputModalities`、`reasoningEfforts` 和 `defaultReasoningEffort`。设置页面也可将覆盖值写入 profile。未知模型在设置页可见，但必须配置正数 `contextWindow` 后才能用于推理。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

bundle 会加载 Host OAuth/账号服务、profile 启动检查、类型化 Remote namespace 和延迟加载的 Client factory。启动检查使用 DSH launcher readiness 信号和公开 Loader entry，只验证启用的 ChatGPT Host entry。Host 管理 loopback callback、动态注册身份、串行 token 刷新、模型 catalog 准入和 OpenAI Responses adapter。Remote 只传递账号状态、catalog 元数据和脱敏后的登录进度。每个请求在开始时固定账号、access token、模型配置和超时。

OpenAI 会收到当前推理请求的 instructions、对话消息、图片输入和 function schema。API 请求使用 `store: false` 并流式传输完整对话。本包不会上传 Session 导出文件；推理仍会将当前请求内容发送给 OpenAI，并且与 DSH 的 session-log 上传设置相互独立。

</details>

-----

<a id="further-exploration"></a>
## 进一步阅读

- [OpenAI SIWC 登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) — 动态客户端注册、浏览器授权和 callback。
- [OpenAI SIWC 模型和推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) — catalog 和 Responses 请求。
- [OpenAI SIWC 限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) — preview API 限制。

-----

<a id="model-experience"></a>
## 模型体验

### ChatGPT 订阅请求

#### 模型会看到什么

Adapter 将系统指令放入 Responses `instructions` 字段，把完整 DSH 消息历史转换为 Responses input，包含所选图片 bytes，并通过受支持的 `additional_tools` developer item 提供 function 定义。OpenAI 会接收这些内容进行推理。

#### Token 影响

对话历史、图片输入、function schema 和工具结果都会计入每次请求。初始 context window 为 1,050,000 token。普通生成会拒绝 DSH `maxTokens`，也不支持 `temperature` 和 `stop`。session-title 和 compaction 请求会省略 `max_output_tokens`，因此无法保证 DSH 的 title 64 和 compaction 65,536 输出限制。

#### KV Cache 影响

每次请求都会向 OpenAI 发送完整历史；adapter 不使用 `previous_response_id`。Responses 请求使用 `store: false`，并显式请求加密 reasoning 内容。adapter 会按 output index 顺序，从 SDK 可重放的 `response.output_item.done` 事件构建本地历史；只有没有收到 item 完成事件时才回退到终端 `response.output`。如果响应包含当前 SDK 无法重放的 item，请求会失败，并且诊断只包含 item type 名称。

## 已知限制

- **登录需要本机浏览器** — OAuth redirect 必须返回同一台电脑的 callback。保存后的 grant 可用于本地 headless 和 SDK 请求。
- **Responses API 参数有限** — 普通 `maxTokens`、`temperature`、`stop` 不受支持。title 和 compaction 不发送输出上限，也不保证上限。
- **模型元数据可能落后于 OpenAI catalog** — 新 slug 需要正数 `contextWindow` 覆盖后才会用于推理。账号 catalog 决定可用模型及其顺序。
- **订阅限制由账号管理** — OpenAI 因 plan usage limit 拒绝推理时，请使用 **Manage usage** 打开 [ChatGPT 使用量设置](https://chatgpt.com/settings/usage)。
- **同一 home 中登出会影响共享账号** — 同一 `$DSH_HOME` 下的 profile 共用 grants；在任一 profile 登出都会清除所有这些 profile 的本地 token。
- **Windows Desktop 尚未验证** — 此预发布版尚未在 Windows Desktop 上测试。此前一次使用官方 DSH `0.2.0-rc.2` 的尝试在安装 plugin 后报告了 `authenticatedUrl` startup error，但未记录安装的 plugin artifact。该报告无法确认此预发布版是否也受影响。
