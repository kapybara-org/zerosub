import type { PluginSurfaceProps } from "@getpaseo/plugin/client";
import { copyText, Icon, Modal, TextInput, useToast } from "@getpaseo/plugin/client/react-native";
import { useCallback, useMemo, useState, type ReactNode } from "react";
import { Text, View } from "react-native";
import { egressText } from "../shared/format";
import { HIDDEN, type AccountView, type StateView } from "../shared/model";
import { addApiAccount, importPiAccount, setAccountProxy, setPiHomesDir, updateApiAccount } from "../shared/rpc";
import { describe, type ZeroSubStore } from "./store";
import { Button, IconButton, useText } from "./ui";

type Theme = PluginSurfaceProps["theme"];

/**
 * Pi accounts: Pi's own login (`~/.pi/agent`), and added accounts, each an Anthropic API key with an
 * optional base URL and proxy in an agent directory of its own. Everything here is only shown for Pi.
 */

function useInputStyle(theme: Theme) {
  return useMemo(
    () => ({
      color: theme.colors.foreground,
      backgroundColor: theme.colors.surface2,
      borderColor: theme.colors.border,
      borderWidth: 1,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 10,
      fontSize: 14,
    }),
    [theme],
  );
}

function Field({ theme, title, children }: { theme: Theme; title: string; children: ReactNode }) {
  const text = useText(theme);
  return (
    <View style={{ gap: 6 }}>
      <Text style={text.strong}>{title}</Text>
      {children}
    </View>
  );
}

/** The card's line about the account: its key and where it goes, its proxy, the address Anthropic sees, its folder and script. */
export function piCardDetails(account: AccountView): string | null {
  if (account.family !== "pi") return null;
  const api = account.api;
  const parts = [
    api ? `Key${api.keyHint ? ` …${api.keyHint}` : ""} · ${api.baseUrl ?? "Anthropic API"}` : null,
    account.proxy ? `Via ${account.proxy}` : null,
    egressText(account.egress),
    account.kind === "managed" && account.home ? `Folder: ${account.home}` : null,
    account.launcher ? `Terminal: ${account.launcher}` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : null;
}

/** Above the Pi accounts: what they are, what a proxy on them reaches, and the way to run them from a terminal. */
export function PiSectionNotes({ theme, state, accounts, store }: { theme: Theme; state: StateView; accounts: AccountView[]; store: ZeroSubStore }) {
  const text = useText(theme);
  return (
    <>
      <Text style={text.small}>
        Each added Pi account is an Anthropic API key, with its own base URL and proxy if you like. Its agents use that key for Claude models and
        share Pi's settings, sessions and other API keys; subscription sign-ins (/login) stay on the CLI login, whose files ZeroSub changes only when you edit its key or proxy on its card.
      </Text>
      <PiProxyNote theme={theme} />
      {state.piLaunchers ? <ShellHint theme={theme} directory={state.piLaunchers} accounts={accounts} /> : null}
      {state.piHomes ? <HomesHint theme={theme} homes={state.piHomes} store={store} /> : null}
    </>
  );
}

/**
 * What a proxy set on a Pi card does and doesn't reach: it goes to the agents ZeroSub routes as
 * environment variables, and to Pi elsewhere as its `httpProxy` setting and through the scripts.
 */
function PiProxyNote({ theme }: { theme: Theme }) {
  const text = useText(theme);
  const points = [
    "Pi agents Paseo starts or reopens on the account get it as https_proxy, HTTPS_PROXY, http_proxy and HTTP_PROXY, ahead of httpProxy in Pi's settings. Every request they make goes through it, Anthropic's and other providers' alike; only localhost, 127.0.0.1 and ::1 stay direct.",
    "Agents already running keep the network they started with until they reopen.",
    "It's also written as httpProxy in Pi's settings: an added account's in the settings.json of its folder, and Pi's own login's in ~/.pi/agent/settings.json once you set one on its card (added accounts without a proxy of their own share it). So pi started anywhere else goes through it too, but only when its environment names no proxy of its own, and a NO_PROXY there can still send Anthropic's requests around it. An account's pi-<account>.sh script sets the same variables as its agents get, so it doesn't depend on that.",
    "An agent whose routing doesn't answer in time (ZeroSub stopped, say) opens without it, on the CLI login.",
    "The IP on a card is the address Anthropic sees through that account's proxy. If this machine already sends everything through a system-wide or TUN proxy, going direct can show the same address, so give each key a proxy with its own exit to tell them apart.",
  ];
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 2 }}>
      <Icon name="Globe" size={16} color={theme.colors.foregroundMuted} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={text.strong}>About proxies on Pi accounts</Text>
        {points.map((point) => (
          <Text key={point} style={text.small}>
            {`• ${point}`}
          </Text>
        ))}
      </View>
    </View>
  );
}

