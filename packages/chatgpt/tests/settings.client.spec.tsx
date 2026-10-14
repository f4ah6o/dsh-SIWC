// @vitest-environment jsdom
/** Client sign-in reauthentication and first-use welcome behavior. */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import type { ButtonHTMLAttributes, ReactNode } from 'react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { brandString } from '@deepseek-ai/dsh-brand'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol'
import type {
  ChatGptAccountId, ChatGptAccountView, ChatGptLoginAttemptId, ChatGptRevocationResult, ChatGptState,
} from '../src/types.ts'
import { ChatGptSettingsSection, type ChatGptRemote } from '../src/client/ChatGptSettingsSection.tsx'
import { en } from '../src/client/locales.ts'

vi.mock('@deepseek-ai/dsh-client-ui-primitives', async () => {
  const React = await import('react')
  interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
    readonly icon?: ReactNode
    readonly variant?: string
    readonly size?: string
  }
  interface ModalProps {
    readonly open: boolean
    readonly title: string
    readonly description?: string
    readonly closeLabel: string
    readonly onClose: () => void
    readonly footer?: ReactNode
    readonly children?: ReactNode
  }
  return {
    Button: ({ icon, variant: _variant, size: _size, children, ...props }: ButtonProps) =>
      React.createElement('button', { ...props, type: 'button' }, icon, children),
    Modal: ({ open, title, description, closeLabel, onClose, footer, children }: ModalProps) => open
      ? React.createElement('div', { role: 'dialog', 'aria-label': title },
        React.createElement('h2', {}, title),
        description === undefined ? null : React.createElement('p', {}, description),
        children,
        footer,
        React.createElement('button', { type: 'button', onClick: onClose }, closeLabel))
      : null,
  }
})

const success = <T,>(value: T): RemoteResult<T> => ({ ok: true, value })

afterEach(() => {
  cleanup()
  vi.restoreAllMocks()
})

const accountId = brandString<ChatGptAccountId>('account-1')
const account: ChatGptAccountView = {
  id: accountId,
  label: 'Personal account',
  email: 'person@example.com',
  active: true,
  status: 'connected',
  models: [],
}

function state(overrides: Partial<ChatGptState> = {}): ChatGptState {
  return {
    accounts: [],
    welcomeAcknowledged: true,
    loginAttempts: [],
    loginPollIntervalMs: 60_000,
    ...overrides,
  }
}

function remoteFor(getState: () => Promise<ChatGptState>): ChatGptRemote {
  return {
    getState: vi.fn(async () => success(await getState())),
    beginLogin: vi.fn(async () => success({
      attemptId: brandString<ChatGptLoginAttemptId>('attempt-1'),
      authorizationUrl: 'https://auth.openai.com/oauth/authorize',
    })),
    cancelLogin: vi.fn(async () => success(undefined)),
    setActiveAccount: vi.fn(async () => success(undefined)),
    signOut: vi.fn(async () => success({ revocation: { status: 'confirmed' as const }, revocationConfirmed: true })),
    refreshModels: vi.fn(async () => success(state())),
    setModelConfig: vi.fn(async () => success(state())),
    acknowledgeWelcome: vi.fn(async () => success(undefined)),
  }
}

function mount(remote: ChatGptRemote) {
  return render(<ChatGptSettingsSection
    remote={remote}
    trackAttempt={vi.fn()}
    finishAttempt={vi.fn()}
    t={key => (en as Readonly<Record<string, string>>)[key] ?? key}
  />)
}

