---
description: "DeepSeek Harness の profile に ChatGPT サブスクリプション推論とアカウント管理を追加します。"
kind: "package-bundle"
---

# `@f4ah6o/dsh-chatgpt`

[English](README.md) | 日本語 | [中文](README.zh.md)

## 概要

別の API キーを使わずに、DeepSeek Harness profile へ ChatGPT サブスクリプションのモデルを追加します。OpenAI へのサインインは同じ PC のブラウザーで行い、Host は DSH Credentials ストアにアカウント情報を保存します。Web と Desktop にはトークンを含まないアカウント画面を表示します。現在、このパッケージはローカル tarball からインストールします。

## 目次

- [本パッケージを使う](#use-this-package)
- [実装を理解する](#understand-the-implementation)
- [関連情報](#further-exploration)
- [モデルへの影響](#model-experience)
- [既知の制限](#known-limitations)

-----

<a id="use-this-package"></a>
## 本パッケージを使う

### Pack とインストール

ビルド済み checkout で tarball を作成し、profile に追加します。次のコマンドは DSH ソース CLI と独立した profile home で確認済みです。

```sh
pnpm --dir packages/chatgpt pack
dsh plugin --profile web add /path/to/deepseek-harness-plugin/packages/chatgpt/f4ah6o-dsh-chatgpt-0.1.0.tgz
dsh plugin --profile headless add /path/to/deepseek-harness-plugin/packages/chatgpt/f4ah6o-dsh-chatgpt-0.1.0.tgz
```

bundle が ChatGPT plugin 行を追加します。削除する場合は `dsh plugin --profile web remove @f4ah6o/dsh-chatgpt` を実行します。npm にはまだ公開されていません。Host API の対応確認済み DSH バージョンは `0.2.0-rc.2` と `0.2.1-alpha.1` です。

Host には DSH Credentials、Authorization、LLM サービスが必要です。付属の `web`、`desktop`、`headless`、`sdk` profile は `dsh-base` 経由でこれらを含みます。独立した `sdk-minimal` profile には Credentials と Authorization がありません。該当 profile に DSH と同じバージョンの provider package を追加し、`cordis.patch.yml` に entry を追加します。

```sh
pnpm --dir "${DSH_HOME:-$HOME/.dsh}/profiles/sdk-minimal" add @deepseek-ai/dsh-authorization@0.2.0-rc.2 @deepseek-ai/dsh-credentials-local@0.2.0-rc.2
```

DSH が `0.2.1-alpha.1` の場合は両方の package に `0.2.1-alpha.1` を使い、異なる DSH API バージョンを混在させないでください。ChatGPT bundle を追加した後、次の entry を配置します。

```yaml
- insert:
    - id: authorization
      name: '@deepseek-ai/dsh-authorization'
    - id: credentials
      name: '@deepseek-ai/dsh-credentials-local'
```

Credentials、Authorization、LLM が利用可能になるまで、ChatGPT Host は pending のままです。bundle は `dsh-base` を使う profile の provider entry を置き換えません。

### ローカル PC でサインイン

Web と Desktop では **Settings → ChatGPT** からアカウントを追加し、profile で使うアカウントを選択できます。OAuth callback は `127.0.0.1` のみで待ち受けるため、同じ PC のブラウザーで認証を完了してください。リモートホストのブラウザーやクラウドでのサインインには対応していません。フローは OpenAI の [Sign in with ChatGPT 登録](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)を使い、Codex CLI には依存しません。

OAuth は `openid`、`profile`、`email`、`offline_access`、`resource.invoke`、`chatgpt.tokens.use.direct` を要求します。新規登録で ID を検証できても必要な許可または更新可能なトークンがない場合、Host は発行 client ID と検証済み subject/email だけを `needs-sign-in` として保存します。トークンは保存せず、モデルも公開しません。不完全な再認証では以前の接続済み grant を保持します。メールアドレスではなく、発行 client ID と検証済み subject で登録を区別します。

CLI の実行前にサインインするには、呼び出し時の overlay で `authorizeOnStart` を有効にします。profile は一度限りの URL を表示し、ローカル loopback callback の完了を待ってからタスクを続けます。

```sh
cat > /tmp/chatgpt-login.patch.yml <<'YAML'
- id: chatgpt
  config:
    authorizeOnStart: true
YAML

dsh --profile headless --patch /tmp/chatgpt-login.patch.yml "ChatGPT を使うタスクを実行"
```

既定値は `false` です。ChatGPT が必要なローカル実行でのみ有効にしてください。接続済みアカウントがないとサインインを開始します。provider を使う各 profile に bundle をインストールしてください。サインイン後は、同じ DSH home の profile から grant を再利用できます。接続済みアカウントが複数ある profile では `activeAccountId` を明示する必要があります。

アカウント登録と Host ID は `$DSH_HOME/.credentials.yaml` に保存されます。同じ `$DSH_HOME` を使う profile はこれらを共有します。一つの profile でサインアウトすると、共有するすべての profile の保存トークンが消去されます。サインアウトはトークン失効を要求してから access、refresh、ID token を削除します。再起動後に同じ登録を Authorization flow で再接続できるよう、client ID と subject は `needs-sign-in` として残します。Client と Session log にトークン値は渡りません。

### モデルと能力を選ぶ

設定画面は OpenAI が `visibility: "list"` とした全モデルを、正確な `slug` と `display_name` で表示します。推論用として公開するのは context window が既知のモデルだけです。初期メタデータは [GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)、[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)、[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[GPT-5.6 Sol](https://developers.openai.com/api/docs/models/gpt-5.6-sol)、[GPT-5.6 Terra](https://developers.openai.com/api/docs/models/gpt-5.6-terra)、[GPT-5.6 Luna](https://developers.openai.com/api/docs/models/gpt-5.6-luna) の7つです。各ページには現時点で context 1,050,000 token、最大出力 128,000 token、text/image 入力、text 出力と記載されています。最大出力値はメタデータに限り、リクエストの出力上限には設定しません。

GPT-6 Sol、GPT-6 Luna、GPT-5.6 Sol、GPT-5.6 Terra、GPT-5.6 Luna の5モデルは `none`、`low`、`medium`、`high`、`xhigh`、`max` をサポートし、既定値は `medium` です。GPT-6.1 Sol は `low`、`medium`、`high`、`xhigh`、`max` をサポートし、既定値は `medium` です。Astra も同じ5段階をサポートしますが、公式ページに既定値の記載はありません。公式 [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning) は GPT-6 Sol と Luna の `medium` 既定値を確認しています。モデルの公式情報は変更される可能性があります。これら7行は初期メタデータで、利用可否を保証するものではありません。

未知の正確な catalog slug や SIWC アカウント固有の能力には、profile の `modelOverrides` を使います。各行には `contextWindow`、`inputModalities`、`reasoningEfforts`、`defaultReasoningEffort` を指定できます。設定画面から profile に保存することもできます。未知モデルは正の `contextWindow` を設定するまで、設定画面には表示されますが推論には選択できません。

-----

<a id="understand-the-implementation"></a>
## 実装を理解する

<details>
<summary>実装の詳細 — クリックして展開</summary>

bundle は Host OAuth/account サービス、型付き Remote namespace、遅延 Client factory を追加します。Host が loopback callback、動的登録の identity、直列化した token refresh、model catalog の admission、OpenAI Responses adapter を管理します。Remote に渡るのは、アカウント状態、catalog 情報、安全化したログイン進捗だけです。各リクエストはアカウント、access token、model 設定、timeout を事前に固定します。

OpenAI には各推論リクエストの instructions、会話、画像入力、function schema を送ります。API リクエストは `store: false` で全履歴を stream します。本パッケージは Session export ファイルをアップロードしません。推論では各リクエストの内容を OpenAI に送信し、これは DSH の Session log upload 設定とは独立しています。

</details>

-----

<a id="further-exploration"></a>
## 関連情報

- [OpenAI SIWC サインイン](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) — 動的 client 登録、ブラウザー認証、callback。
- [OpenAI SIWC モデルと推論](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) — catalog と Responses リクエスト。
- [OpenAI SIWC 制限](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations) — preview API の制約。

-----

<a id="model-experience"></a>
## モデルへの影響

### ChatGPT サブスクリプションのリクエスト

#### モデルが受け取る内容

system instructions は Responses の `instructions` に渡し、DSH メッセージ履歴を Responses input に変換します。選択画像の bytes と、対応する `additional_tools` developer item 内の function 定義も送ります。OpenAI は推論のためにこれらの内容を受信します。

#### Token への影響

会話履歴、画像、function schema、ツール結果は各リクエストに含まれます。初期 context window は 1,050,000 token です。通常の生成では DSH `maxTokens` を拒否し、`temperature` と `stop` もサポートしません。session title と compaction では `max_output_tokens` を省略するため、DSH の title 上限64と compaction 上限65,536は保証されません。

#### KV Cache への影響

毎回、リクエスト履歴全体を OpenAI に送り、`previous_response_id` は使いません。Responses は `store: false` で実行し、完了した response item は後続リクエスト用に DSH の request state 内で再利用します。

## 既知の制限

- **サインインにはローカルブラウザーが必要です** — OAuth redirect は同じ PC 上の callback に戻る必要があります。保存後の grant はローカル headless/SDK リクエストで再利用できます。
- **Responses API のパラメーターは限定的です** — 通常の `maxTokens`、`temperature`、`stop` は非対応です。title と compaction の出力上限は送らず、強制しません。
- **モデルメタデータが catalog に追いつかない場合があります** — 新しい slug は正の `contextWindow` を設定するまで推論に公開されません。利用可否と順序はアカウントの catalog に従います。
- **利用上限はアカウント側で管理されます** — OpenAI がプラン上限で拒否したら **Manage usage** から [ChatGPT 使用量設定](https://chatgpt.com/settings/usage)を開いてください。
- **同一 home のサインアウトは共有されます** — 同じ `$DSH_HOME` を使う profile は grant を共有し、どれかでサインアウトすると全 profile の保存トークンが消えます。