/** The line to put the scripts' directory on `PATH`, and the scripts there. */
function ShellHint({ theme, directory, accounts }: { theme: Theme; directory: string; accounts: AccountView[] }) {
  const text = useText(theme);
  const toast = useToast();
  // Readable when the path needs no quoting, which is nearly always.
  const line = /^[\w./~+@%-]+$/.test(directory) ? `export PATH="${directory}:$PATH"` : `export PATH='${directory.replace(/'/g, "'\\''")}':"$PATH"`;
  const commands = accounts.flatMap((account) => (account.launcher ? [account.launcher] : []));
  const copy = useCallback(async () => {
    try {
      await copyText(line);
      toast.show("Copied", { variant: "success" });
    } catch {
      toast.error("Couldn't copy. Select the text and copy it yourself.");
    }
  }, [line, toast]);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 2 }}>
      <Icon name="SquareTerminal" size={16} color={theme.colors.foregroundMuted} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={text.small}>
          From a terminal on this host: add this line to your shell profile once, then run {commands.length > 0 ? commands.join(", ") : "pi-<account>.sh"}.
          Accounts added later work without changing it. Each runs pi on its account with the proxy its agents use in Paseo, whatever your shell exports.
        </Text>
        <Text selectable style={[text.small, { color: theme.colors.foreground }]}>
          {line}
        </Text>
      </View>
      <IconButton theme={theme} icon="Copy" label="Copy" tooltip="Copy the line for your shell profile" onPress={() => void copy()} />
    </View>
  );
}

/** Where added Pi accounts' folders are kept, and the way to keep them somewhere else. */
function HomesHint({ theme, homes, store }: { theme: Theme; homes: NonNullable<StateView["piHomes"]>; store: ZeroSubStore }) {
  const text = useText(theme);
  const [editing, setEditing] = useState(false);
  return (
    <View style={{ flexDirection: "row", alignItems: "flex-start", gap: 10, paddingHorizontal: 2 }}>
      <Icon name="FolderOpen" size={16} color={theme.colors.foregroundMuted} />
      <View style={{ flex: 1, gap: 4 }}>
        <Text style={text.small}>Each added account keeps its key, proxy and settings in a folder of its own in</Text>
        <Text selectable style={[text.small, { color: theme.colors.foreground }]}>
          {homes.dir}
        </Text>
      </View>
      <IconButton
        theme={theme}
        icon="FolderPen"
        label="Change where accounts are kept"
        tooltip="Keep the accounts' folders somewhere else; they move there"
        tooltipAlign="end"
        onPress={() => setEditing(true)}
      />
      {editing ? <HomesModal theme={theme} homes={homes} store={store} onClose={() => setEditing(false)} /> : null}
    </View>
  );
}

function HomesModal({ theme, homes, store, onClose }: { theme: Theme; homes: NonNullable<StateView["piHomes"]>; store: ZeroSubStore; onClose(): void }) {
  const text = useText(theme);
  const toast = useToast();
  const inputStyle = useInputStyle(theme);
  const [dir, setDir] = useState(homes.isDefault ? "" : homes.dir);
  const typed = dir.trim();
  const changed = typed === "" ? !homes.isDefault : typed !== homes.dir;
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const result = await store.rpc(setPiHomesDir, { dir: typed });
      const moving = result.moving > 0 ? ` · ${result.moving} account${result.moving === 1 ? "" : "s"} move there once nothing runs on ${result.moving === 1 ? "it" : "them"}` : "";
      toast.show(`Pi accounts are kept in ${result.dir} now${moving}`, { variant: "success", durationMs: 5_000 });
      await store.refresh();
      onClose();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setSaving(false);
    }
  }, [typed, store, toast, onClose]);
  return (
    <Modal title="Where Pi accounts are kept" open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={text.muted}>
          {`Now: ${homes.dir}${homes.isDefault ? ", beside the terminal scripts" : ""}. Each added account has a folder of its own there (its PI_CODING_AGENT_DIR), named after it like its script, with its key, proxy and settings; new ones are set up inside ZeroSub's own folder, then moved there.`}
        </Text>
        <Text style={text.muted}>
          Saving another folder moves every account kept here, and any still in ZeroSub's own folder, to it. Each moves once nothing runs on it: a Pi
          agent or a terminal using it holds it back until it stops. Removing an account later only takes it out of ZeroSub; its folder, key and
          script stay.
        </Text>
        <TextInput
          value={dir}
          onChangeText={setDir}
          autoFocus
          maxLength={1024}
          placeholder={homes.isDefault ? homes.dir : "Default, beside the terminal scripts"}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => (changed ? void save() : undefined)}
          style={inputStyle}
          accessibilityLabel="Folder for Pi accounts"
        />
        {error ? <Text style={text.danger}>{error}</Text> : null}
        <View style={{ flexDirection: "row", gap: 8, justifyContent: "flex-end" }}>
          <Button theme={theme} label="Cancel" tooltip="Keep the current folder" tooltipAlign="end" onPress={onClose} />
          <Button theme={theme} tone="primary" label="Save" tooltip="Keep the accounts here" tooltipAlign="end" busy={saving} disabled={!changed} onPress={() => void save()} />
        </View>
      </Modal.Content>
    </Modal>
  );
}

