import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { isOwnHome, launcherDir, paseoHome, piLauncherDir } from "./paths";

/**
 * A script per added Claude account that starts the Claude CLI on it, for use outside Paseo: put
 * `~/.claude-config` on `PATH` once, then run `claude-work.sh` (or `claude-work.cmd` on Windows).
 * Accounts added later get theirs without touching the shell profile again. `ZEROSUB_LAUNCHER_DIR`
 * puts them somewhere else.
 *
 * Each script sets exactly what ZeroSub sets for an agent on that account, then hands over to
 * `claude`, so the caller's shell is untouched. The account's proxy (and an API account's key,
 * base URL and blanked credential variables) needs nothing here: it lives in the home's
 * `settings.json` `env`, which Claude Code applies over whatever the shell exports.
 *
 * Each added Pi account gets one too, `pi-<account>.sh` (`.cmd` on Windows) in `~/.pi-config`
 * (`ZEROSUB_PI_DIR`): it sets the account's agent directory, takes the proxy ZeroSub gives its
 * agents from the account's `zerosub.env` (`zerosub.cmd` on Windows, kept up to date there, see
 * `PiAdapter.prepareHome`) and runs `pi`. Each kind only ever touches its own scripts, so both can
 * share a directory.
 */
export { launcherDir, piLauncherDir };

/** Which CLI a script starts. */
export type LauncherKind = "claude" | "pi";

interface KindSpec {
  /** Script names start with `<prefix>-`. */
  prefix: string;
  /** Third line: says which account the script is for. */
  describe(label: string, platform: NodeJS.Platform): string;
  describePattern: RegExp;
  /** The variable whose value is the account's home. */
  homeVariable: string;
  /** The lines after the third, for POSIX shells. */
  body(home: string): string[];
  /** The lines after the third, for Windows `.cmd` scripts. */
  cmdBody(home: string): string[];
}

/** File in a Pi account's home holding the proxy variables its agents get, which its script reads. */
export const PI_LAUNCH_ENV = "zerosub.env";
/** Windows counterpart of `PI_LAUNCH_ENV`, read by `pi-<account>.cmd`. */
export const PI_LAUNCH_CMD = "zerosub.cmd";

/** Script file extension for `platform`: `.cmd` on Windows, `.sh` elsewhere. */
export function launcherExtension(platform: NodeJS.Platform = process.platform): ".cmd" | ".sh" {
  return platform === "win32" ? ".cmd" : ".sh";
}

