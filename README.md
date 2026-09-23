# ZeroSub

Use several Claude and ChatGPT (Codex) subscriptions side by side in [Paseo](https://paseo.sh), without logging in and out of the CLI.

- **Add accounts in the app.** Click **Add account** under Claude or ChatGPT and sign in on any device, including your phone. You don't need a terminal, environment variables or config files.
- **Your existing CLI logins show up automatically.** Nothing changes until you add a second account.
- **Pick an account per agent.** An account button in the message box shows which account each Claude or Codex agent uses. Tap it to switch.
- **Automatic failover.** When an account hits its 5-hour or weekly limit, the agent moves to the account with the most room left and carries on. New agents skip exhausted accounts.
- **Live usage.** Each account shows its own 5-hour and weekly usage and when they reset. Accounts in use refresh about every minute and after each turn, and a limit shows up the moment it hits.
- **Banked resets.** If a provider has banked limit resets on an account, you can use one from the account card or the agent's account button.
- **Several hosts.** Each Paseo host keeps its own accounts, and the Accounts screen says which host you're looking at.
- **Fork to the other provider (optional).** When every Claude account is out, a stopped chat can carry on in a new ChatGPT agent, and the other way round.
- **Everything else stays the same.** Every account shares your settings, skills, plugins, MCP servers, `CLAUDE.md`/`AGENTS.md` and conversation history.

## Install

Requirements:

- Paseo 0.9.1 or later, with plugins enabled (**Settings → Plugins → Enable plugins**).
- The `claude` and/or `codex` CLI installed where the daemon runs, the same ones Paseo already uses.

In the app, open **Settings → Plugins**, paste `npm:@kapybara/zerosub` as the plugin source, and install. Or, on the daemon host:

```bash
paseo plugin install npm:@kapybara/zerosub
# or straight from GitHub:
paseo plugin install github:kapybara-org/zerosub
```

Then open **Accounts (ZeroSub)** in the sidebar.

## Use it

1. Open **Accounts (ZeroSub)** in the sidebar. Your current Claude Code and Codex logins are already listed.
2. Click **Add account** under Claude or ChatGPT (Codex), then **Open sign-in page**, and sign in with the other account.
   - In a browser on the host's own computer, the page finishes by itself.
   - Anywhere else, choose **Use a code instead**. For Claude, paste the code shown after sign-in. For ChatGPT, type the code shown in Paseo on the page. Phones, and hosts without a desktop (servers, containers, daemons started over SSH), start with the code.
3. Choose which account agents use:
   - **Make default**: new agents, and agents that follow the default, use it.
   - **The account button in an agent's message box**: moves that one agent.
   - **`/account work`** in the message box, or `/account default` to follow the default again.
   - **⌘K → "Make … the default"**.
4. Leave **Automatic switching** on (in Accounts, or **Settings → Plugins → zerosub → ZeroSub preferences**) and limits take care of themselves:
   - Only the CLIs' own limit notices trigger a switch. That covers Claude Code's "You've hit your session limit · resets 3pm" and Codex's "You’ve hit your usage limit…".
   - A short note in the agent's timeline says what happened.
   - As a safety stop, one agent changes accounts at most 4 times in 10 minutes. If it hits that, its timeline says so; pick an account from its account button to carry on.
   - An exhausted account is skipped until it resets. If you know it has room again sooner, for example after upgrading or buying credits, press **Mark as available again** (the check mark) on its card.

### Claude vs. ChatGPT when switching mid-conversation

- **Claude:** a conversation moves to another account in place. The agent reopens on the new account with its full history and continues.
- **ChatGPT (Codex):** Codex encrypts its reasoning per ChatGPT account, so another account can't read an existing thread. The thread stays on its account. When it hits a limit, or you pick another account for it, ZeroSub starts a **continuation agent** on the other account. It goes in the same workspace and gets a transcript of the conversation so far, so the work keeps going. New Codex agents simply start on the chosen account.

### Banked resets

Some plans come with banked limit resets: ChatGPT's reset credits, and Claude Code's limit resets. When an account has any, its card shows how many are banked and when they expire, with a **Use reset** button. When an agent is stopped by a limit, its account button offers the reset too, and the agent carries on afterwards.

- A reset can't be undone, so ZeroSub always asks first and says what it refills.
- **ChatGPT** uses Codex's own reset-credit API, the same one as `/usage` → reset in the Codex CLI. It never spends a credit while nothing is used up.
- **Claude** uses Claude Code's limit-reset endpoint. Anthropic decides which accounts get resets; so far it reports the tested accounts as not eligible, so the button may not appear for Claude. It shows up by itself once an account has a reset.
- **Use banked resets when every account is out** (off by default) spends one automatically, but only when every account of that provider is at its limit and the provider confirms the limit at that moment.

### When every account of a provider is out

ZeroSub tries these in order, and a timeline note says which one happened:

1. **Use a banked reset**, if you turned on **Use banked resets when every account is out**.
2. **Fork the chat to the other provider**, if you turned on **When every account is out, fork the chat to the other provider** (off by default). A stopped Claude chat continues in a new ChatGPT agent, or the other way round:
   - The new agent opens in the same workspace with the conversation so far and goes straight back to work. It uses the other provider's default model and its account with the most room left.
   - Its permission mode matches the original's level. Bypass becomes Full Access, and Accept File Edits becomes Default Permissions. Codex has no read-only or ask-first mode, so a Claude agent in Plan Mode or Always Ask isn't forked. ZeroSub never gives a fork more freedom than you gave the original.
   - The original agent stays as it was, and prompting it again while its provider is still out points to the same fork rather than starting another.
   - With the option off, a stopped agent's account button offers **Continue on ChatGPT (new agent)…** (or Claude) instead, with a confirmation.
3. **Stop and say so**, with the time the account frees up.

## Several hosts

Paseo installs plugins per host (daemon), so install ZeroSub on each host whose agents should use it. When more than one host has it, Paseo shows a single **Accounts (ZeroSub)** item with a host picker at the top.

- **Each host has its own accounts, default and preferences**, because the sign-ins live on the machine where the agents run. The Accounts screen and the sign-in dialog name the host they belong to.
- **An agent's account button always belongs to the agent's host**, and its **Manage accounts…** opens that host.
- **Sign the same account in on each host.** ZeroSub never copies sign-ins between hosts. Both providers rotate sign-in tokens, so two machines sharing one token sign each other out. Separate sign-ins of the same account work fine. Limits are per account, so every host sees the combined usage and switches when it runs out.
- **Remote hosts:** phones, and hosts without a desktop, get the code sign-in automatically. For a remote computer that does have a desktop, choose **Use a code instead** unless you're sitting at it.
- **Banked resets refill the account everywhere.** Automatic use re-checks the limit with the provider first, so two hosts can't spend two resets on the same limit.

## How it works

Each added account gets its own credential home under `$PASEO_HOME/zerosub/homes/`:

- Claude uses it as `CLAUDE_CONFIG_DIR`; Codex uses it as `CODEX_HOME`.
- The CLIs keep each home's login separate: Claude in its own keychain entry (`.credentials.json` on Linux), Codex in its own `auth.json`.
- Everything that isn't account-specific is a symlink back to `~/.claude` or `~/.codex`. For Claude that includes `settings.json`, `skills/`, `plugins/` and `projects/`; for Codex, `config.toml`, `sessions/` and more. Codex also shares its thread database through `CODEX_SQLITE_HOME`.
- Claude's `.claude.json` holds the account identity, so each account keeps its own copy. It's seeded from yours, and your MCP servers stay in sync.

A `before("agent.session_open")` hook sets those variables for every session Paseo opens: create, resume, refresh and import. To move a live agent, ZeroSub reopens its session with `paseo agent reload`. It never interrupts a running turn; a busy agent moves when its turn ends.

Sign-in runs the official CLIs:

- Claude: `claude auth login`.
- Codex: `codex app-server`'s account API.

ZeroSub never implements OAuth itself and never copies credentials between accounts.

## Privacy and security

- Credentials stay in the CLIs' own stores. ZeroSub's registry (`$PASEO_HOME/zerosub/state.json`) holds only account names, emails, plans and which agent uses which account.
- To show Claude usage, ZeroSub reads each account's current access token and calls Anthropic's usage endpoint, the same way Paseo's built-in usage display and `/usage` do. It never logs or stores tokens and never refreshes them itself. When you refresh usage (the ↻ button beside the title) or use a reset and a token has expired, it runs `claude -p /usage` so Claude Code renews its own sign-in. Codex usage comes from `codex app-server`.
- Using a banked reset calls the provider's own reset endpoint with that account's sign-in, and only after you confirm (or turn on automatic use).
- Removing an account moves its agents to the default account, then signs it out (`claude auth logout` / `codex` logout) and deletes its home. This happens once no agent is mid-turn on it. Abandoned sign-ins are cleaned up the same way.
- An account that still has ChatGPT conversations on it can't be removed until you archive them or continue them elsewhere, because they can't move.
- Your CLI login can't be removed from ZeroSub.

## Limitations

- **MCP servers that use OAuth** (Linear, Notion, …) store their tokens per Claude account, so sign in to them once on each account.
- **Shared settings apply to every account.** If `~/.claude/settings.json` sets an `apiKeyHelper` or API-key `env`, every account uses that key instead of its subscription.
- **Usage for an idle Claude account** shows the last reading until the account is used again or you refresh usage. Anthropic rate-limits its usage endpoint (Claude Code and Paseo read it too), so a reading can be a few minutes old; the card then says when it was taken. Readings are saved in `$PASEO_HOME/zerosub/usage.json`, so they survive restarts.
- **Password-protected daemons:** `paseo agent reload` can't authenticate. Agents then switch the next time their session starts, not immediately, and their timeline note says so.
- **Imported Codex threads** (`paseo agent import`) are assigned to your CLI login, since that's where standalone Codex sessions come from.
- **ChatGPT device-code sign-in** has to be enabled in ChatGPT → Settings → Security. The browser option works from a browser on the host's own computer.
- Tested on macOS with Claude Code 2.1.280, Codex 0.156.1 and Paseo 0.9.1. Linux should work. Windows is untested.

## Development

```bash
git clone https://github.com/kapybara-org/zerosub.git
cd zerosub
npm install
paseo plugin install "$(pwd)"   # run the working copy

npm run typecheck      # client and server bundles, separately
npm test               # routing, failover, limit detection, usage, resets, forks
npm run audit:mobile   # no DOM/HTML in client code
paseo plugin reload zerosub
paseo plugin logs zerosub
```

Code layout:

- `client/`: React Native UI (Accounts surface, sign-in modal, composer pill, commands, timeline note).
- `server/`: routing, account homes, Claude and Codex adapters, failover.
- `shared/`: RPC contracts and the view model.

Report problems at [github.com/kapybara-org/ZeroSub/issues](https://github.com/kapybara-org/ZeroSub/issues).

## Uninstall

Remove added accounts from **Accounts** first, so they're signed out. Then run:

```bash
paseo plugin remove zerosub
rm -rf ~/.paseo/zerosub
```