/**
 * A Pi account's key and base URL. Adding asks for a name and optional proxy too; editing keeps the
 * key unless a new one is typed, and the proxy has its own button on the card.
 */
function KeyForm({
  theme,
  store,
  account,
  onDone,
  onCancel,
}: {
  theme: Theme;
  store: ZeroSubStore;
  /** The account being edited; absent when adding one. */
  account?: AccountView;
  onDone(): void;
  onCancel(): void;
}) {
  const text = useText(theme);
  const inputStyle = useInputStyle(theme);
  const editing = Boolean(account);
  const main = account?.kind === "main";
  const current = account?.api ?? null;
  const [label, setLabel] = useState("");
  const [key, setKey] = useState("");
  const [baseUrl, setBaseUrl] = useState(current?.baseUrl ?? "");
  const [proxy, setProxy] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ready = editing ? true : Boolean(label.trim() && key.trim());
  const submit = useCallback(async () => {
    if (!ready) return;
    setSaving(true);
    setError(null);
    try {
      if (account) await store.rpc(updateApiAccount, { accountId: account.id, key: key.trim() || undefined, baseUrl: baseUrl.trim() });
      else await store.rpc(addApiAccount, { label: label.trim(), key: key.trim(), baseUrl: baseUrl.trim() || undefined, proxy: proxy.trim() || undefined });
      await store.refresh();
      onDone();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setSaving(false);
    }
  }, [ready, account, store, key, baseUrl, label, proxy, onDone]);
  const input = (props: { value: string; onChangeText(value: string): void; placeholder: string; label: string; maxLength: number; secure?: boolean; autoFocus?: boolean }) => (
    <TextInput
      value={props.value}
      onChangeText={props.onChangeText}
      maxLength={props.maxLength}
      placeholder={props.placeholder}
      placeholderTextColor={theme.colors.foregroundMuted}
      autoCapitalize="none"
      autoCorrect={false}
      autoFocus={props.autoFocus}
      secureTextEntry={props.secure}
      style={inputStyle}
      accessibilityLabel={props.label}
    />
  );
  return (
    <View style={{ gap: 12 }}>
      {editing ? null : (
        <Field theme={theme} title="Name">
          {input({ value: label, onChangeText: setLabel, placeholder: "e.g. Work key", label: "Account name", maxLength: 40, autoFocus: true })}
        </Field>
      )}
      <Field theme={theme} title="Anthropic API key">
        {input({
          value: key,
          onChangeText: setKey,
          placeholder: current ? `Leave empty to keep the current one${current.keyHint ? ` (…${current.keyHint})` : ""}; needed again for a new base URL` : "sk-ant-…",
          label: "API key",
          maxLength: 4096,
          secure: true,
        })}
      </Field>
      <Field theme={theme} title="Base URL (optional)">
        {input({ value: baseUrl, onChangeText: setBaseUrl, placeholder: "Empty: Anthropic's API · e.g. https://gateway.example.com", label: "Base URL", maxLength: 2048 })}
        {/^http:\/\//i.test(baseUrl.trim()) && !/^http:\/\/(localhost|127\.[\d.]+|\[::1\])(?=[:/]|$)/i.test(baseUrl.trim()) ? (
          <Text style={text.small}>Over http:// the key travels unencrypted. Use https:// unless the gateway is on a network you trust.</Text>
        ) : null}
      </Field>
      {editing ? null : (
        <Field theme={theme} title="Proxy (optional)">
          {input({ value: proxy, onChangeText: setProxy, placeholder: "http://127.0.0.1:7890", label: "Proxy URL", maxLength: 2048 })}
          <Text style={text.small}>Every request its Pi agents make goes through it, Anthropic's and other providers' alike.</Text>
        </Field>
      )}
      <Text style={text.small}>
        {main
          ? "This changes Pi's own ~/.pi/agent/auth.json and models.json, which pi in a terminal uses too (a copy of each as it was is kept in ZeroSub's backups). An Anthropic sign-in made with /login there is replaced by the key. Pi agents started afterwards use it; running ones keep theirs until they reopen."
          : "Billed per use, so ZeroSub never moves agents onto it by itself: it's used only as the default or when you pick it for an agent. The key stays on this host."}
      </Text>
      {error ? <Text style={text.danger}>{error}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
        <Button theme={theme} label="Cancel" tooltip={editing ? "Keep the current settings" : "Close without adding an account"} tooltipAlign="end" onPress={onCancel} />
        <Button
          theme={theme}
          tone="primary"
          label={editing ? "Save" : "Add account"}
          tooltip={editing ? "Save these settings" : "Add this Pi account"}
          tooltipAlign="end"
          busy={saving}
          disabled={!ready}
          onPress={() => void submit()}
        />
      </View>
    </View>
  );
}