describe('ChatGptSettingsSection', () => {
  it('reauthenticates the selected saved registration instead of adding an account', async () => {
    const saved = { ...account, status: 'needs-sign-in' as const }
    const remote = remoteFor(async () => state({ accounts: [saved], activeAccountId: saved.id }))
    vi.spyOn(window, 'open').mockReturnValue(null)
    mount(remote)
    await screen.findByText(en.signInRequired)

    const signInButtons = screen.getAllByRole('button', { name: en.continueWithChatGPT })
    expect(signInButtons[1]?.className).toContain('signInButton')
    fireEvent.click(signInButtons[1]!)

    await waitFor(() => expect(remote.beginLogin).toHaveBeenCalledExactlyOnceWith({ accountId: saved.id }))
  })

  it('shows a generic sign-in failure without exposing Remote error details', async () => {
    const remote = remoteFor(async () => state())
    vi.mocked(remote.beginLogin).mockResolvedValue({
      ok: false,
      error: new RemoteError('gateway/internal', 'access_token=private-value', {}),
    })
    vi.spyOn(window, 'open').mockReturnValue(null)
    mount(remote)

    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))

    expect((await screen.findByRole('alert')).textContent).toContain(en.actionFailed)
    expect(document.body.textContent).not.toContain('private-value')
  })

  it('cancels a pending local sign-in when the settings view is disposed', async () => {
    const attemptId = brandString<ChatGptLoginAttemptId>('attempt-1')
    const remote = remoteFor(async () => state())
    vi.mocked(remote.beginLogin).mockResolvedValue(success({
      attemptId,
      authorizationUrl: 'https://auth.openai.com/oauth/authorize',
    }))
    vi.spyOn(window, 'open').mockReturnValue(null)
    const view = mount(remote)

    fireEvent.click(await screen.findByRole('button', { name: en.continueWithChatGPT }))
    await waitFor(() => expect(remote.beginLogin).toHaveBeenCalledOnce())
    view.unmount()

    await waitFor(() => expect(remote.cancelLogin).toHaveBeenCalledExactlyOnceWith({ attemptId }))
  })

  it.each([
    { phase: 'failed' as const, label: en.loginFailed },
    { phase: 'cancelled' as const, label: en.loginCancelled },
  ])('stops polling after a sign-in becomes $phase', async ({ phase, label }) => {
    const attemptId = brandString<ChatGptLoginAttemptId>('attempt-1')
    const pending = { id: attemptId, phase: 'awaiting-browser' as const }
    let reads = 0
    const remote = remoteFor(async () => {
      reads += 1
      return reads === 1
        ? state({ loginAttempts: [pending], loginPollIntervalMs: 20 })
        : state({ loginAttempts: [{ id: attemptId, phase, message: 'Sign-in ended.' }], loginPollIntervalMs: 20 })
    })
    vi.useFakeTimers()
    try {
      mount(remote)
      await act(async () => { await Promise.resolve() })
      expect(screen.getByText(en.loginWaiting)).toBeTruthy()

      await act(async () => { await vi.advanceTimersByTimeAsync(20) })
      expect(screen.getByText(label)).toBeTruthy()
      expect(remote.getState).toHaveBeenCalledTimes(2)

      await act(async () => { await vi.advanceTimersByTimeAsync(100) })
      expect(remote.getState).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('switches the profile account used by future ChatGPT requests', async () => {
    const secondId = brandString<ChatGptAccountId>('account-2')
    const second: ChatGptAccountView = {
      ...account,
      id: secondId,
      label: 'Work account',
      email: 'work@example.com',
      active: false,
    }
    let current = state({ accounts: [account, second], activeAccountId: account.id })
    const remote = remoteFor(async () => current)
    vi.mocked(remote.setActiveAccount).mockImplementation(async request => {
      current = state({
        accounts: [
          { ...account, active: request.accountId === account.id },
          { ...second, active: request.accountId === second.id },
        ],
        activeAccountId: request.accountId,
      })
      return success(undefined)
    })
    mount(remote)
    const select = await screen.findByRole('combobox', { name: en.activeAccount })

    fireEvent.change(select, { target: { value: second.id } })

    await waitFor(() => expect(remote.setActiveAccount).toHaveBeenCalledExactlyOnceWith({ accountId: second.id }))
    await waitFor(() => expect((select as HTMLSelectElement).value).toBe(second.id))
  })

  it('shows the welcome once after an account connects and persists dismissal', async () => {
    let current = state({ accounts: [account], activeAccountId: account.id, welcomeAcknowledged: false })
    const remote = remoteFor(async () => current)
    vi.mocked(remote.acknowledgeWelcome).mockImplementation(async () => {
      current = { ...current, welcomeAcknowledged: true }
      return success(undefined)
    })
    mount(remote)

    const dialog = await screen.findByRole('dialog')
    expect(dialog.textContent).toContain(en.welcomeDescription)
    expect(dialog.querySelector(`a[href="https://chatgpt.com/settings/usage"]`)?.textContent).toBe(en.manageUsage)
    fireEvent.click(screen.getByRole('button', { name: en.continue }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(remote.acknowledgeWelcome).toHaveBeenCalledOnce()
    expect(current.welcomeAcknowledged).toBe(true)
  })

  it('requires a context window before saving an unlisted model override', async () => {
    const unknownModel = {
      slug: 'gpt-future-model',
      displayName: 'A future model with a deliberately long display name',
      usable: false,
      overridden: false,
    }
    let current = state({
      accounts: [{ ...account, models: [unknownModel] }],
      activeAccountId: account.id,
    })
    const remote = remoteFor(async () => current)
    vi.mocked(remote.setModelConfig).mockImplementation(async update => {
      current = state({
        accounts: [{
          ...account,
          models: [{ ...unknownModel, contextWindow: update.config?.contextWindow, usable: true, overridden: true }],
        }],
        activeAccountId: account.id,
      })
      return success(current)
    })
    mount(remote)

    await screen.findByText(unknownModel.displayName)
    expect(screen.getByText(en.modelNeedsContext)).toBeTruthy()
    expect(screen.getByText(en.contextWindowRequired)).toBeTruthy()
    const save = screen.getByRole('button', { name: en.save }) as HTMLButtonElement
    expect(save.disabled).toBe(true)

    fireEvent.change(screen.getByRole('spinbutton', { name: en.contextWindow }), { target: { value: '98304' } })
    expect(save.disabled).toBe(false)
    fireEvent.click(save)

    await waitFor(() => expect(remote.setModelConfig).toHaveBeenCalledExactlyOnceWith({
      accountId: account.id,
      model: unknownModel.slug,
      config: { contextWindow: 98304, inputModalities: ['text'] },
    }))
  })
})

describe('ChatGptSettingsSection sign-out and ChatGPT disconnection guidance', () => {
  const outcomes: readonly { revocation: ChatGptRevocationResult; message: string; reason?: string }[] = [
    { revocation: { status: 'confirmed' }, message: en.signOutRevocationConfirmed },
    { revocation: { status: 'unconfirmed', reason: 'request-rejected' }, message: en.signOutRevocationUnconfirmed, reason: en.revocationRequestRejected },
    { revocation: { status: 'unconfirmed', reason: 'metadata-unavailable' }, message: en.signOutRevocationUnconfirmed, reason: en.revocationMetadataUnavailable },
    { revocation: { status: 'unconfirmed', reason: 'service-unavailable' }, message: en.signOutRevocationUnconfirmed, reason: en.revocationServiceUnavailable },
    { revocation: { status: 'unconfirmed', reason: 'network-error' }, message: en.signOutRevocationUnconfirmed, reason: en.revocationNetworkError },
    { revocation: { status: 'unconfirmed', reason: 'request-timeout' }, message: en.signOutRevocationUnconfirmed, reason: en.revocationRequestTimeout },
    { revocation: { status: 'unconfirmed', reason: 'unexpected-response' }, message: en.signOutRevocationUnconfirmed, reason: en.revocationUnexpectedResponse },
    { revocation: { status: 'not-attempted', reason: 'already-signed-out' }, message: en.signOutAlreadyLocal },
    { revocation: { status: 'not-attempted', reason: 'no-refresh-token' }, message: en.signOutNoRefreshToken },
  ]

  it.each(outcomes)('shows $revocation.status / $revocation.reason without claiming that registration was removed', async ({ revocation, message, reason }) => {
    let current = state({ accounts: [account], activeAccountId: account.id })
    const remote = remoteFor(async () => current)
    vi.mocked(remote.signOut).mockImplementation(async () => {
      current = state({ accounts: [{ ...account, active: false, status: 'needs-sign-in', signOutRevocation: revocation }] })
      return success({ revocation, revocationConfirmed: revocation.status === 'confirmed' })
    })
    mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.signOut }))
    const dialog = await screen.findByRole('dialog', { name: en.confirmSignOut })
    expect(dialog.textContent).toContain(en.confirmSignOutDescription)
    fireEvent.click(within(dialog).getByRole('button', { name: en.confirm }))

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull())
    expect(remote.signOut).toHaveBeenCalledExactlyOnceWith({ accountId: account.id })
    expect(screen.getByText(message, { exact: false })).toBeTruthy()
    if (reason !== undefined) expect(screen.getByText(reason, { exact: false })).toBeTruthy()
    expect(screen.getByText(en.disconnectDescription)).toBeTruthy()
    expect(screen.getByRole('link', { name: en.manageConnection }).getAttribute('href')).toBe('https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites')
    expect(screen.queryByRole('button', { name: en.signOut })).toBeNull()
    if (revocation.status !== 'confirmed') expect(screen.queryByText(en.signOutRevocationConfirmed)).toBeNull()
    if (revocation.status === 'not-attempted') expect(screen.queryByText(en.signOutRevocationUnconfirmed, { exact: false })).toBeNull()
  })

  it('keeps a previous unconfirmed warning after a repeated stale sign-out and remount', async () => {
    const previous: ChatGptRevocationResult = { status: 'unconfirmed', reason: 'network-error' }
    let current = state({ accounts: [{ ...account, signOutRevocation: previous }], activeAccountId: account.id })
    const remote = remoteFor(async () => current)
    vi.mocked(remote.signOut).mockImplementation(async () => {
      current = state({ accounts: [{ ...account, active: false, status: 'needs-sign-in', signOutRevocation: previous }] })
      return success({ revocation: { status: 'not-attempted', reason: 'already-signed-out' }, revocationConfirmed: false })
    })
    const view = mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.signOut }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.confirm }))
    await screen.findByText(en.signOutRevocationUnconfirmed, { exact: false })
    expect(screen.queryByText(en.signOutAlreadyLocal)).toBeNull()
    expect(screen.queryByText(en.signOutRevocationConfirmed)).toBeNull()
    view.unmount()
    mount(remote)
    await screen.findByText(en.signOutRevocationUnconfirmed, { exact: false })
    expect(remote.signOut).toHaveBeenCalledOnce()
    expect(screen.queryByRole('button', { name: en.signOut })).toBeNull()
  })

  it('does not show a revocation warning for an old tokenless registration with unknown history', async () => {
    const remote = remoteFor(async () => state({ accounts: [{ ...account, active: false, status: 'needs-sign-in' }] }))
    mount(remote)
    await screen.findByText(en.signInRequired)
    expect(screen.queryByRole('button', { name: en.signOut })).toBeNull()
    expect(screen.queryByText(en.signOutRevocationUnconfirmed)).toBeNull()
    expect(screen.queryByText(en.signOutRevocationConfirmed)).toBeNull()
    expect(screen.getByText(en.disconnectDescription)).toBeTruthy()
  })

  it('shows the completed local sign-out and warning when the subsequent state read fails', async () => {
    let failed = false
    const remote = remoteFor(async () => {
      if (failed) throw new Error('synthetic-secret')
      return state({ accounts: [account], activeAccountId: account.id })
    })
    vi.mocked(remote.signOut).mockImplementation(async () => {
      failed = true
      return success({ revocation: { status: 'unconfirmed', reason: 'network-error' }, revocationConfirmed: false })
    })
    mount(remote)
    fireEvent.click(await screen.findByRole('button', { name: en.signOut }))
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: en.confirm }))
    await screen.findByText(en.signOutRevocationUnconfirmed, { exact: false })
    expect(screen.getByRole('alert').textContent).toContain(en.actionFailed)
    expect(screen.queryByRole('button', { name: en.signOut })).toBeNull()
    expect(document.body.textContent).not.toContain('synthetic-secret')
  })
})
