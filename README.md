# ZeroSub

Use several Claude, ChatGPT (Codex), Grok and Cursor subscriptions side by side in [Paseo](https://paseo.sh), without logging in and out of the CLI, and run Paseo's Pi agents on several Anthropic API keys, each with its own proxy.

- **Add accounts in the app.** Click **Add account** under Claude or ChatGPT and sign in on any device, including your phone. You don't need a terminal, environment variables or config files.
- **Your existing CLI logins show up automatically.** Nothing changes until you add a second account.
- **Pick an account per agent.** An account button in the message box shows which account each Claude or Codex agent uses. Tap it to switch. On Paseo 0.16 and later, a new agent's message box has an **Account** control too, so you can pick before the first message.
- **Automatic failover.** When an account hits its 5-hour or weekly limit, the agent moves to the account with the most room left and carries on. New agents skip exhausted accounts.
- **Live usage.** Each account shows its own 5-hour and weekly usage and when they reset, plus any ChatGPT credits or Claude extra usage. Accounts in use refresh about every minute and after each turn, and a limit shows up the moment it hits.
- **Banked resets.** If a provider has banked limit resets on an account, you can use one from the account card or the agent's account button.
- **Set an account aside.** Disable an account for a while and its agents move to your other accounts, then come back when you enable it again.
- **Several hosts.** Each Paseo host keeps its own accounts, and the Accounts screen says which host you're looking at.
- **Fork to the other provider (optional).** When every Claude account is out, a stopped chat can carry on in a new ChatGPT agent, and the other way round. A stopped Claude chat can instead continue on the host's OpenCode.
- **Grok accounts.** Sign in several Grok (SuperGrok, X Premium+) accounts for Paseo's Grok agents and pick the one each new agent starts on. See [Grok accounts](#grok-accounts).
- **Cursor accounts.** Sign in several Cursor accounts for Paseo's Cursor agents (`cursor-agent`) and pick the one each new agent starts on (Linux only for now). See [Cursor accounts](#cursor-accounts).
- **Azure OpenAI accounts.** Add an Azure OpenAI key under ChatGPT (Codex) and pick it for an agent or make it the default. ZeroSub only moves work onto it by itself if you turn that on, and then only when every ChatGPT subscription is out (after a banked reset, if you let ZeroSub spend those). See [Azure OpenAI accounts](#azure-openai-accounts).
- **AWS Bedrock accounts.** Add Claude Code on Amazon Bedrock under Claude, with the host's own AWS credentials, a profile or an access key, and pick it for an agent or make it the default. ZeroSub only moves work onto it by itself if you turn that on, then only when every Claude subscription is out (after a banked reset, if you let ZeroSub spend those), and back once one has room. See [AWS Bedrock accounts](#aws-bedrock-accounts).
- **Pi accounts.** Add Anthropic API keys for Paseo's Pi agents, each with an optional base URL and its own proxy, and pick one per Pi agent. See [Pi accounts](#pi-accounts).
- **Everything else stays the same.** Every account shares your settings, skills, plugins, MCP servers, `CLAUDE.md`/`AGENTS.md` and conversation history.

## Install

Requirements:

- Paseo 0.9.1 or later, with plugins enabled (**Settings → Plugins → Enable plugins**).
- The `claude` and/or `codex` CLI installed where the daemon runs, the same ones Paseo already uses. For Grok accounts, the `grok` CLI and a Grok provider in Paseo (see [Grok accounts](#grok-accounts)); for Cursor accounts, Linux, `cursor-agent` and a Cursor provider (see [Cursor accounts](#cursor-accounts)).

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
   - **The account button in an agent's message box**: moves that one agent. While a move is under way it names both accounts, for example `personal → work`: the agent still runs on the first until its session reopens, and the button's tooltip says when that happens (once it's idle, when its turn ends, once background work it left running stops, or when its session next starts). If the reload doesn't work, the button says why and the agent's timeline notes it.
   - With automatic switching on, an account at its limit can't be picked for an agent: the agent would only move straight off it again. Pick another one, or press **Mark as available again** on the account's card if it has room.
   - **`/account work`** in the message box, or `/account default` to follow the default again.
   - **⌘K → "Make … the default"**.
   - **Disable for now** (the pause button on a card): the account stays signed in but ZeroSub stops using it. Its agents move to your other accounts right away (busy ones after their turn) and come back when you press **Enable**. ChatGPT conversations already on it stay, since they can't change accounts. You can't disable the last usable account of a provider.
4. Leave **Automatic switching** on (in Accounts, or **Settings → Plugins → zerosub → ZeroSub preferences**) and limits take care of themselves:
   - Only the CLIs' own limit notices trigger a switch. That covers Claude Code's "You've hit your 5-hour limit · resets 3pm" ("session limit" before Claude Code 2.1.312) and Codex's "You’ve hit your usage limit…".
   - Paseo 0.13 and later no longer send the finished turn to plugins, so ZeroSub reads that turn from the agent's timeline instead.
   - A short note in the agent's timeline says what happened.
   - With **Keep going after a switch** on, ZeroSub then sends the agent its follow-up message, unless you've written to it or archived it since the limit stopped it: the follow-up would cut your new turn short.
   - An agent that hits a limit while it's waiting to move to an account you picked moves there, rather than to whichever account has the most room.
   - As a safety stop, one agent changes accounts at most 4 times in 10 minutes. If it hits that, its timeline says so; pick an account from its account button to carry on.
   - An exhausted account is skipped until it resets. If you know it has room again sooner, for example after upgrading or buying credits, press **Mark as available again** (the check mark) on its card. For ChatGPT credits, see [ChatGPT credits](#chatgpt-credits).

### Choose accounts for new agents

Turn on **Spread new agents across accounts** to select an account from its usage. For ChatGPT agents, ZeroSub prefers an account when its weekly limit resets within one day and both limits have at least 20% left. Usage for every available account must be complete and less than 30 minutes old. Otherwise, ZeroSub selects the account with the most room. Claude agents use the account with the most room. An account that has used 80% of its 5-hour window counts as having less room than any account under that, so new agents don't land on an account that's about to run out; an account whose window has reset since its last reading counts by what it has left. Automatic switching picks the account to move to the same way. When a near weekly reset was the reason, the agent's account menu says **Started here: weekly reset was near**. Existing agents stay on their accounts.

### Pick the account in a new agent's message box

On Paseo 0.16 and later, the message box of an agent that doesn't exist yet has an **Account** control: in a new agent's tab and on the New workspace screen. Both the app and the host need Paseo 0.16: the choice travels in the new agent's metadata, which an older host doesn't take, so with one the control isn't shown. Like the account button, it shows once the provider has more than one account, and the account button's preference turns it off too.

- The first choice names no account, and says where the agent starts then: on the default, on the account picked for the next new agent, or, as **Automatic**, on the account with the most room (with **Spread new agents across accounts** on, or when the default can't take a new agent).
- Any other choice starts this one agent on that account and keeps it there, as if you had picked it from the agent's account button. It outranks spreading and the next-new-agent pick, which waits for an agent that names no account.
- Only accounts that can take a new agent are listed: none that are signed out or disabled, and none at their limit while automatic switching is on. If the chosen account can't take the agent by the time you send the message, the agent starts where it would have without a choice.

The choice travels in the new agent's metadata as `zerosub.account`, holding the account's ID as in `$PASEO_HOME/zerosub/state.json`. Anything that creates an agent can set it, for example `paseo.agents.create({ …, metadata: { "zerosub.account": "claude-main" } })`. ZeroSub reads it once, when the agent is created.

### Pick the account for the next new agent

A new workspace has no agent yet, so its message box has no account button, and before Paseo 0.16 no **Account** control either. To choose the account of the agent you're about to start there, or of one started from the CLI, another agent or a schedule, use **⌘K → "Next new … agent: use …"** or the **plus-square** button on an account card. The pick goes to the next new agent of that provider this daemon opens, wherever it's started: from any device, the CLI, another agent or a schedule. That agent opens on the picked account, even with **Spread new agents across accounts** on, and new agents after it follow the default again. If by then the account can't take new agents (signed out, disabled, or at its limit with automatic switching on), the pick is used up anyway and the agent starts where it would have without one. Removing, disabling or signing out the account cancels the pick, and a pick no agent takes expires silently after 10 minutes. It doesn't affect agents that already have an account, resumed conversations, background agents, or Paseo's own helpers that write branch names, commit messages and PR text. Choose it again to cancel.

### Claude vs. ChatGPT when switching mid-conversation

- **Claude:** a conversation moves to another account in place. The agent reopens on the new account with its full history and continues.
- **ChatGPT (Codex):** Codex encrypts its reasoning per ChatGPT account, so another account can't read an existing thread. The thread stays on its account. When it hits a limit, or you pick another account for it, ZeroSub carries the task on in its tab for the other account: a **continuation agent** in the same workspace, created on the first visit and reused after that. Switching A → B → A → B keeps two tabs, not four. Independent tasks keep separate tabs, even in the same workspace.
  - A tab you return to gets the instructions and progress since it was last used, and checks the current files and Git diff before going on. Very long instructions are shortened, keeping the first one since the tab was last used (the original request, for a new tab), the latest ones and a note of how many were left out.
  - You can type in any of a task's tabs and switch from any of them. The tab you used last is where the task continues: automatic switches and resets only move that tab, and another tab that hits a limit says in its timeline where the task went.
  - A tab is reused while it is in the same workspace with the same account and permission mode; otherwise ZeroSub starts a new one. While one of the task's tabs is working or asking for permission, a switch you pick is refused until it stops, and an automatic switch leaves the task where it is and says so in its timeline.
  - A sub-agent (one another agent started) keeps its parent: its new tab goes under the same agent, or under the tab where that agent's own task now continues. Like the first tab, it's archived with the parent and sends no notifications of its own. Paseo doesn't tell the parent when the new tab finishes, though: it only reports to an agent on agents it started or prompted itself.
  - ZeroSub never sends a hand-off twice. If a lost connection leaves one unconfirmed, the switch stops and names the tab to check. Continuation agents from earlier versions are picked up on the first switch. New Codex agents simply start on the chosen account.

### Keep a Codex chat in the same conversation (optional)

Off by default. Turn on **Keep a Codex chat in the same conversation** for two ChatGPT accounts that are members of one workspace (`chatgpt|<workspace>|<email>`). A usage limit then reloads the same agent on the other account. That tab is the only one writing the thread: ZeroSub does not resume it from a second tab. Before the reload, it checks that the other account's home links `sessions/` to the same session directory. A plain `sessions` folder does not count. On Windows a failed junction is only a warning, and that account keeps the new tab.

These still open a new tab:

- the option is off
- the accounts are in different workspaces
- an account is known only as `chatgpt-email|…`
- the limit says the workspace is out of credits
- the other home does not link `sessions/`
- the first turn after the switch fails because the thread cannot be decrypted or resumed (`invalid_encrypted_content`, `organization_id mismatch`)

That last failure puts the agent back on the previous account, in the same write as its continuation record, and opens today's continuation tab.

On 2026-11-15, my fork continued one conversation from member A to member B of the same workspace on macOS 27.0.1 with Codex 0.167.0. That hop was a workspace credit limit, which this option still opens in a new tab. The run did not cover a second workspace or an email-only identity.

### Banked resets

Some plans come with banked limit resets: ChatGPT's reset credits, and Claude Code's limit resets. When an account has any, its card shows how many are banked and when they expire, with a **Use reset** button. When an agent is stopped by a limit, its account button offers the reset too, and the agent carries on afterwards.

- A reset can't be undone, so ZeroSub always asks first and says what it refills. Asking again while one is still being used, or within five minutes of one, doesn't spend another.
- **ChatGPT** uses Codex's own reset-credit API, the same one as `/usage` → reset in the Codex CLI. It never spends a credit while nothing is used up.
- **Claude** uses Claude Code's limit-reset endpoint. Anthropic decides which accounts get resets; so far it reports the tested accounts as not eligible, so the button may not appear for Claude. It shows up by itself once an account has a reset.
- **Use banked resets when every account is out** (off by default) spends one automatically, but only when every account of that provider is at its limit and the provider confirms the limit at that moment.

### ChatGPT credits

A ChatGPT account can also have prepaid ChatGPT credits, which Codex spends once the account reaches its limit. They aren't the reset credits above. The card shows them under the usage bars, for example "57,714 ChatGPT credits left", and an agent's account button shows them next to the account's usage.

- By default, an account at its limit is skipped until it resets, credits or not, so new agents use the free room on your other accounts first. That room is lost at each reset; credits aren't. **Mark as available again** only lasts until the next usage reading, which still shows the limit reached.
- **Use ChatGPT credits when a limit is reached** (off by default; in Accounts, or **Settings → Plugins → zerosub → ZeroSub preferences**) keeps an account with credits in use at its limit. New agents may then spend paid credits even while another account still has room.
- Even with it on, a limit an agent actually ran into stays until it resets: Codex stopped that agent, so the credits didn't cover it.

### Claude extra usage

When a Claude account has extra usage turned on (pay-as-you-go past the plan's limits), its card says so under the usage bars, with this month's spend and cap when Anthropic reports them, for example "Extra usage on · $12.34 of $50.00 this month". This is for information: ZeroSub still treats a full window as a limit and switches the same way.

### When every account of a provider is out

ZeroSub tries these in order, and a timeline note says which one happened.

1. **Use a banked reset**, if you turned on **Use banked resets when every account is out**.
2. **Move to a paid API account** with room, if you turned on **Use paid API accounts when every subscription is out**: an [Azure OpenAI account](#azure-openai-accounts) for a ChatGPT agent, an [AWS Bedrock account](#aws-bedrock-accounts) for a Claude agent, as it would to another account of its provider. A free reset always goes first: both are billed per token. A Claude agent moves back once a subscription account has room.
3. **Fork the chat to the other provider**, if you turned on **When every account is out, fork the chat to the other provider** (off by default). A stopped Claude chat continues in a new ChatGPT agent, or the other way round:
   - The new agent opens in the same workspace (under the same parent, for a sub-agent) with the conversation so far and goes straight back to work. If that conversation began as a hand-off itself, only the start and end of the earlier one are quoted. It uses the other provider's default model and its account with the most room left.
   - **OpenCode instead:** in the settings under the fork switch, **Fork a stopped Claude chat to** can point at **OpenCode** rather than ChatGPT. A stopped Claude chat then continues on this host's OpenCode, using the model and thinking option picked there from OpenCode's catalog (or the host's default when the host marks one). OpenCode is a harness, not an account provider: the fork uses no ZeroSub account, and nothing is added to your accounts. If the saved model or thinking option is no longer in the host's catalog, the fork is refused with a note rather than falling back to another model.
   - On ChatGPT the fork gets a mode no looser than the original's. Bypass becomes Full Access, and Accept File Edits becomes Default Permissions. Codex has no read-only or ask-first mode, so a Claude agent in Plan Mode or Always Ask isn't forked to ChatGPT. On OpenCode the fork gets Plan (for a Claude agent in Plan or Default mode) or Build, under the host's own permission policy, where Build edits files and runs shell without asking. That can allow more than the original's Claude mode; hosts that want it tighter can restrict `permissions` in their `opencode.jsonc`. Choosing OpenCode as the destination is the opt-in.
   - The original agent stays as it was, and prompting it again while its provider is still out points to the same fork rather than starting another.
   - With the option off, a stopped agent's account button offers **Continue on ChatGPT (new agent)…** (or Claude) instead, with a confirmation.
   - By hand, a stopped Claude chat can also continue on OpenCode at any time: its account button offers **Continue on OpenCode (new agent)…**, with or without the automatic fork turned on, using the OpenCode model and thinking option picked in the settings.
4. **Stop and say so**, with the time the account frees up.

## Azure OpenAI accounts

A ChatGPT (Codex) account can also be an Azure OpenAI resource with its API key: Codex agents then run on your Azure deployments, billed per token by Azure, and ZeroSub manages the account like any other.

**Add one.** Under ChatGPT (Codex), click **Add account → Azure OpenAI (API key)** and enter:

- **Name**, as for any account.
- **Endpoint**: your resource's v1 API, `https://<resource>.openai.azure.com/openai/v1`. It must be `https://`. A trailing slash is dropped, and a bare resource URL (or one ending in `/openai`) gets `/openai/v1` added.
- **API key**: Key 1 or Key 2 of the resource.

There's no sign-in. ZeroSub checks the key by listing the endpoint's models (`GET {endpoint}/models` with an `api-key` header) from the daemon, only when you add the account or change its endpoint or key. A refused key (HTTP 401/403) isn't saved. If the endpoint can't be reached, or answers otherwise, the account is saved anyway and a warning says so. The key button on its card changes the endpoint, the key (empty keeps it; a new endpoint needs the key typed again) and the price table. Removing the account deletes its home, key included, and its token counts. Like any ChatGPT account, it can't be removed while ChatGPT conversations still run on it.

**Models.** Your Azure deployments must be named after the models (`gpt-5.1-codex`, say): the model Paseo picks for the agent is sent as the deployment name, unchanged.

**When it's used.** It's billed per use, so by default ZeroSub never moves work onto it by itself, like any API-key account:

- Pick it for an agent (the account button, `/account <name>`, the next-new-agent pick), or make it the default; then new agents start on it.
- Automatic choices (failover at a limit, **Spread new agents across accounts**, a default that's out, **Fork the chat to the other provider**) skip it.

Turn on **Use paid API accounts when every subscription is out** (off by default; in Accounts, or **Settings → Plugins → zerosub → ZeroSub preferences**) to let it take over as a last resort:

- Automatic choices then use it only when every ChatGPT subscription account is at its limit, disabled or signed out. A ChatGPT agent that hits its limit first spends a banked reset if **Use banked resets when every account is out** is on and one can be spent; otherwise it carries on in its continuation tab on Azure, as it would on another ChatGPT account, and its timeline says it moved to Azure OpenAI, a paid API, because every subscription account is out. A stopped Claude chat forked to ChatGPT (**Fork the chat to the other provider**) can likewise land on Azure when no ChatGPT subscription has room, and its note says so; a fork to OpenCode uses no ZeroSub account, so Azure plays no part there.
- With **Use banked resets when every account is out** on too, a new ChatGPT agent (a fork from Claude included) opens on a subscription account at its limit rather than on Azure when that account's latest reading shows a banked reset it can use now, so its first turn spends the reset. Only when no reset can be spent does a new agent start on Azure.
- Once a subscription account has room again, new agents go back to it. Agents already on Azure stay there, like any ChatGPT conversation.

Either way, Azure has no 5-hour or weekly limits, so the account counts as available unless Azure turns a turn down. A rate limit (HTTP 429) sets it aside for a minute, or for as long as Azure's "retry after" says (10 minutes at most); an exhausted quota (`insufficient_quota`) for 30 minutes. Only a failed turn is read for these: a turn that finished can carry another service's errors in its warnings (an MCP server's "HTTP 401 Unauthorized", say), and they never touch the account. When a failed turn looks like a refused key (401/403), ZeroSub asks Azure about the key first, and marks the account signed out until you fix the key only if Azure refuses it too; if Azure can't be reached to ask, the account is left as it is.

**Where the key is.** Only in the account's home, `$PASEO_HOME/zerosub/homes/codex-<id>/azure.json` (with the endpoint and prices), readable only by you. Unlike Claude and Pi accounts' folders, an Azure account's home stays in `homes/`, managed by ZeroSub: it's never moved out or given a terminal script, and removing the account deletes it, key and all, once no open agent uses it. (**A folder that's signed in already** is for Claude Code folders: to add an Azure account back, enter its key again.) `azure.json` is never linked into or out of any Codex home. The registry marks the account as Azure and keeps a short hash of the key, to spot the same key added twice; the app only ever gets its last four characters; ZeroSub never logs it.

**How it runs.** The home is a Codex home like any added account's: sessions, `AGENTS.md`, skills and the rest are links to `~/.codex`, and there's no `auth.json`. Its `config.toml` is its own: a copy of `~/.codex/config.toml` with `model_provider = "zerosub_azure"` put first (a top-level `model_provider` there is taken out) and this table added at the end:

```toml
[model_providers.zerosub_azure]
name = "Azure OpenAI"
base_url = "https://<resource>.openai.azure.com/openai/v1"
env_key = "ZEROSUB_AZURE_OPENAI_API_KEY"
wire_api = "responses"
```

It's remade whenever `~/.codex/config.toml` has changed, checked each time a session opens on the account. When Paseo opens a session there, ZeroSub sets `CODEX_HOME` to the home and `ZEROSUB_AZURE_OPENAI_API_KEY` to the key, read from `azure.json` right then; Codex sends it as `Authorization: Bearer`, which Azure's v1 API accepts.

**Usage.** In place of usage bars, the card shows the tokens used this calendar month (UTC): input (with how much of it was cached) and output, and an estimated cost. At the end of each turn on the account, ZeroSub reads the agent's Codex session file (`~/.codex/sessions/…/rollout-…-<thread>.jsonl`) and adds what the thread used since it was last counted. Totals are kept by model in `$PASEO_HOME/zerosub/api-usage.json` and start again each month. The cost comes from the price table in the account's settings (USD per million input, cached input and output tokens, per model; cached input without a price counts at the input price). With no prices it says "cost unknown". It's an estimate from Codex's own counts, not Azure's bill.

**Limitations.**

- A `profile` in `~/.codex/config.toml` that sets its own `model_provider` still wins over the Azure provider, as it would in Codex. An inline `model_providers = { … }` table isn't changed. What Codex itself writes to `config.toml` while running on the account (a project's trust level, say) goes to the generated copy and is lost when it's remade: set it in `~/.codex/config.toml`.
- The key reaches Codex through the session's environment, which Paseo starts the agent with; anything that can read that process's environment can read it.
- Token counts need the Codex session file. A turn whose file isn't found (a thread whose file is more than 120 days of folders back, or a Codex that keeps sessions elsewhere) is counted as "couldn't be counted", and the card says the totals are short. Turns run on the account from a terminal aren't seen.
- ChatGPT conversations can't change accounts, so a task that moved to Azure keeps its Azure tab; new agents go to a ChatGPT account once one has room, not that tab.

## AWS Bedrock accounts

A Claude account can also be Claude Code on Amazon Bedrock in your AWS account: Claude agents then run on Bedrock, billed per token by AWS, and ZeroSub manages the account like any other.

**Add one.** Under Claude, click **Add account → AWS Bedrock** (the same chooser offers a Claude subscription, an API key or token, and a folder that's signed in already) and enter:

- **Name**, as for any account.
- **AWS region**, as a code (`us-east-1`, `eu-central-1`). The form fills it in when the host names one: the daemon's `AWS_REGION` or `AWS_DEFAULT_REGION`, the region of its profile in `~/.aws/config` (or `AWS_CONFIG_FILE`), or, on an EC2 instance, the instance's own (IMDSv2). That's looked up only when the form opens, for at most a second and a half, never at startup.
- **Credentials**, from one of:
  - **Host's AWS credentials**: the AWS default chain where the daemon runs (its environment, `~/.aws`, an EC2 instance or ECS task role). Nothing is stored.
  - **AWS profile**: a profile in the host's `~/.aws/config`. Only its name is stored.
  - **Access key**: an access key ID and secret, with a session token for temporary credentials. Stored in the account's home (see below).
- **Models** (optional): model or inference-profile IDs for `ANTHROPIC_MODEL` and `ANTHROPIC_DEFAULT_OPUS_MODEL`, `ANTHROPIC_DEFAULT_SONNET_MODEL` and `ANTHROPIC_DEFAULT_HAIKU_MODEL`, as enabled in your AWS account. Empty ones keep Claude Code's own Bedrock defaults. Claude Code maps Paseo's own model IDs (`claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5`) to Bedrock by itself, but its built-in defaults for the `opus`, `sonnet` and `haiku` aliases can be older than what your region offers (in `eu-central-1`, `sonnet` pointed at a Sonnet 4.5 profile the region didn't have). If an alias fails there, fill in the Opus, Sonnet and Haiku models with inference profiles your AWS account has, such as `global.anthropic.claude-sonnet-5-5`.

There's no sign-in. If the host has the `aws` command, ZeroSub checks the credentials with it, only when you add the account or change its credentials or region: `aws sts get-caller-identity`, then `aws bedrock list-inference-profiles` in the region. Missing, wrong or expired credentials (or a profile that doesn't exist) aren't saved. Without the `aws` command, offline, or when listing inference profiles is refused, the account is saved anyway and a warning says so; its first turn tells for sure. The key button on its card changes the region, credentials (an empty secret keeps the stored one for the same key ID), models and the price table. Removing the account deletes its home, with its AWS settings (and access key), once no open agent uses it, and its token counts; its agents move to the default account, as from any Claude account.

**When it's used.** It's billed per use, so by default ZeroSub never moves work onto it by itself, like any API-key account:

- Pick it for an agent (the account button, `/account <name>`, the next-new-agent pick), or make it the default; then new agents start on it.
- Automatic choices (failover at a limit, **Spread new agents across accounts**, a default that's out, **Fork the chat to the other provider**) skip it.

With **Use paid API accounts when every subscription is out** on (off by default; the same switch as for [Azure OpenAI accounts](#azure-openai-accounts), in Accounts or **Settings → Plugins → zerosub → ZeroSub preferences**), it takes over as a last resort:

- Automatic choices then use it only when every Claude subscription account is at its limit, disabled or signed out. A Claude agent that hits its limit moves to another Claude subscription account with room first, then spends a banked reset if **Use banked resets when every account is out** is on and one can be spent; only then does it move onto Bedrock in the same conversation, as it would to another Claude account, and its timeline says it runs on AWS Bedrock, a paid API, because every subscription account is out.
- With **Use banked resets when every account is out** on too, a Claude subscription account at its limit whose latest reading shows a banked reset it can use now goes before Bedrock: a new agent opens on it, and an agent already on it stays there when it resumes or the 30-second check runs, so its next turn spends the reset. Only when no reset can be spent does an agent start on, or move to, Bedrock.
- It isn't pinned there. Once its own account, or another Claude subscription account, has room again (or, with **Use banked resets when every account is out** on, one has a banked reset to spend), the 30-second check moves it back, and its timeline says so. New agents go back to a subscription account then too. A ChatGPT chat continued on Claude (**Fork the chat to the other provider**, or **Continue on Claude (new agent)…** from the account button) that lands on Bedrock is held there the same way: it moves to a Claude subscription account once one can take it. Only an agent you put on Bedrock yourself (picked for it, or Bedrock as the default) stays; when you change the default away from Bedrock with **Move open agents when the default changes** off, its open agents stay on Bedrock as your pick.

**Claude's Auto mode.** Paseo won't start a turn in Claude's Auto mode, its default Claude mode, on Bedrock ("Claude Auto mode requires the Anthropic API"). So ZeroSub never moves an agent in Auto mode onto Bedrock by itself (failover, a new or resumed agent, the 30-second check, a fork from ChatGPT), nor one whose mode Paseo doesn't say, and the agent's timeline says why when that leaves it at its limit: switch it to another mode (Accept File Edits, say) to let it move. An Auto-mode agent put on Bedrock by hand or as the default gets Paseo's refusal; ZeroSub notes in its timeline to pick another mode, and leaves the account as it is.

Either way, Bedrock has no 5-hour or weekly limits, so the account counts as available unless AWS turns a turn down. What's read for that is a failed turn's failure and error rows, and Claude Code's own error replies ("API Error: …") among the turn's last two replies, whether the turn failed or completed (Paseo before 0.16 reports such a turn as completed), never an agent's reply that only mentions one. A completed turn's warnings, error rows and tool output (an MCP server's "HTTP 401 Unauthorized", an `AccessDenied` from a command the agent ran) are another service's, and never touch the account.

- Throttling (`ThrottlingException`, HTTP 429, "Too many tokens") sets it aside for a minute; an exceeded service quota (`ServiceQuotaExceededException`) for five. While every Claude subscription account is out too, its agents stay on it rather than go back to one at its limit, and the agent that was turned down says every account is at its limit.
- Refused credentials or access (`AccessDeniedException`, HTTP 401/403, an invalid or expired security token, no credentials found): ZeroSub checks the credentials again first, as when they're saved (`aws sts get-caller-identity`, then `aws bedrock list-inference-profiles`). Only if AWS refuses them too is the account marked signed out, with AWS's answer on its card, until you change its settings. If they pass, or can't be checked (no `aws` command, AWS can't be reached), the account stays usable and the daemon's log says so.
- A model Bedrock names as unusable ("You don't have access to the model with the specified model ID", "The provided model identifier is invalid", a model that needs an inference profile) marks it signed out the same way without that check: only Bedrock words it so, and the credentials are fine. Change the model overrides in its settings.
- A model Claude Code finds missing in the account's region ("The model … is not available on your bedrock deployment") leaves the account as it is: other models still run there. The agent's timeline names the model and says to set the model overrides (see **Models** below) or pick another model for the agent.

**Where the credentials are.** The region, credential source, profile name, model overrides and prices are in the account's home, `$PASEO_HOME/zerosub/homes/claude-<id>/bedrock.json`, readable only by you; for an access key, so are the key ID, the secret and the session token. Unlike other Claude accounts' folders, a Bedrock account's home stays in `homes/`, managed by ZeroSub: it's never moved to `~/.claude-config` (or the folder picked under the Claude accounts) and gets no terminal script, since its access key reaches Claude Code only in the session's environment; removing the account deletes it, `bedrock.json` and all. **A folder that's signed in already** turns down a folder with a `bedrock.json`: to add a Bedrock account back, add it again with **AWS Bedrock**. `bedrock.json` is never linked into or out of any Claude home. The registry marks the account as Bedrock (`provider: "bedrock"`; a Claude API-key account has no such mark and keeps its own form) and keeps its region and source, an access key by a short hash of its ID. The app only ever gets the key ID's last four characters; ZeroSub never logs a secret, and leaves it out of what the `aws` command says when it's shown.

**How it runs.** The home is a Claude home like any added account's: shared entries are links to `~/.claude`, and there's no sign-in in it. When Paseo opens a session there, ZeroSub sets `CLAUDE_CONFIG_DIR` to the home, `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION` and `AWS_DEFAULT_REGION`, and blanks what would send it elsewhere or sign it in another way (`ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_OAUTH_TOKEN`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_CUSTOM_HEADERS`, the Vertex and Foundry switches). By source:

- Host: the daemon's own AWS variables are left as they are.
- Profile: `AWS_PROFILE` is set, and `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_SESSION_TOKEN` and `AWS_BEARER_TOKEN_BEDROCK` are blanked, since they'd come before it.
- Access key: those three are set from `bedrock.json`, read right then, and `AWS_PROFILE` and `AWS_BEARER_TOKEN_BEDROCK` are blanked.

The model variables are set from the overrides, or blanked so a model named for your subscriptions doesn't reach Bedrock. Its generated `settings.json` is `~/.claude/settings.json` with the account's own `settings.account.json` on top, as for any added account, then made to agree with that environment: the same `env` (never a secret), no `apiKeyHelper`, and, unless it uses the host's credentials, no `awsAuthRefresh` or `awsCredentialExport`. A proxy set for the account with the globe button stays in it.

**Usage.** In place of usage bars, the card shows the tokens used this calendar month (UTC): input (with how much was read from and written to the cache) and output, and an estimated cost. At the end of each turn on the account, ZeroSub reads the agent's Claude Code session file (`~/.claude/projects/<project>/<session>.jsonl`, which every Claude account shares) and adds the assistant messages written since the turn started, each one once. Totals are kept by model in `$PASEO_HOME/zerosub/api-usage.json`, with Azure's, and start again each month. The cost comes from the price table in the account's settings (USD per million input, cache read, cache write and output tokens, per model as Claude Code names it; a cache read or write without a price counts at the input price). With no prices it says "cost unknown". It's an estimate from Claude Code's own counts, not AWS's bill.

**Limitations.**

- An access key reaches Claude Code through the session's environment, which Paseo starts the agent with; anything that can read that process's environment can read it. Use the host's credentials or a profile to keep it out of ZeroSub's files.
- Project settings (`.claude/settings.json` in a repository) that set another provider or AWS credentials still apply on top, as they would in Claude Code.
- Token counts need the Claude Code session file. A turn whose file isn't found is counted as "couldn't be counted", and the card says the totals are short. Turns run on the account from a terminal aren't seen.
- The check covers the credentials, not each model: a model your AWS account hasn't enabled in the region shows up as a refusal on its first turn.

## Pi accounts

Paseo's built-in **Pi** agents get a section of their own once [Pi](https://github.com/earendil-works/pi) is installed where the daemon runs. Its first card is Pi's own login, `~/.pi/agent` (or `PI_CODING_AGENT_DIR` in the daemon's environment), with whatever it's signed in to. ZeroSub changes its files only when you edit its key or proxy on that card (see below; otherwise it only makes the directory and its `sessions` folder if they're missing, for added accounts to share), and a Pi agent on it runs as Paseo would run it without ZeroSub. Nothing else changes for Pi until you add an account: no scripts, no folders outside ZeroSub's own, no address checks. **Add account** under Pi adds an Anthropic API key as an account, each with:

- **Anthropic API key**, sent as `x-api-key`.
- **Base URL** (optional): a gateway that speaks Anthropic's API. Empty uses `https://api.anthropic.com`, even when Pi's own `models.json` sends Anthropic's requests somewhere else.
- **Proxy** (optional): every request its Pi agents make goes through it, Anthropic's and any other provider's alike. Change it later with the globe button on its card. The card shows the address Anthropic sees the account's requests come from (`IP: 203.0.113.7 (US)`), from Anthropic's `cdn-cgi/trace` fetched through its proxy when it's set: when the account is added or its proxy changes, and every half hour after. Only added accounts are checked, and not one with another base URL; Pi's own login never is.

Pick an account for a Pi agent from the agent's account button or with `/account`, or make it the default. ZeroSub never moves agents onto a Pi account by itself, the CLI login included, since either may be billed per use: "Balance new agents" leaves new Pi agents on the default, and an agent whose key is refused stays where it is until you pick another account. A Pi agent moves between accounts in place: Pi reopens its session file on the other key. Pi doesn't report usage, so Pi accounts have no usage bars, banked resets or automatic switching, and they're never forked to another provider.

The key button on Pi's own login card changes the Anthropic API key and base URL that login uses, in Pi's own `auth.json` (`anthropic`; an Anthropic sign-in made with `/login` is replaced by the key) and `models.json` (`providers.anthropic.baseUrl`), so `pi` in a terminal uses them too. The globe button there sets its proxy as `httpProxy` in Pi's `settings.json`, which Pi reads itself: ZeroSub still adds nothing to that login's agents. Each file is written where it really is (through a link to it), keeping the rest of it, under Pi's own lock on it, after a copy of it as it was goes to `$PASEO_HOME/zerosub/backups/` (the last five of each, readable only by you); a file that ends up holding a key or a proxy password is readable only by you. Leaving a key empty keeps it, a kept key only goes to the base URL it went to before, and a proxy is refused where a key or sign-in of the login's, for Anthropic or another provider, would go through it over plain `http://`: one in `auth.json`, in `models.json` (read as Pi reads it, comments and all) or in the environment, sent to the provider's base URL or one of its models'.

How it works:

- Each account has an agent directory of its own, which its agents get as `PI_CODING_AGENT_DIR`. It's set up in `$PASEO_HOME/zerosub/homes/pi-<id>`, then kept in `~/.pi-config/pi-<account>` (`ZEROSUB_PI_DIR` in the daemon's environment moves the default), beside its terminal script. The folder button under the Pi accounts picks another folder, and the accounts move there one at a time.
- A folder only moves while no Pi process runs with it as `PI_CODING_AGENT_DIR` (on macOS ZeroSub reads `ps -E`, on Linux `/proc`), no agent was routed to it in the last 30 seconds, and ZeroSub itself isn't working on it. Nothing waits for a move: a session that opens on the account, or anything ZeroSub does on it, while the folder is being moved makes the move give way (the folder goes back, and it's tried again at a later check), and once a move is saved new sessions get the new folder. A session that opens while the folder is away from both places opens on Pi's own login instead, never on the account without its proxy. Each move is written down first, so one a restart cut short is finished, or undone, at the next check. If Pi makes the old folder again meanwhile (a terminal running the old script, say), so the folder can't go back, the move is finished at the next check to the folder that has the account's key, and the one Pi made is left for you to delete.
- Everything in Pi's own directory (settings, extensions, skills, prompts, sessions and the rest) is linked in, except Pi's sign-ins (`auth.json`), `models.json` and its model catalog cache (`models-store.json`).
- The account's key, base URL and proxy are in its folder's `zerosub.json` (readable only by you); the registry keeps only a short hash of the key. `auth.json` is made from it and Pi's own: the account's key for Anthropic, plus the API keys Pi's login keeps for other providers. Pi's subscription sign-ins (`/login`, OAuth) aren't copied, because each copy would refresh its token on its own and leave the other with a spent one: models that need one stay on Pi's login. Pi reads a stored key as config (a value starting with `!` is run as a command, and `$NAME` is filled in from the environment), so the account's key is written escaped (`$` as `$$`, a leading `!` as `$!`) and Pi reads it exactly as you typed it. Pi uses a stored key before one in the environment, and the account's agents get `ANTHROPIC_API_KEY`, `ANTHROPIC_AUTH_TOKEN` and `ANTHROPIC_OAUTH_TOKEN` blanked anyway, so nothing from the daemon's environment goes to the account's base URL in its place. So are `ANTHROPIC_CUSTOM_HEADERS`, whose headers the Anthropic SDK adds to every request (an `x-api-key` line there would replace the account's key), and the workload identity federation variables (`ANTHROPIC_FEDERATION_RULE_ID`, `ANTHROPIC_ORGANIZATION_ID`, `ANTHROPIC_IDENTITY_TOKEN_FILE`, `ANTHROPIC_SERVICE_ACCOUNT_ID`, `ANTHROPIC_WORKSPACE_ID`), which Pi would use for a token when no key comes out. `models.json` is Pi's own with Anthropic's base URL set to the account's, and any other key, headers, or a model's own `baseUrl` or `headers` for Anthropic left out, so no model carries the account's key to wherever Pi's own login sends it. Both are remade every 30 seconds and before an agent opens on the account, so don't edit them, or run `/login` with that directory.
- Agents on an account keep their sessions in the folder Pi's own login uses for that project (`~/.pi/agent/sessions/--<project path>--`, given as `PI_CODING_AGENT_SESSION_DIR` unless the daemon, the Pi provider's `env` or Pi's settings set a sessions folder already), so `pi --resume` finds them, and Paseo still resumes them after the account is removed.
- An account's proxy goes to its agents as `https_proxy`, `HTTPS_PROXY`, `http_proxy` and `HTTP_PROXY`, which Pi puts before its `httpProxy` setting, with `no_proxy` and `NO_PROXY` set to the list they'd otherwise have minus anything that would send Anthropic's or the base URL's traffic around it, plus `localhost`, `127.0.0.1` and `::1`. An account without one gets no proxy variables from ZeroSub: it uses the daemon's network, or `httpProxy` in Pi's settings, as Pi would. An added account's proxy is also written as `httpProxy` in a `settings.json` of its folder's own, made from Pi's with `httpProxy` on top (a link to Pi's again once the proxy goes), so `pi` started with that folder elsewhere goes through it too, unless its environment names a proxy. A kept key is never sent somewhere new: changing the base URL takes the key again, and so does a new proxy for an account whose base URL is plain `http://` to another machine (the proxy could read the key); remove and add that account again with both. Typing the key yourself is what allows it: the guard keeps a saved key from being sent somewhere new by someone who only sees its last characters, so a key typed together with a plain `http://` base URL and a proxy is used as given (the form warns about plain `http://`). A proxy is also refused while Pi's own `models.json` sends another provider's API key (which every account gets, stored or from the environment) over plain `http://` to another machine. Clearing an account's own proxy is refused the same way when its key goes over plain `http://` and the CLI login's proxy would then carry it. While a following account's folder is being moved, a new proxy for the CLI login is refused until the move is done; try again in a moment.
- Pi extensions are shared with every account, and one can still change where Anthropic's requests go after `models.json` is read (`pi.registerProvider("anthropic", { baseUrl })`, say): the account's key then goes there too. Only install extensions you trust with your keys.
- Anthropic refusing an account's key (`authentication_error`) marks it signed out; **Fix key** on its card takes a working one.
- Each account gets a script, `~/.pi-config/pi-<account>.sh`: put `~/.pi-config` on your `PATH` (the line to add is under the Pi accounts) and run `pi-work.sh`. It sets the account's `PI_CODING_AGENT_DIR`, reads the proxy variables its agents get in Paseo, and the same blank `ANTHROPIC_*` key, custom header and federation variables, from `zerosub.env` in its folder (ZeroSub keeps it up to date), so they win over what your shell exports, and runs `pi`. Scripts follow renames; ZeroSub never overwrites one it didn't write, and several daemons can share the directory.
- Removing a Pi account kept outside `homes/` only takes it out of ZeroSub: its folder, key and script stay (the script's second line then says ZeroSub no longer manages it). Add it back with **Add account → A folder set up already** and its folder's path: it comes back with its key, base URL and proxy, named after the folder. One still in `homes/` goes on the cleanup list, and the cleanup pass deletes it, key and all, once no open agent uses it. Pi accounts can't be disabled, since no other Pi account would stand in for one: make another the default or remove it instead.

Tested on macOS with Pi 1.4.0 and Paseo 0.15.0.

## Grok accounts

Grok is optional, like Pi. Nothing about it shows until a Paseo provider runs Grok Build's agent, `grok agent stdio` (as Paseo's own Grok entry does), and `grok` runs where the daemon runs, or until you've added a Grok account. Without the `grok` CLI you see no Grok section and no warning. Its first card is Grok's own login, `~/.grok` (or `GROK_HOME` in the daemon's environment), and agents on it run as Paseo would run them.

- **Add account** under Grok runs `grok login` for a new account. In a browser on the host's own computer, the page finishes by itself. Anywhere else, choose **Use a code instead**: open the page on any device and confirm the code ZeroSub shows.
- **Each conversation stays on its account.** Pick an account for a new Grok agent from its account button, with `/account` or the next-new-agent pick, or make it the default. Once an agent has a conversation, it stays on the account it started on, as ChatGPT conversations do, but without a hand-off: to use another account, start a new agent. Changing the default doesn't move existing conversations.
- **Usage is deferred.** ZeroSub runs Grok's own `grok usage --json` with the account's home, but does not interpret successful JSON until the CLI's real supported-route format is verified. The card stays unavailable and directs you to `/usage` inside Grok; timeouts and known CLI errors still say why.
- **No automatic switching yet.** ZeroSub doesn't watch Grok's turns for limits or sign-outs, so it never moves a Grok agent by itself. There are no banked resets for Grok, and Grok chats are never forked to another provider.
- An account that still has Grok conversations on it can't be removed until you archive them.

How it works:

- A provider counts as Grok when it extends `acp` and runs `grok` (by path, or `grok-<version>`) with `agent … stdio`. One that joins a shared leader (`--leader`), is disabled, or brings its own login or endpoint in its `env` (`GROK_HOME`, `GROK_AUTH`, `GROK_AUTH_PATH`, the Grok API-key variables, external-provider variables, OIDC variables, `GROK_DEPLOYMENT_KEY` or `GROK_CLI_CHAT_PROXY_BASE_URL`) is left exactly as configured.
- Each added account has its own home in `$PASEO_HOME/zerosub/homes/grok-<id>`, which its agents get as `GROK_HOME`, with `GROK_AUTH_PATH` set to its `auth.json`. Known daemon-level Grok login, API-key, external-provider, OIDC, deployment-key and chat-proxy overrides are blanked for managed homes, so an account's agents don't fall back to another login, key or endpoint.
- The home keeps the account's own files: its sign-in (`auth.json`, and `mcp_credentials.json` for MCP servers), what Grok fetched for it (`settings_cache.json`, `models_cache.json`, `experiments_remote_opt_out`, a team's `managed_config.toml` and `requirements.toml`), and the running processes' locks, sockets, leader and logs. Everything else is linked to `~/.grok`, including `config.toml`, `sessions/`, memory, skills and plugins.
- ZeroSub reads who is signed in (email, user and team) from the home's `auth.json`, never its login itself.

Built against Grok 1.0.77 and Paseo 0.15.4 on Linux. A separate daemon verified two real logins running concurrently, next-agent and default routing, historical-session pinning across a reload, and the removal guard. Successful plan-usage JSON, quota exhaustion and removal after archival remain unverified.

## Cursor accounts

Cursor is optional too, and Linux only for now. Nothing about it shows until a Paseo provider runs Cursor's agent, `cursor-agent acp` (as Paseo's own Cursor entry does), and `cursor-agent` runs where the daemon runs, or until you've added a Cursor account. Its first card is `cursor-agent`'s own login, and agents on it run as Paseo would run them.

- **Add account** under Cursor runs `cursor-agent login` for a new account. Open the link ZeroSub shows in a browser on any device, including your phone, and sign in; there's no code to type.
- **Linux only.** On macOS `cursor-agent` keeps its login in the Keychain (or `~/.cursor/auth.json`), and on Windows under `%APPDATA%`. Giving an added account a login of its own there means moving `HOME` or `APPDATA` for the agent, and every tool it runs would get that too, so ZeroSub reports Cursor as unavailable on both and Cursor agents run as Paseo runs them. A variable from Cursor that moves only the login would fix both.
- **Each conversation stays on its account**, as Grok conversations do: pick an account for a new Cursor agent from its account button, with `/account` or the next-new-agent pick, or make it the default. To use another account for a conversation, start a new agent. Changing the default doesn't move existing conversations.
- **No usage yet.** `cursor-agent` has no command that prints plan usage, and ZeroSub doesn't call Cursor's dashboard with an account's login, so the card says usage is unavailable. Check it in Cursor's dashboard.
- **No automatic switching yet.** ZeroSub doesn't watch Cursor's turns for limits or sign-outs, so it never moves a Cursor agent by itself, and Cursor chats are never forked to another provider.
- An account that still has Cursor conversations on it can't be removed until you archive them.

How it works:

- A provider counts as Cursor when it extends `acp` and runs `cursor-agent` (by path too, but not the shorter `agent` alias) with `acp`. One that is disabled, passes `--api-key` or `--endpoint`, or brings its own login, endpoint or folders in its `env` (`CURSOR_API_KEY`, `CURSOR_AUTH_TOKEN`, `CURSOR_API_ENDPOINT`, `XDG_CONFIG_HOME` or `CURSOR_CONFIG_DIR`) is left exactly as configured.
- `cursor-agent` keeps its login in `cursor/auth.json` under `XDG_CONFIG_HOME` (`~/.config`). Each added account has a home in `$PASEO_HOME/zerosub/homes/cursor-<id>` that its agents get as that variable. The agent's tools (git, gh, …) and Paseo's terminals get it too, so the home mirrors your real `$XDG_CONFIG_HOME` (or `~/.config`): every entry is linked into it, and tools read and write their usual settings. Only `cursor/` is the account's.
- With `XDG_CONFIG_HOME` set, `cursor-agent` keeps its settings, chats and ACP sessions in that `cursor/` folder too, instead of `~/.cursor`. So the account's `cursor/` mirrors `~/.cursor` (or `CURSOR_CONFIG_DIR` from the daemon's environment), with everything linked back except the account's own login, `cli-config.json` (it caches who is signed in, the team requests go to and the team's privacy mode) and `statsig-cache.json` (feature flags fetched for the signed-in user, stored with that user's id). Chats, ACP sessions and projects stay shared. A new account's `cli-config.json` starts as a copy of yours without the account's entries, so your model, permissions and sandbox settings carry over.
- `CURSOR_API_KEY` and `CURSOR_AUTH_TOKEN` in the daemon's environment are blanked for added accounts: `cursor-agent` would use either over the account's login and save it in its place. Your CLI login keeps using them, and ZeroSub warns that it does. A `CURSOR_CONFIG_DIR` there is blanked for added accounts too, so they keep their own `cli-config.json`.
- ZeroSub reads who is signed in (email, user and team) from `cursor-agent status --format json`, run with the account's home; it never reads the login file.

Built against cursor-agent 2026.11.13 and Paseo 0.15.4 on Linux. Sign-in up to the printed link, signed-out status and the folder layout were checked against the real CLI, and a separate daemon verified signing in to completion (from a phone) and two accounts running at once. Resuming a conversation on a second account and reaching a plan limit haven't been verified yet.

## Several hosts

Paseo installs plugins per host (daemon), so install ZeroSub on each host whose agents should use it. When more than one host has it, Paseo shows a single **Accounts (ZeroSub)** item with a host picker at the top.

- **Each host has its own accounts, default and preferences**, because the sign-ins live on the machine where the agents run. The Accounts screen and the sign-in dialog name the host they belong to.
- **An agent's account button always belongs to the agent's host**, and its **Manage accounts…** opens that host.
- **Sign the same account in on each host.** ZeroSub never copies sign-ins between hosts. Both providers rotate sign-in tokens, so two machines sharing one token sign each other out. Separate sign-ins of the same account work fine. Limits are per account, so every host sees the combined usage and switches when it runs out.
- **Remote hosts:** phones, and hosts without a desktop, get the code sign-in automatically. For a remote computer that does have a desktop, choose **Use a code instead** unless you're sitting at it.
- **Banked resets refill the account everywhere.** Automatic use re-checks the limit with the provider first, so two hosts can't spend two resets on the same limit.

## How it works

Each added account gets its own credential home under `$PASEO_HOME/zerosub/homes/`:

- Claude uses it as `CLAUDE_CONFIG_DIR`; Codex uses it as `CODEX_HOME`; Grok uses it as `GROK_HOME`; Cursor uses it as `XDG_CONFIG_HOME` (see [Cursor accounts](#cursor-accounts)).
- The CLIs keep each home's login separate: Claude in its own keychain entry (`.credentials.json` on Linux), Codex, Grok and Cursor in their own `auth.json`.
- Everything that isn't account-specific is a symlink back to `~/.claude`, `~/.codex` or `~/.grok`. For Claude that includes `skills/`, `plugins/` and `projects/`; for Codex and Grok, `config.toml`, `sessions/` and more. Codex also shares its thread database through `CODEX_SQLITE_HOME`.
- Claude's `settings.json` isn't a link: it's made from `~/.claude/settings.json` with the account's own `settings.account.json` on top, and what Claude Code saves in that account (`/model`, say) is kept there. That's also where the account's own proxy goes, which you can set when you add it or later with the globe button on its card.
- Claude's `.claude.json` holds the account identity, so each account keeps its own copy. It's seeded from yours, and your MCP servers stay in sync.

A `before("agent.session_open")` hook sets those variables for every session Paseo opens: create, resume, refresh and import. To move a live agent, ZeroSub reopens its session through Paseo's own reload (Paseo 0.16 and later), or with `paseo agent reload` on older versions. The CLI can't find background agents (ones another plugin starts in a background workspace), so on older versions those move the next time their session starts. It never interrupts a running turn; a busy agent moves when its turn ends, even when that turn ends at a limit. On Paseo 0.16 and later, a reload also cancels background work an agent left running after its turn (shells or monitors), so the 30-second check below and moving idle agents off an account at its limit wait for that work to stop. Failover at a limit, which ZeroSub also starts by itself, doesn't, and neither do moves you ask for, since that work can run for hours (a dev server, say). It looks at the agent again just before reloading it, and the moves it starts by itself also wait until nobody has used the agent for a minute, so a message you've just sent isn't cancelled. Only one move of an agent runs at a time. Every 30 seconds it also checks each open agent, and moves one off an account it can't work on (at its limit, signed out, disabled or removed) to the account it's routed to. That catches what no button press moved it for, such as a limit read from usage, and carries out a move that was waiting for a turn that never came. An agent whose account still works isn't moved unasked, even when it's now routed elsewhere (automatic switching turned off, a limit cleared, a move lost when the plugin restarted): its account button shows the move still to come, and it moves when its session next starts or when you switch it. A move that doesn't land isn't tried again for 30 minutes; the agent's timeline says so once, and it moves when its session next starts.

Sessions ZeroSub didn't route run on your CLI login, and it counts them that way: one whose routing failed or took longer than 15 seconds, one opened while ZeroSub was off, and one of a CLI ZeroSub found unavailable where the daemon runs (Cursor on macOS or Windows, with a registry from Linux). The account button then shows the move still to come, which happens when the session next starts, or from the 30-second check once the CLI login can't work. A ChatGPT thread that has history goes back to the account it's pinned to, which holds it; one with no history yet (a new thread, or a hand-off's first open) is pinned to your CLI login instead, where its history is then written. A move ZeroSub started whose reload opened this way counts as not landed. To tell these sessions apart, ZeroSub forgets where an agent ran when the agent closes (Paseo 0.11 and later), and on startup for agents that closed while it was off. An agent that closed and opened again while ZeroSub was off still shows its earlier account until its session next opens.

Paseo stops waiting for a plugin after 30 seconds. Buttons that move agents, use a reset or refresh usage answer within about 20 seconds and leave the rest running: each agent's timeline says when it has switched, and the account's card shows the refilled limits once a reset is done.

Sign-in runs the official CLIs:

- Claude: `claude auth login`.
- Codex: `codex app-server`'s account API.
- Grok: `grok login --oauth`, or `grok login --device-auth` for the code.
- Cursor: `cursor-agent login`.

ZeroSub never implements OAuth itself and never copies credentials between accounts.

## Privacy and security

- Credentials stay in the CLIs' own stores. ZeroSub's registry (`$PASEO_HOME/zerosub/state.json`) holds account names, emails, plans, which agent uses which account, and continuation links with timeline positions. Handoff text stays in the agents' conversation histories; it isn't copied into the registry.
- Every write of the registry also leaves a snapshot in `$PASEO_HOME/zerosub/backups/`, readable only by you: the last 5 writes, then the last one of each of 12 recent hours and 7 recent days, 24 files at most. If the registry is missing, empty, not JSON, or has entries that don't validate (a hand edit gone wrong, say), ZeroSub restores the newest snapshot, keeps the damaged file as `state.json.bad-<time>`, and says so in its log.
- To show Claude usage, ZeroSub reads each account's current access token and calls Anthropic's usage endpoint, the same way Paseo's built-in usage display and `/usage` do. That read includes extra-usage spend; if Anthropic fails to answer it, ZeroSub reads once more without spend, so the usage bars never go missing for it. It never logs or stores tokens and never refreshes them itself. When you refresh usage (the ↻ button beside the title) or use a reset and a token has expired, it runs `claude -p /usage` so Claude Code renews its own sign-in. In the background it does the same at most every 30 minutes per account, and only for a reading that has passed its reset time or an account at its 5-hour or weekly limit. Codex usage comes from `codex app-server`.
- Grok usage invokes only `grok usage --json`, run with the account's home. ZeroSub doesn't call xAI's endpoints, read Grok's tokens, or interpret successful JSON before its CLI contract is verified.
- Cursor usage isn't read at all: ZeroSub doesn't call Cursor's dashboard API or read Cursor's tokens.
- Using a banked reset calls the provider's own reset endpoint with that account's sign-in, and only after you confirm (or turn on automatic use).
- Removing an account moves its agents to the default account, then signs it out (`claude auth logout` / `codex` logout / `grok logout` / `cursor-agent logout`) and deletes its home. This happens once no agent is mid-turn on it. Abandoned sign-ins are cleaned up the same way; one a restart interrupted is deleted only if it isn't signed in.
- ZeroSub only signs out or deletes homes it recorded for cleanup when you removed the account or started the sign-in, never a home just because the registry doesn't list it: a damaged or hand-edited registry may simply be missing accounts. Folders in `homes/` that no account uses are left alone and named in the log at startup.
- An Azure OpenAI account's key is in its home's `azure.json` only (see [Azure OpenAI accounts](#azure-openai-accounts)), and is sent nowhere but its endpoint.
- An AWS Bedrock account's access key, if it has one, is in its home's `bedrock.json` only (see [AWS Bedrock accounts](#aws-bedrock-accounts)), and is handed only to its own sessions and the `aws` command that checks it. The region the Bedrock form fills in is looked up when it opens, never at startup.
- An account that still has ChatGPT conversations on it can't be removed until you archive them or continue them elsewhere, because they can't move. Grok and Cursor conversations can only be archived.
- Your CLI login can't be removed from ZeroSub.

## Limitations

- **MCP servers that use OAuth** (Linear, Notion, …) store their tokens per Claude account, so sign in to them once on each account.
- **Shared settings apply to every account.** If `~/.claude/settings.json` sets an `apiKeyHelper` or API-key `env`, every account uses that key instead of its subscription. Likewise, an `[auth]` command, customer SSO (`[grok_com_config.oidc]`) or a model's own `api_key` in `~/.grok/config.toml` signs every Grok account in the same way.
- **A Grok sign-in set in the daemon's environment** (`GROK_AUTH_PROVIDER_COMMAND`, or `GROK_OIDC_ISSUER` and `GROK_OIDC_CLIENT_ID`) is used by your CLI login only. ZeroSub clears it for added Grok accounts, so one that can only sign in that way may fail to sign in or stay signed in; ZeroSub shows a warning when it's set.
- **Grok conversations can't change accounts yet.** A Grok conversation's history carries encrypted reasoning (Grok has an `encrypted_content_mismatch` error), which may be tied to the account that wrote it. Switching may be allowed later, once resuming a conversation on a second account is verified. Live switches would also likely hit Paseo's 3-second reload timeout for now ([getpaseo/paseo#8267](https://github.com/getpaseo/paseo/issues/8267)).
- **Grok usage is not displayed yet.** Successful plan-level `grok usage --json` output hasn't been captured on a supported route, so ZeroSub deliberately leaves usage unavailable and directs you to `/usage` inside Grok. Grok limits don't move agents (see [Grok accounts](#grok-accounts)).
- **Cursor conversations can't change accounts yet.** Resuming a Cursor conversation on a second account hasn't been verified, so they stay on the account they started on.
- **Cursor accounts are Linux only.** On macOS `cursor-agent` keeps its login in the Keychain or under `HOME`, and on Windows under `APPDATA`. ZeroSub won't move either for every tool an agent runs, so Cursor shows as unavailable there. A variable from Cursor that moves only the login would fix both (see [Cursor accounts](#cursor-accounts)).
- **Cursor usage is not displayed.** `cursor-agent` has no command for plan usage, and ZeroSub doesn't call Cursor's dashboard API with an account's login.
- **A Cursor agent's tools see the account's `XDG_CONFIG_HOME`.** Your `~/.config` entries are linked there, so tools read and change your usual settings. A tool that creates a new folder in `~/.config` while running on an added account creates it in the account's home instead, and a tool that replaces a file at the top of `~/.config` (rather than writing into it) replaces the account's link; the account's copy then stays separate from yours. Likewise, a file `cursor-agent` creates at the top of its own folder while on an added account (rather than inside a shared folder like `chats/`) stays in the account's `cursor/`. Removing the account, or cleaning up a sign-in that didn't finish, deletes the account's home and anything tools created in it. Settings you change later in `cursor-agent`'s own `cli-config.json` (model, permissions) don't reach accounts added before; change them on each.
- **Usage for an idle Claude account** shows the last reading until the account is used again or you refresh usage. If a window in it has passed its reset time, or the account is at its limit, ZeroSub also renews the sign-in in the background to read it again, at most every 30 minutes, so an early reset or one used on another machine shows up too. Anthropic rate-limits its usage endpoint (Claude Code and Paseo read it too), so a reading can be a few minutes old; the card then says when it was taken. Readings are saved in `$PASEO_HOME/zerosub/usage.json`, so they survive restarts.
- **A leftover Claude process after a move.** Rarely, an agent ends up with a second, untracked Claude Code process on the same session, and after a move it can keep running on the account the agent left. This is a Paseo bug ([getpaseo/paseo#9408](https://github.com/getpaseo/paseo/issues/9408), tracked in [#4450](https://github.com/getpaseo/paseo/issues/4450)); ZeroSub doesn't touch processes it didn't start. To check, run `pgrep -af stream-json` and stop an extra process by hand.
- **Password-protected daemons:** `paseo agent reload` can't authenticate. Agents then switch the next time their session starts, not immediately, and their account button and timeline note say so.
- **Imported Codex threads** (`paseo agent import`) are assigned to your CLI login, since that's where standalone Codex sessions come from.
- **Agents in background workspaces** (`paseo workspace create --background`) are left out of the list of agents Paseo gives plugins, so they have no account button: switch one with `/account` in its message box. Each still opens on the account it's routed to, switches when a turn hits a limit and moves off an account you remove, but changing the default, disabling an account and the 30-second check don't move it.
- **ChatGPT device-code sign-in** has to be enabled in ChatGPT → Settings → Security. The browser option works from a browser on the host's own computer.
- Tested on macOS with Claude Code 2.1.280, Codex 0.156.1 and Paseo 0.9.1; Grok accounts are built against Grok 1.0.77 and Paseo 0.15.4 on Linux, Cursor accounts against cursor-agent 2026.11.13 and Paseo 0.15.4 on Linux. Linux should work. Windows is untested.

## Development

```bash
git clone https://github.com/kapybara-org/zerosub.git
cd zerosub
npm install
paseo plugin install "$(pwd)"   # run the working copy

npm run typecheck      # client and server bundles, separately
npm test               # .context guard first, then routing, failover, limit detection, usage, resets, forks
npm run audit:mobile   # no DOM/HTML in client code
paseo plugin reload zerosub
paseo plugin logs zerosub
```

`npm run guard:context` (also runs first inside `npm test`) fails when any tracked or staged path sits under `.context/`, and `npm run guard:history` fails when any commit since `origin/main` contains one. Keep local scratch out of the repository; the guard works on any machine, no local hook needed.

Code layout:

- `client/`: React Native UI (Accounts surface, sign-in modal, composer pill, commands, timeline note).
- `server/`: routing, account homes, Claude, Codex, Grok, Cursor and Pi adapters, failover, Pi account folders and scripts.
- `shared/`: RPC contracts and the view model.

Report problems at [github.com/kapybara-org/ZeroSub/issues](https://github.com/kapybara-org/ZeroSub/issues).

## Uninstall

Remove added accounts from **Accounts** first, so they're signed out. Then run:

```bash
paseo plugin remove zerosub
rm -rf ~/.paseo/zerosub
```