/** Adds back a Pi account from the folder ZeroSub kept when it was removed (its key, base URL and proxy are in it). */
function FolderForm({ theme, store, onDone, onCancel }: { theme: Theme; store: ZeroSubStore; onDone(): void; onCancel(): void }) {
  const text = useText(theme);
  const inputStyle = useInputStyle(theme);
  const [path, setPath] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = useCallback(async () => {
    if (!path.trim()) return;
    setSaving(true);
    setError(null);
    try {
      await store.rpc(importPiAccount, { path: path.trim() });
      await store.refresh();
      onDone();
    } catch (failure) {
      setError(describe(failure));
    } finally {
      setSaving(false);
    }
  }, [path, store, onDone]);
  return (
    <View style={{ gap: 12 }}>
      <Text style={text.small}>
        A Pi account removed here keeps its folder, with its key, base URL and proxy in its zerosub.json. Type the folder's full path to add it back as it was;
        it's named after the folder, and you can rename it.
      </Text>
      <TextInput
        value={path}
        onChangeText={setPath}
        autoFocus
        maxLength={1024}
        placeholder="~/.pi-config/pi-work"
        placeholderTextColor={theme.colors.foregroundMuted}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={() => void submit()}
        style={inputStyle}
        accessibilityLabel="Folder"
      />
      {error ? <Text style={text.danger}>{error}</Text> : null}
      <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
        <Button theme={theme} label="Cancel" tooltip="Close without adding an account" tooltipAlign="end" onPress={onCancel} />
        <Button theme={theme} tone="primary" label="Add account" tooltip="Add the account in this folder back" tooltipAlign="end" busy={saving} disabled={!path.trim()} onPress={() => void submit()} />
      </View>
    </View>
  );
}

/** Adds a Pi account: an Anthropic API key, or the folder of one removed before. */
export function AddPiAccountModal({ theme, store, onClose }: { theme: Theme; store: ZeroSubStore; onClose(): void }) {
  const toast = useToast();
  const [mode, setMode] = useState<"key" | "folder">("key");
  const done = () => {
    toast.show("Pi account added. Pick it from a Pi agent's account button, or make it the default.", { variant: "success" });
    onClose();
  };
  return (
    <Modal title={mode === "key" ? "Add Pi API account" : "Add a Pi account's folder back"} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8 }}>
          <Button theme={theme} size="small" tone={mode === "key" ? "primary" : "secondary"} label="API key" tooltip="Add an Anthropic API key as a new account" tooltipAlign="start" onPress={() => setMode("key")} />
          <Button
            theme={theme}
            size="small"
            tone={mode === "folder" ? "primary" : "secondary"}
            label="A folder set up already"
            tooltip="Add back an account removed earlier, from the folder ZeroSub kept"
            tooltipAlign="start"
            onPress={() => setMode("folder")}
          />
        </View>
        {mode === "key" ? <KeyForm theme={theme} store={store} onCancel={onClose} onDone={done} /> : <FolderForm theme={theme} store={store} onCancel={onClose} onDone={done} />}
      </Modal.Content>
    </Modal>
  );
}

