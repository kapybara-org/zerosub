import { access, constants, lstat, mkdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { idSuffix, piName, slug } from "./launchers";
import { dataDir, homesDir, inHomesDir, mainClaudeDir, mainCodexHome, mainPiDir, piLauncherDir, shownPath } from "./paths";
import type { PiHomes, StoredAccount } from "./state";

/**
 * Where added Pi accounts' homes are kept: the folder picked in the app, else the script directory
 * (`~/.pi-config`), beside each account's script. ZeroSub sets new accounts up inside its own
 * `homes/` and moves them here once they're saved (see `Service.placeHomes`).
 */
export function piHomesDir(homes: PiHomes): string {
  return homes.dir ?? piLauncherDir();
}

/** Whether `path` is `folder` or inside it. */
function within(path: string, folder: string): boolean {
  const inside = relative(resolve(folder), resolve(path));
  return inside === "" || (!inside.startsWith("..") && !isAbsolute(inside));
}

/** A path typed in the app, as a full path (`~` is the home folder); refused unless it's one, with `example`. */
function typedPath(typed: string, example: string): string {
  const expanded = typed === "~" ? homedir() : typed.startsWith("~/") ? join(homedir(), typed.slice(2)) : typed;
  if (!isAbsolute(expanded)) throw new Error(`Enter a full path, like ${example}.`);
  return resolve(expanded);
}

/**
 * The folder typed in the app for added Pi accounts' homes, as a full path (`~` is the home folder),
 * made if it isn't there yet; null for the default (empty, or the default typed out). Refused,
 * saying why: a path that isn't full; the home folder or `/` itself; anywhere in ZeroSub's own
 * folder, where homes it may delete live; in a CLI's own home or an account's; a file; a folder it
 * can't write to.
 */
export async function choosePiHomesDir(input: string, accounts: readonly StoredAccount[]): Promise<string | null> {
  const typed = input.trim();
  if (!typed) return null;
  const dir = typedPath(typed, "~/.pi-config or /Volumes/Data/pi-accounts");
  if (dir === resolve(homedir()) || dir === resolve("/")) throw new Error(`Pick a folder of their own for the accounts, not ${shownPath(dir)} itself.`);
  if (within(dir, dataDir())) throw new Error(`${shownPath(dir)} is inside ZeroSub's own folder (${shownPath(dataDir())}). Pick one outside it.`);
  for (const main of [mainClaudeDir(), mainCodexHome(), mainPiDir()]) {
    if (within(dir, main)) throw new Error(`${shownPath(dir)} is inside ${shownPath(main)}, a CLI's own folder. Pick one outside it.`);
  }
  const holder = accounts.find((account) => account.home && within(dir, account.home));
  if (holder) throw new Error(`${shownPath(dir)} is inside the folder of ${holder.label}. Pick one outside it.`);
  const entry = await stat(dir).catch(() => null);
  if (entry && !entry.isDirectory()) throw new Error(`${shownPath(dir)} is a file, not a folder.`);
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await access(dir, constants.W_OK);
  } catch (error) {
    throw new Error(`ZeroSub can't use ${shownPath(dir)}: ${error instanceof Error ? error.message : String(error)}`);
  }
  return dir === resolve(piLauncherDir()) ? null : dir;
}

/**
 * The folder typed in the app to add back as a Pi account (one ZeroSub set up, kept when its account
 * was removed), as a full path. Refused, saying why: a path that isn't full, or isn't a folder; Pi's
 * own; one already added, inside an added account's folder or holding one; anywhere in ZeroSub's own
 * folder but directly in `homes/`; and a folder without the `zerosub.json` ZeroSub keeps an
 * account's key in.
 */
export async function chooseImportedPiHome(input: string, accounts: readonly StoredAccount[]): Promise<string> {
  const home = typedPath(input.trim(), "~/.pi-config/pi-work");
  const shown = shownPath(home);
  if (home === resolve(homedir()) || home === resolve("/") || home === resolve(mainPiDir())) throw new Error(`${shown} isn't a Pi account's folder.`);
  const added = accounts.find((account) => account.home && resolve(account.home) === home);
  if (added) throw new Error(`${shown} is already added, as ${added.label}.`);
  const holder = accounts.find((account) => account.home && (within(home, account.home) || within(account.home, home)));
  if (holder) throw new Error(`${shown} is inside or holds the folder of ${holder.label}. Enter the account's folder itself.`);
  if (within(home, dataDir()) && dirname(home) !== homesDir()) throw new Error(`${shown} is inside ZeroSub's own folder (${shownPath(dataDir())}).`);
  const entry = await stat(home).catch(() => null);
  if (!entry) throw new Error(`There's no folder at ${shown}.`);
  if (!entry.isDirectory()) throw new Error(`${shown} is a file, not a folder.`);
  if (!(await stat(join(home, "zerosub.json")).catch(() => null))?.isFile()) {
    throw new Error(`${shown} isn't a Pi account's folder: there's no zerosub.json in it. Add a new account with its API key instead.`);
  }
  return home;
}

/**
 * Where an account's home goes in `dir`. One ZeroSub set up inside `homes/` is named after the
 * account, `pi-<name>` like its script; one from a folder picked before keeps its name. A name
 * already there, or in `taken` (other accounts' homes and places), gets the first six hex digits of
 * the account's ID added, then a number. The name stays when the account is renamed later.
 */
export async function placeFor(account: StoredAccount & { home: string }, dir: string, taken: ReadonlySet<string>): Promise<string> {
  const suffix = idSuffix(account.id);
  const base = inHomesDir(account.home) ? (slug(account.label) ? piName(account.label) : `pi-${suffix}`) : basename(account.home);
  const free = async (name: string) => !taken.has(resolve(dir, name)) && (await lstat(join(dir, name)).catch(() => null)) === null;
  let name = base;
  if (!(await free(name))) name = `${base}-${suffix}`;
  for (let n = 2; !(await free(name)); n++) name = `${base}-${suffix}-${n}`;
  return join(dir, name);
}
