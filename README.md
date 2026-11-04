# ZeroSub

Use several Claude and ChatGPT (Codex) subscriptions side by side in [Paseo](https://paseo.sh), without logging in and out of the CLI, and run Paseo's Pi agents on several Anthropic API keys, each with its own proxy.

- **Add accounts in the app.** Click **Add account** under Claude or ChatGPT and sign in on any device, including your phone. You don't need a terminal, environment variables or config files.
- **Your existing CLI logins show up automatically.** Nothing changes until you add a second account.
- **Pick an account per agent.** An account button in the message box shows which account each Claude or Codex agent uses. Tap it to switch.
- **Automatic failover.** When an account hits its 5-hour or weekly limit, the agent moves to the account with the most room left and carries on. New agents skip exhausted accounts.
- **Live usage.** Each account shows its own 5-hour and weekly usage and when they reset, plus any ChatGPT credits. Accounts in use refresh about every minute and after each turn, and a limit shows up the moment it hits.
- **Banked resets.** If a provider has banked limit resets on an account, you can use one from the account card or the agent's account button.
- **Set an account aside.** Disable an account for a while and its agents move to your other accounts, then come back when you enable it again.
- **Several hosts.** Each Paseo host keeps its own accounts, and the Accounts screen says which host you're looking at.
- **Fork to the other provider (optional).** When every Claude account is out, a stopped chat can carry on in a new ChatGPT agent, and the other way round.
- **Pi accounts.** Add Anthropic API keys for Paseo's Pi agents, each with an optional base URL and its own proxy, and pick one per Pi agent. See [Pi accounts](#pi-accounts).
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
   - Members of the same ChatGPT Team or Business workspace can each be added; ZeroSub tells them apart by email. If Codex doesn't return one, ZeroSub won't add a second account from that workspace or sign one of its members back in.
3. Choose which account agents use:
   - **Make default**: new agents, and agents that follow the default, use it. Open Claude agents switch right away, busy ones after their turn.
     - To leave open agents where they are, turn off **Move open agents when the default changes** (in Accounts, or **Settings → Plugins → zerosub → ZeroSub preferences**). Each open agent that follows the default then stays pinned to the account it's using, even after it reopens, unless that account is signed out, disabled or at its limit. New agents, and agents that aren't open at the time, use the new default.
     - A kept agent still switches when its account hits a limit. To move it to the new default, choose **Follow default** from its account button, or type `/account default`.
   - **The account button in an agent's message box**: moves that one agent.
   - **`/account work`** in the message box, or `/account default` to follow the default again.
   - **⌘K → "Make … the default"**.
   - **Disable for now** (the pause button on a card): the account stays signed in but ZeroSub stops using it. Its agents move to your other accounts right away (busy ones after their turn) and come back when you press **Enable**. ChatGPT conversations already on it stay, since they can't change accounts. You can't disable the last usable account of a provider.
4. Leave **Automatic switching** on (in Accounts, or **Settings → Plugins → zerosub → ZeroSub preferences**) and limits take care of themselves:
   - Only the CLIs' own limit notices trigger a switch. That covers Claude Code's "You've hit your 5-hour limit · resets 3pm" ("session limit" before Claude Code 2.1.312) and Codex's "You’ve hit your usage limit…".
   - Paseo 0.13 and later no longer send the finished turn to plugins, so ZeroSub reads that turn from the agent's timeline instead.
   - A short note in the agent's timeline says what happened.
   - As a safety stop, one agent changes accounts at most 4 times in 10 minutes. If it hits that, its timeline says so; pick an account from its account button to carry on.
   - An exhausted account is skipped until it resets. If you know it has room again sooner, for example after upgrading or buying credits, press **Mark as available again** (the check mark) on its card. For ChatGPT credits, see [ChatGPT credits](#chatgpt-credits).

### Choose accounts for new agents

Turn on **Spread new agents across accounts** to select an account from its usage. For ChatGPT agents, ZeroSub prefers an account when its weekly limit resets within one day and both limits have at least 20% left. Usage for every available account must be complete and less than 30 minutes old. Otherwise, ZeroSub selects the account with the most room. Claude agents use the account with the most room. When a near weekly reset was the reason, the agent's account menu says **Started here: weekly reset was near**. Existing agents stay on their accounts.

### Claude vs. ChatGPT when switching mid-conversation

- **Claude:** a conversation moves to another account in place. The agent reopens on the new account with its full history and continues.
- **ChatGPT (Codex):** Codex encrypts its reasoning per ChatGPT account, so another account can't read an existing thread. The thread stays on its account. When it hits a limit, or you pick another account for it, ZeroSub carries the task on in its tab for the other account: a **continuation agent** in the same workspace, created on the first visit and reused after that. Switching A → B → A → B keeps two tabs, not four. Independent tasks keep separate tabs, even in the same workspace.
  - A tab you return to gets the instructions and progress since it was last used, and checks the current files and Git diff before going on. Very long instructions are shortened, keeping the first one since the tab was last used (the original request, for a new tab), the latest ones and a note of how many were left out.
  - You can type in any of a task's tabs and switch from any of them. The tab you used last is where the task continues: automatic switches and resets only move that tab, and another tab that hits a limit says in its timeline where the task went.
  - A tab is reused while it is in the same workspace with the same account and permission mode; otherwise ZeroSub starts a new one. While one of the task's tabs is working or asking for permission, a switch you pick is refused until it stops, and an automatic switch leaves the task where it is and says so in its timeline.
  - A sub-agent (one another agent started) keeps its parent: its new tab goes under the same agent, or under the tab where that agent's own task now continues. Like the first tab, it's archived with the parent and sends no notifications of its own. Paseo doesn't tell the parent when the new tab finishes, though: it only reports to an agent on agents it started or prompted itself.
  - ZeroSub never sends a hand-off twice. If a lost connection leaves one unconfirmed, the switch stops and names the tab to check. Continuation agents from earlier versions are picked up on the first switch. New Codex agents simply start on the chosen account.

### Banked resets

Some plans come with banked limit resets: ChatGPT's reset credits, and Claude Code's limit resets. When an account has any, its card shows how many are banked and when they expire, with a **Use reset** button. When an agent is stopped by a limit, its account button offers the reset too, and the agent carries on afterwards.

- A reset can't be undone, so ZeroSub always asks first and says what it refills.
- **ChatGPT** uses Codex's own reset-credit API, the same one as `/usage` → reset in the Codex CLI. It never spends a credit while nothing is used up.
- **Claude** uses Claude Code's limit-reset endpoint. Anthropic decides which accounts get resets; so far it reports the tested accounts as not eligible, so the button may not appear for Claude. It shows up by itself once an account has a reset.
- **Use banked resets when every account is out** (off by default) spends one automatically, but only when every account of that provider is at its limit and the provider confirms the limit at that moment.

### ChatGPT credits

A ChatGPT account can also have prepaid ChatGPT credits, which Codex spends once the account reaches its limit. They aren't the reset credits above. The card shows them under the usage bars, for example "57,714 ChatGPT credits left", and an agent's account button shows them next to the account's usage.

- By default, an account at its limit is skipped until it resets, credits or not, so new agents use the free room on your other accounts first. That room is lost at each reset; credits aren't. **Mark as available again** only lasts until the next usage reading, which still shows the limit reached.
- **Use ChatGPT credits when a limit is reached** (off by default; in Accounts, or **Settings → Plugins → zerosub → ZeroSub preferences**) keeps an account with credits in use at its limit. New agents may then spend paid credits even while another account still has room.
- Even with it on, a limit an agent actually ran into stays until it resets: Codex stopped that agent, so the credits didn't cover it.

### When every account of a provider is out

ZeroSub tries these in order, and a timeline note says which one happened:

1. **Use a banked reset**, if you turned on **Use banked resets when every account is out**.
2. **Fork the chat to the other provider**, if you turned on **When every account is out, fork the chat to the other provider** (off by default). A stopped Claude chat continues in a new ChatGPT agent, or the other way round:
   - The new agent opens in the same workspace (under the same parent, for a sub-agent) with the conversation so far and goes straight back to work. If that conversation began as a hand-off itself, only the start and end of the earlier one are quoted. It uses the other provider's default model and its account with the most room left.
   - Its permission mode matches the original's level. Bypass becomes Full Access, and Accept File Edits becomes Default Permissions. Codex has no read-only or ask-first mode, so a Claude agent in Plan Mode or Always Ask isn't forked. ZeroSub never gives a fork more freedom than you gave the original.
   - The original agent stays as it was, and prompting it again while its provider is still out points to the same fork rather than starting another.
   - With the option off, a stopped agent's account button offers **Continue on ChatGPT (new agent)…** (or Claude) instead, with a confirmation.
3. **Stop and say so**, with the time the account frees up.

## Pi accounts

Paseo's built-in **Pi** agents get a section of their own once [Pi](https://github.com/earendil-works/pi) is installed where the daemon runs. Its first card is Pi's own login, `~/.pi/agent` (or `PI_CODING_AGENT_DIR` in the daemon's environment), with whatever it's signed in to. **Add account** under Pi adds an Anthropic API key as an account, each with:

- **Anthropic API key**, sent as `x-api-key`.
- **Base URL** (optional): a gateway that speaks Anthropic's API. Empty uses `https://api.anthropic.com`, even when Pi's own `models.json` sends Anthropic's requests somewhere else.
- **Proxy** (optional): every request its Pi agents make goes through it, Anthropic's and any other provider's alike. Change it later with the globe button on its card. The card shows the address Anthropic sees the account's requests come from (`IP: 203.0.113.7 (US)`), checked through its proxy when it's set and every half hour after; not for an account with another base URL.

Pick an account for a Pi agent from the agent's account button or with `/account`, or make it the default. ZeroSub never moves agents onto one by itself, since it's billed per use. A Pi agent moves between accounts in place: Pi reopens its session file on the other key. Pi doesn't report usage, so Pi accounts have no usage bars, banked resets or automatic switching, and they're never forked to another provider.

The key button on Pi's own login card changes the Anthropic API key and base URL that login uses, in Pi's own `auth.json` (`anthropic`; an Anthropic sign-in made with `/login` is replaced by the key) and `models.json` (`providers.anthropic.baseUrl`), so `pi` in a terminal uses them too. The globe button there sets its proxy as `httpProxy` in Pi's `settings.json`. Each file is written where it really is, keeping the rest of it and its permissions, under Pi's own lock on it, after a copy of it as it was goes to `$PASEO_HOME/zerosub/backups/` (the last five of each). Leaving a key empty keeps it, and a kept key only goes to the base URL it went to before.

How it works:

- Each account has an agent directory of its own, which its agents get as `PI_CODING_AGENT_DIR`. It's set up in `$PASEO_HOME/zerosub/homes/pi-<id>`, then kept in `~/.pi-config/pi-<account>` (`ZEROSUB_PI_DIR` in the daemon's environment moves the default), beside its terminal script. The folder button under the Pi accounts picks another folder; the accounts move there one at a time, only while no Pi process runs with the folder as `PI_CODING_AGENT_DIR` (on macOS ZeroSub reads `ps -E`, on Linux `/proc`), and each move is written down first so one cut short is finished at the next check.
- Everything in Pi's own directory (settings, extensions, skills, prompts, sessions and the rest) is linked in, except Pi's sign-ins (`auth.json`), `models.json` and its model catalog cache (`models-store.json`).
- The account's key, base URL and proxy are in its folder's `zerosub.json` (readable only by you); the registry keeps only a short hash of the key. `auth.json` is made from it and Pi's own: the account's key for Anthropic, plus the API keys Pi's login keeps for other providers. Pi's subscription sign-ins (`/login`, OAuth) aren't copied, because each copy would refresh its token on its own and leave the other with a spent one: models that need one stay on Pi's login. Pi uses a stored key before one in the environment, so the daemon's `ANTHROPIC_API_KEY` doesn't replace it. `models.json` is Pi's own with Anthropic's base URL set to the account's and any other key or headers for Anthropic left out. Both are remade every 30 seconds and before an agent opens on the account, so don't edit them, or run `/login` with that directory.
- Agents on an account keep their sessions in the folder Pi's own login uses for that project (`~/.pi/agent/sessions/--<project path>--`, given as `PI_CODING_AGENT_SESSION_DIR` unless the daemon, the Pi provider's `env` or Pi's settings set a sessions folder already), so `pi --resume` finds them, and Paseo still resumes them after the account is removed.
- The proxy goes to the account's agents as `https_proxy`, `HTTPS_PROXY`, `http_proxy` and `HTTP_PROXY`, which Pi puts before its `httpProxy` setting, with `no_proxy` and `NO_PROXY` set to the list they'd otherwise have minus anything that would send Anthropic's or the base URL's traffic around it, plus `localhost`, `127.0.0.1` and `::1`. Accounts without a proxy of their own go through the one on Pi's own login. Each proxy is also written as Pi's `httpProxy`: Pi's own login's in `~/.pi/agent/settings.json`, an added account's in a `settings.json` of its folder's own, made from Pi's with `httpProxy` on top (a link to Pi's again once the proxy goes). Pi only uses `httpProxy` when its environment names no proxy, so a `https_proxy` your shell exports wins over it.
- Each account gets a script, `~/.pi-config/pi-<account>.sh`: put `~/.pi-config` on your `PATH` (the line to add is under the Pi accounts) and run `pi-work.sh`. It sets the account's `PI_CODING_AGENT_DIR`, reads the proxy variables its agents get in Paseo from `zerosub.env` in its folder (ZeroSub keeps it up to date), so they win over what your shell exports, and runs `pi`. Scripts follow renames; ZeroSub never overwrites one it didn't write, and several daemons can share the directory.
- Anthropic refusing an account's key (`authentication_error`) marks it signed out; **Fix key** on its card takes a working one.
- Removing a Pi account kept outside `homes/` only takes it out of ZeroSub: its folder, key and script stay (the script's second line then says ZeroSub no longer manages it). Add it back with **Add account → A folder set up already** and its folder's path: it comes back with its key, base URL and proxy, named after the folder. One still in `homes/` is deleted, key and all, once no agent is mid-turn on it.

Tested on macOS with Pi 1.4.0 and Paseo 0.15.0.

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

- Credentials stay in the CLIs' own stores. ZeroSub's registry (`$PASEO_HOME/zerosub/state.json`) holds account names, emails, plans, which agent uses which account, and continuation links with timeline positions. Handoff text stays in the agents' conversation histories; it isn't copied into the registry.
- To show Claude usage, ZeroSub reads each account's current access token and calls Anthropic's usage endpoint, the same way Paseo's built-in usage display and `/usage` do. It never logs or stores tokens and never refreshes them itself. When you refresh usage (the ↻ button beside the title) or use a reset and a token has expired, it runs `claude -p /usage` so Claude Code renews its own sign-in. In the background it does the same at most every 30 minutes per account, and only for a reading that has passed its reset time or an account at its 5-hour or weekly limit. Codex usage comes from `codex app-server`.
- Using a banked reset calls the provider's own reset endpoint with that account's sign-in, and only after you confirm (or turn on automatic use).
- Removing an account moves its agents to the default account, then signs it out (`claude auth logout` / `codex` logout) and deletes its home. This happens once no agent is mid-turn on it. Abandoned sign-ins are cleaned up the same way.
- An account that still has ChatGPT conversations on it can't be removed until you archive them or continue them elsewhere, because they can't move.
- Your CLI login can't be removed from ZeroSub.

## Limitations

- **MCP servers that use OAuth** (Linear, Notion, …) store their tokens per Claude account, so sign in to them once on each account.
- **Shared settings apply to every account.** If `~/.claude/settings.json` sets an `apiKeyHelper` or API-key `env`, every account uses that key instead of its subscription.
- **Usage for an idle Claude account** shows the last reading until the account is used again or you refresh usage. If a window in it has passed its reset time, or the account is at its limit, ZeroSub also renews the sign-in in the background to read it again, at most every 30 minutes, so an early reset or one used on another machine shows up too. Anthropic rate-limits its usage endpoint (Claude Code and Paseo read it too), so a reading can be a few minutes old; the card then says when it was taken. Readings are saved in `$PASEO_HOME/zerosub/usage.json`, so they survive restarts.
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
- `server/`: routing, account homes, Claude, Codex and Pi adapters, failover, Pi account folders and scripts.
- `shared/`: RPC contracts and the view model.

Report problems at [github.com/kapybara-org/ZeroSub/issues](https://github.com/kapybara-org/ZeroSub/issues).

## Uninstall

Remove added accounts from **Accounts** first, so they're signed out. Then run:

```bash
paseo plugin remove zerosub
rm -rf ~/.paseo/zerosub
```