/** Changes a Pi account's key or base URL from its card (Pi's own login's too). */
export function ApiKeyModal({ theme, store, account, onClose }: { theme: Theme; store: ZeroSubStore; account: AccountView; onClose(): void }) {
  const toast = useToast();
  return (
    <Modal title={`API settings for ${account.label}`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <KeyForm
          theme={theme}
          store={store}
          account={account}
          onCancel={onClose}
          onDone={() => {
            toast.show(`${account.label} updated. Agents started from now on use it.`, { variant: "success" });
            onClose();
          }}
        />
      </Modal.Content>
    </Modal>
  );
}

/** Sets or clears a Pi account's proxy (Pi's own login's too). */
export function ProxyModal({ theme, account, store, onClose }: { theme: Theme; account: AccountView; store: ZeroSubStore; onClose(): void }) {
  const text = useText(theme);
  const toast = useToast();
  const inputStyle = useInputStyle(theme);
  // The box starts with the current proxy, its password hidden: a change is only saved with the password typed in full.
  const current = account.proxy ?? "";
  const [proxy, setProxy] = useState(current);
  const typed = proxy.trim();
  const hidden = typed.includes(HIDDEN);
  const changed = typed !== "" && typed !== current && !hidden;
  const inherited = account.inheritedProxy;
  const followers = account.proxyFollowers.length > 0 ? `, and so do ${account.proxyFollowers.join(", ")}, which have no proxy of their own` : "";
  const [saving, setSaving] = useState<"save" | "clear" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const save = useCallback(
    async (value: string) => {
      setSaving(value ? "save" : "clear");
      setError(null);
      try {
        const result = await store.rpc(setAccountProxy, { accountId: account.id, proxy: value });
        toast.show(result.proxy ? `${account.label} now uses ${result.proxy}` : `${account.label} no longer uses a proxy`, { variant: "success" });
        await store.refresh();
        onClose();
      } catch (failure) {
        setError(describe(failure));
      } finally {
        setSaving(null);
      }
    },
    [account, store, toast, onClose],
  );
  return (
    <Modal title={`Proxy for ${account.label}`} open onOpenChange={(open) => (open ? undefined : onClose())}>
      <Modal.Content>
        <Text style={text.muted}>
          {account.proxy
            ? `Now: ${account.proxy}${account.proxyFile ? `, set in ${account.proxyFile}` : ""}.`
            : inherited
              ? `Now: no proxy of its own; it goes through ${inherited.proxy}, set in ${inherited.from}.`
              : "Now: no proxy of its own; it uses the network the daemon has."}
          {account.kind === "main"
            ? ` Saving writes it as httpProxy in ~/.pi/agent/settings.json, so plain pi uses it too unless its environment names a proxy${followers || ", and so do added accounts without a proxy of their own"}. Pi agents started afterwards use the new setting; running ones keep theirs until they reopen.`
            : " Its Pi agents started after saving use the new setting, for every request they make; running ones keep theirs until they reopen. It's also httpProxy in the settings of its folder, and its script uses it."}
        </Text>
        <TextInput
          value={proxy}
          onChangeText={setProxy}
          autoFocus
          maxLength={2048}
          // Empty keeps the proxy it goes through without one of its own, so that's what it shows.
          placeholder={inherited?.proxy ?? "http://host:port"}
          placeholderTextColor={theme.colors.foregroundMuted}
          autoCapitalize="none"
          autoCorrect={false}
          onSubmitEditing={() => (changed ? void save(typed) : undefined)}
          style={inputStyle}
          accessibilityLabel="Proxy URL"
        />
        <Text style={text.small}>{hidden ? `${HIDDEN} hides the proxy's password: type it in full to save a change.` : "http:// or https://, with user:password@ if the proxy needs it."}</Text>
        {error ? <Text style={text.danger}>{error}</Text> : null}
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-end" }}>
          <Button theme={theme} label="Cancel" tooltip="Keep the current proxy" tooltipAlign="end" onPress={onClose} />
          {account.proxy ? (
            <Button theme={theme} label="Remove proxy" tooltip="Stop using a proxy of its own" tooltipAlign="end" busy={saving === "clear"} onPress={() => void save("")} />
          ) : null}
          <Button theme={theme} tone="primary" label="Save" tooltip="Use this proxy for the account" tooltipAlign="end" busy={saving === "save"} disabled={!changed} onPress={() => void save(typed)} />
        </View>
      </Modal.Content>
    </Modal>
  );
}