/** Escapes a value for `set "VAR=value"` in a Windows `.cmd` file (double quotes and line breaks can't appear in paths). */
export function quoteCmd(value: string): string {
  return value.replace(/[\r\n"]/g, "").replace(/%/g, "%%");
}

/**
 * Emits `set "KEY=value"` lines for a `.cmd` file, temporarily switching the console code page to
 * UTF-8 (65001) only when a value holds non-ASCII characters so default OEM code pages don't mangle it.
 */
export function renderCmdSetLines(entries: ReadonlyArray<readonly [string, string]>): string[] {
  const nonAscii = entries.some(([, value]) => /[^\x00-\x7f]/.test(value));
  const lines: string[] = [];
  if (nonAscii) {
    lines.push(
      'for /f "tokens=2 delims=:" %%a in (\'chcp\') do set "_zerosub_cp=%%a"',
      'if defined _zerosub_cp set "_zerosub_cp=%_zerosub_cp:.=%"',
      "chcp 65001 >nul",
    );
  }
  for (const [key, value] of entries) lines.push(`set "${key}=${quoteCmd(value)}"`);
  if (nonAscii) {
    lines.push("if defined _zerosub_cp chcp %_zerosub_cp% >nul", 'set "_zerosub_cp="');
  }
  return lines;
}

const KINDS: Record<LauncherKind, KindSpec> = {
  claude: {
    prefix: "claude",
    describe: (label, platform) => `${platform === "win32" ? "rem" : "#"} Starts the Claude CLI on "${label}", an account added in Paseo.`,
    describePattern: /^(?:#|rem) Starts the Claude CLI on "(.*)", an account added in Paseo\.$/,
    homeVariable: "CLAUDE_CONFIG_DIR",
    body: (home) => [
      `unset ${OVERRIDING_AUTH.join(" ")}`,
      `export CLAUDE_CONFIG_DIR=${quote(home)}`,
      `export CLAUDE_SECURESTORAGE_CONFIG_DIR=${quote(home)}`,
      'exec claude "$@"',
    ],
    cmdBody: (home) => [
      "setlocal DisableDelayedExpansion",
      ...renderCmdSetLines([
        ...OVERRIDING_AUTH.map((key) => [key, ""] as const),
        ["CLAUDE_CONFIG_DIR", home],
        ["CLAUDE_SECURESTORAGE_CONFIG_DIR", home],
      ]),
      "call claude %*",
      "exit /b %ERRORLEVEL%",
    ],
  },
  pi: {
    prefix: "pi",
    describe: (label, platform) => `${platform === "win32" ? "rem" : "#"} Starts Pi on "${label}", an account added in Paseo.`,
    describePattern: /^(?:#|rem) Starts Pi on "(.*)", an account added in Paseo\.$/,
    homeVariable: "PI_CODING_AGENT_DIR",
    body: (home) => [
      `export PI_CODING_AGENT_DIR=${quote(home)}`,
      "# The proxy this account's agents use in Paseo, kept up to date by ZeroSub; it wins over the shell's.",
      `[ -f "$PI_CODING_AGENT_DIR/${PI_LAUNCH_ENV}" ] && . "$PI_CODING_AGENT_DIR/${PI_LAUNCH_ENV}"`,
      'exec pi "$@"',
    ],
    cmdBody: (home) => [
      "setlocal DisableDelayedExpansion",
      ...renderCmdSetLines([["PI_CODING_AGENT_DIR", home]]),
      "rem The proxy this account's agents use in Paseo, kept up to date by ZeroSub; it wins over the shell's.",
      `if exist "%PI_CODING_AGENT_DIR%\\${PI_LAUNCH_CMD}" call "%PI_CODING_AGENT_DIR%\\${PI_LAUNCH_CMD}"`,
      "call pi %*",
      "exit /b %ERRORLEVEL%",
    ],
  },
};

/** Which kind of ZeroSub script `content` is, by its third line; null when it's neither. */
function kindOf(content: string): LauncherKind | null {
  const line = content.split(/\r?\n/)[2] ?? "";
  for (const kind of Object.keys(KINDS) as LauncherKind[]) if (KINDS[kind].describePattern.test(line)) return kind;
  return null;
}

export interface LauncherAccount {
  id: string;
  label: string;
  home: string;
}

/** Variables that would make the CLI use something other than the account's own login. */
const OVERRIDING_AUTH = ["CLAUDE_CODE_OAUTH_TOKEN", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY"];

/**
 * Second line of every script ZeroSub writes. It names the Paseo home of the daemon that wrote it,
 * since daemons with different `PASEO_HOME`s can share the directory: each only ever rewrites,
 * removes or releases scripts carrying its own. Of those, only the ones that start a home of
 * ZeroSub's own are ever removed; the rest are released (see `RELEASED`).
 */
function marker(platform: NodeJS.Platform = process.platform): string {
  const comment = platform === "win32" ? "rem" : "#";
  return `${comment} Generated by ZeroSub (Paseo home ${paseoHomeTag()}). Don't edit: it's rewritten whenever accounts change.`;
}

const MARKER_PATTERN = /^(?:#|rem) Generated by ZeroSub \(Paseo home ([0-9a-f]{8})\)\. /;

/** Short tag for this daemon's Paseo home in the marker: the first 8 hex digits of its path's SHA-256. */
export function paseoHomeTag(): string {
  return createHash("sha256").update(paseoHome()).digest("hex").slice(0, 8);
}

/**
 * Takes the marker's place in a script ZeroSub stops managing but mustn't delete: one that starts
 * a home outside `homesDir()`, which stays the user's account after ZeroSub forgets it, one whose
 * home is still there after its account went missing, or a copy under another name.
 */
const RELEASED = "# No longer managed by ZeroSub (its account was removed or renamed there). ZeroSub won't delete it.";
const RELEASED_CMD = "rem No longer managed by ZeroSub (its account was removed or renamed there). ZeroSub won't delete it.";

export function slug(label: string): string {
  return label
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
}

/** The name part of a `kind` script or home for `label`: `claude-work`, `pi-work` (a label already starting `pi-` keeps it once). */
export function kindName(kind: LauncherKind, label: string): string {
  const { prefix } = KINDS[kind];
  const base = slug(label);
  return base.startsWith(`${prefix}-`) ? base : `${prefix}-${base}`;
}

/** The first six hex digits of an account's ID, which tell names apart. */
export function idSuffix(id: string): string {
  return id.replace(/^[a-z]+-/, "").slice(0, 6);
}

/**
 * `claude-<label>.sh` (`pi-<label>.sh` for `kind` "pi", or `.cmd` on Windows), made unique: a label
 * that's empty or taken falls back to the account's ID. `kept` lists scripts ZeroSub must not
 * overwrite, by file name, with the home each starts (null when no account may take it over); an
 * account only gets one of those names if the script starts that account's own home.
 */
export function launcherNames(
  accounts: readonly LauncherAccount[],
  kept: ReadonlyMap<string, string | null> = new Map(),
  kind: LauncherKind = "claude",
  platform: NodeJS.Platform = process.platform,
): Map<string, string> {
  const { prefix } = KINDS[kind];
  const ext = launcherExtension(platform);
  const names = new Map<string, string>();
  const taken = new Set<string>();
  for (const account of accounts) {
    const free = (name: string) => {
      if (taken.has(name)) return false;
      const home = kept.get(`${name}${ext}`);
      return home === undefined || (home !== null && resolve(home) === resolve(account.home));
    };
    const suffix = idSuffix(account.id);
    const base = slug(account.label) ? kindName(kind, account.label) : `${prefix}-${suffix}`;
    let name = base;
    if (!free(name)) name = `${name}-${suffix}`;
    for (let n = 2; !free(name); n++) name = `${base}-${suffix}-${n}`;
    taken.add(name);
    names.set(account.id, `${name}${ext}`);
  }
  return names;
}

function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export function renderLauncher(
  account: LauncherAccount,
  kind: LauncherKind = "claude",
  platform: NodeJS.Platform = process.platform,
): string {
  const spec = KINDS[kind];
  const cleanLabel = account.label.replace(/[\r\n]+/g, " ");
  if (platform === "win32") {
    return ["@echo off", marker("win32"), spec.describe(cleanLabel, "win32"), ...spec.cmdBody(account.home), ""].join("\r\n");
  }
  return ["#!/bin/sh", marker(platform), spec.describe(cleanLabel, platform), ...spec.body(account.home), ""].join("\n");
}

function platformOf(content: string): NodeJS.Platform {
  return content.split(/\r?\n/)[0] === "@echo off" ? "win32" : "linux";
}

/** Who wrote a script: this or another daemon's tag, or null if not ZeroSub. */
function writer(content: string): string | null {
  return MARKER_PATTERN.exec(content.split(/\r?\n/)[1] ?? "")?.[1] ?? null;
}

function released(content: string): boolean {
  const line = content.split(/\r?\n/)[1];
  return line === RELEASED || line === RELEASED_CMD;
}

/** The account a script says it's for, read back from the line `renderLauncher` writes. */
function scriptLabel(content: string, kind: LauncherKind): string | null {
  return KINDS[kind].describePattern.exec(content.split(/\r?\n/)[2] ?? "")?.[1] ?? null;
}

/** Whether a script is where `launcherNames` puts the account it's for (account IDs are hex). A copy under a name of the user's is the user's. */
function namedFor(name: string, content: string, kind: LauncherKind): boolean {
  const label = scriptLabel(content, kind);
  if (label === null) return false;
  const id = "[0-9a-f]{6}";
  const { prefix } = KINDS[kind];
  const base = slug(label) ? kindName(kind, label) : `${prefix}-${id}`;
  const ext = launcherExtension(platformOf(content)).replace(".", "\\.");
  return new RegExp(`^(?:${base}|${prefix}-${id})(?:-${id}(?:-[0-9]+)?)?${ext}$`).test(name);
}

/** Whether a released script is still exactly as ZeroSub released it, so its account may have it back. */
function asReleased(content: string, home: string, kind: LauncherKind): boolean {
  const label = scriptLabel(content, kind);
  if (label === null) return false;
  const platform = platformOf(content);
  const eol = platform === "win32" ? "\r\n" : "\n";
  const lines = renderLauncher({ id: "", label, home }, kind, platform).split(eol);
  lines[1] = platform === "win32" ? RELEASED_CMD : RELEASED;
  return lines.join(eol) === content;
}

/** The home a script starts the CLI on, read back from the line `renderLauncher` writes. */
function scriptHome(content: string, kind: LauncherKind): string | null {
  const variable = KINDS[kind].homeVariable;
  const lines = content.split(/\r?\n/);
  if (platformOf(content) === "win32") {
    const prefix = `set "${variable}=`;
    const line = lines.find((entry) => entry.startsWith(prefix) && entry.endsWith('"'));
    if (!line) return null;
    const raw = line.slice(prefix.length, -1);
    return raw.includes('"') ? null : raw.replace(/%%/g, "%");
  }
  const prefix = `export ${variable}=`;
  const value = lines.find((line) => line.startsWith(prefix))?.slice(prefix.length);
  if (!value || !/^'(?:[^']|'\\'')*'$/.test(value)) return null;
  return value.slice(1, -1).replace(/'\\''/g, "'");
}

/**
 * What's at `path`: undefined if nothing, null for anything ZeroSub never replaces (a symlink, a
 * directory, a file it can't read), otherwise the file's content.
 */
async function readEntry(path: string): Promise<string | null | undefined> {
  const entry = await lstat(path).catch(() => undefined);
  if (!entry) return undefined;
  if (!entry.isFile()) return null;
  return readFile(path, "utf8").catch(() => null);
}

/** The entries in `directory` that could be scripts, as `readEntry` sees them. */
async function readScripts(directory: string, platform: NodeJS.Platform = process.platform): Promise<Map<string, string | null>> {
  const scripts = new Map<string, string | null>();
  for (const entry of await readdir(directory).catch(() => [] as string[])) {
    // Dot files include another write's temporary file, about to be renamed into place.
    if (entry.startsWith(".")) continue;
    // On Windows also inspect `.sh` so legacy scripts from earlier versions are tidied up or released.
    if (platform === "win32" ? !entry.endsWith(".cmd") && !entry.endsWith(".sh") : !entry.endsWith(".sh")) continue;
    const content = await readEntry(join(directory, entry));
    if (content !== undefined) scripts.set(entry, content);
  }
  return scripts;
}

/**
 * Puts `content` in place atomically, provided the file is still what was read (`expected`, or
 * undefined if there was none): a file someone put there meanwhile is never replaced.
 */
async function writeScript(directory: string, name: string, content: string, expected: string | undefined): Promise<void> {
  const path = join(directory, name);
  const temporary = join(directory, `.${name}.${randomBytes(4).toString("hex")}.tmp`);
  try {
    await writeFile(temporary, content, { mode: 0o755 });
    if ((await readEntry(path)) === expected) await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

/**
 * Writes each account's script (only when it changed) and tidies up this daemon's scripts for
 * accounts that are gone or renamed: one that starts a home ZeroSub owns (see `isOwnHome`) is
 * removed when that home's account was renamed, or the home is `leaving` (listed for cleanup) or
 * gone; any other is released, its marker line replaced, so it keeps working and is the user's
 * from then on. That includes the script of a home of ZeroSub's own that only the registry lost
 * track of, and a copy the user made of a script under another name. A released script goes back
 * to its account if that home is added again, unless the user changed it; until then released
 * and hand-written scripts, other daemons' scripts and anything that isn't a plain file (a
 * symlink, say) are never overwritten by an account's, and anything else in the directory is left
 * alone. A script of this daemon's for a home that `moved` (old home to new) to an account's is
 * that account's, rewritten under its name. Returns each account's script name.
 */
export async function writeLaunchers(
  accounts: readonly LauncherAccount[],
  directory = launcherDir(),
  leaving: Iterable<string> = [],
  moved: ReadonlyMap<string, string> = new Map(),
  kind: LauncherKind = "claude",
  platform: NodeJS.Platform = process.platform,
): Promise<Map<string, string>> {
  const scripts = await readScripts(directory, platform);
  // The other kind's scripts are that kind's to manage: neither this kind's nor names it may take.
  for (const [name, content] of scripts) {
    const of = content === null ? null : kindOf(content);
    if (of !== null && of !== kind && writer(content!) !== null) scripts.delete(name);
  }
  const tag = paseoHomeTag();
  const homes = new Set(accounts.map((account) => resolve(account.home)));
  const going = new Set([...leaving].map((home) => resolve(home)));
  const goes = async (home: string) =>
    homes.has(resolve(home)) ||
    going.has(resolve(home)) ||
    (await lstat(home).then(
      () => false,
      (error: NodeJS.ErrnoException) => error.code === "ENOENT",
    ));
  /** This daemon's scripts: the only ones it rewrites, removes or releases. */
  const mine = new Map<string, string>();
  const kept = new Map<string, string | null>();
  for (const [name, content] of scripts) {
    const started = content === null ? null : scriptHome(content, kind);
    const movedTo = started === null ? undefined : moved.get(resolve(started));
    const home = movedTo !== undefined && homes.has(resolve(movedTo)) ? movedTo : started;
    if (content !== null && writer(content) === tag) {
      mine.set(name, content);
      if (home === null || !namedFor(name, content, kind) || !(await isOwnHome(home)) || !(await goes(home))) kept.set(name, home);
    } else {
      // Only a released script goes back to an account: the one whose home it starts, if unchanged.
      kept.set(name, content !== null && home !== null && released(content) && asReleased(content, home, kind) ? home : null);
    }
  }
  const names = launcherNames(accounts, kept, kind, platform);
  const wanted = new Map(accounts.map((account) => [names.get(account.id)!, renderLauncher(account, kind, platform)]));
  if (wanted.size > 0) await mkdir(directory, { recursive: true, mode: 0o700 });
  for (const [name, content] of wanted) {
    const current = scripts.get(name);
    if (current !== null && current !== content) await writeScript(directory, name, content, current);
  }
  for (const [name, content] of mine) {
    if (wanted.has(name)) continue;
    if (kept.has(name)) {
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const lines = content.split(/\r?\n/);
      lines[1] = platformOf(content) === "win32" ? RELEASED_CMD : RELEASED;
      await writeScript(directory, name, lines.join(eol), content);
    } else if ((await readEntry(join(directory, name))) === content) {
      await rm(join(directory, name), { force: true });
    }
  }
  return names;
}
