/** Host plugin entry for ChatGPT subscription inference. */
import type { Context } from '@deepseek-ai/cordis'
import { brandString } from '@deepseek-ai/dsh-brand'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Config as PluginConfig } from './config.ts'
import type {
  ChatGptAccountRequest, ChatGptCancelLoginRequest, ChatGptLoginRequest, ChatGptLoginTicket,
  ChatGptModelConfigUpdate, ChatGptSignOutResult, ChatGptState,
} from './types.ts'

export type * from './types.ts'
export { Config } from './config.ts'

/** Package name shown in plugin diagnostics. */
export const name = '@f4ah6o/dsh-chatgpt'

/** Runtime needs the local Credentials and LLM services. */
export const inject = ['credentials', 'llm']

/** Typed Remote operations for ChatGPT account and profile configuration. */
export class ChatGptController extends TypertRemoteService {
  static inject = ['credentials', 'llm']

  /** @param ctx - Host context carrying the Credentials and LLM services. */
  constructor(ctx: Context, private readonly config: PluginConfig) {
    super(ctx, 'chatgptController', { namespace: 'chatgpt' })
  }

  /** Read account, catalog and sign-in state without exposing credentials.
   * @returns the redacted account and OAuth-attempt snapshot.
   */
  @Remote
  getState(): Promise<ChatGptState> {
    const activeAccountId = this.config.activeAccountId.get()
    return Promise.resolve({
      accounts: [],
      ...(activeAccountId === undefined ? {} : { activeAccountId: brandString<ChatGptState['activeAccountId'] & string>(activeAccountId) }),
      welcomeAcknowledged: this.config.welcomeAcknowledged.get(),
      loginAttempts: [],
      loginPollIntervalMs: this.config.loginPollIntervalMs.get(),
    })
  }

  /** Start a Host-owned OAuth callback and return the URL for the system browser.
   * @returns the safe attempt handle and authorization URL.
   */
  @Remote
  beginLogin(_request: ChatGptLoginRequest): Promise<ChatGptLoginTicket> {
    return Promise.reject(new Error('ChatGPT sign-in is not available until the account service is configured'))
  }

  /** Cancel an unfinished local sign-in attempt.
   * @param attemptId - opaque attempt handle returned by {@link beginLogin}.
   */
  @Remote
  cancelLogin(request: ChatGptCancelLoginRequest): Promise<void> {
    void request
    return Promise.resolve()
  }

  /** Select the profile's ChatGPT account for future model requests.
   * @param accountId - the saved account to activate.
   */
  @Remote
  setActiveAccount(request: ChatGptAccountRequest): Promise<void> {
    void request
    return Promise.reject(new Error('No ChatGPT accounts are connected'))
  }

  /** Remove an account and revoke its refresh token when possible.
   * @param accountId - account to disconnect.
   */
  @Remote
  signOut(request: ChatGptAccountRequest): Promise<ChatGptSignOutResult> {
    void request
    return Promise.reject(new Error('No ChatGPT accounts are connected'))
  }

  /** Refresh one saved account's list-visible model catalog.
   * @param accountId - account whose catalog should be refreshed.
   * @returns the updated redacted state.
   */
  @Remote
  refreshModels(request: ChatGptAccountRequest): Promise<ChatGptState> {
    void request
    return this.getState()
  }

  /** Store or clear one profile capability override.
   * @param update - exact account catalog slug and its replacement override.
   * @returns updated redacted state.
   */
  @Remote
  setModelConfig(update: ChatGptModelConfigUpdate): Promise<ChatGptState> {
    void update
    return this.getState()
  }

  /** Remember that a Client has shown the initial account welcome view.
   */
  @Remote
  acknowledgeWelcome(): Promise<void> {
    return Promise.resolve()
  }
}

/** Register the account service in a Host profile. */
export async function apply(ctx: Context, config: PluginConfig): Promise<void> {
  await ctx.plugin(ChatGptController, config)
}

export default apply
