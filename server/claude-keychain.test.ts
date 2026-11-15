import { afterEach, describe, expect, it, vi } from "vitest";

// Moving a home moves its Keychain entry: Claude Code names the entry after the folder's path. These
// run against an in-memory Keychain behind a stand-in for `security`; the real one is never touched.

const keychain = new Map<string, string>();
const commands: string[] = [];

vi.mock("./process", async (original) => ({
  ...(await original<typeof import("./process")>()),
  run: vi.fn(async (command: string, args: readonly string[], options: { input?: string } = {}) => {
    if (command !== "/usr/bin/security") throw new Error(`unexpected command ${command}`);
    const done = (code: number, stdout = "") => ({ code, stdout, stderr: "", timedOut: false });
    const service = args[args.indexOf("-s") + 1] ?? "";
    commands.push(args[0] === "-i" ? `-i ${options.input?.split(" -X ")[0]}` : `${args[0]} ${service}`);
    if (args[0] === "find-generic-password") return keychain.has(service) ? done(0, `${keychain.get(service)}\n`) : done(44);
    if (args[0] === "delete-generic-password") return done(keychain.delete(service) ? 0 : 44);
    const add = /^add-generic-password -U -a "[^"]+" -s "([^"]+)" -X "([0-9a-f]+)"\n$/.exec(options.input ?? "");
    if (args[0] === "-i" && add) {
      keychain.set(add[1]!, Buffer.from(add[2]!, "hex").toString("utf8"));
      return done(0);
    }
    return done(1);
  }),
}));

const { ClaudeAdapter, homesInEnvironment, keychainService } = await import("./claude");

afterEach(() => {
  keychain.clear();
  commands.length = 0;
});

const FROM = "/Users/ada/.paseo/zerosub/homes/claude-aaaaaaaaaaaa";
const TO = "/Users/ada/.claude-config/claude-work";
const SIGN_IN = '{"claudeAiOauth":{"accessToken":"sk-ant-oat-…","refreshToken":"…","expiresAt":1}}';

describe.runIf(process.platform === "darwin")("moving a home's Keychain entry", () => {
  it("copies it to the entry Claude Code reads for the new folder, through security's standard input", async () => {
    keychain.set(keychainService(FROM), SIGN_IN);
    await new ClaudeAdapter().copyCredentials(FROM, TO);
    expect(keychain.get(keychainService(TO))).toBe(SIGN_IN);
    expect(keychain.get(keychainService(FROM))).toBe(SIGN_IN);
    // The secret only went to security's standard input, never its arguments.
    expect(commands.some((command) => command.includes("sk-ant"))).toBe(false);
    expect(commands).toContain(`-i add-generic-password -U -a "${process.env.USER}" -s "${keychainService(TO)}"`);

    // Done twice, the second time changes nothing.
    commands.length = 0;
    await new ClaudeAdapter().copyCredentials(FROM, TO);
    expect(commands.filter((command) => command.startsWith("-i"))).toEqual([]);
  });

  it("won't write over another sign-in, or copy what Claude Code didn't write", async () => {
    keychain.set(keychainService(FROM), SIGN_IN);
    keychain.set(keychainService(TO), '{"claudeAiOauth":{"accessToken":"someone else"}}');
    await expect(new ClaudeAdapter().copyCredentials(FROM, TO)).rejects.toThrow("already holds another one");
    expect(keychain.get(keychainService(TO))).toBe('{"claudeAiOauth":{"accessToken":"someone else"}}');

    keychain.set(keychainService(FROM), "not json");
    keychain.delete(keychainService(TO));
    await expect(new ClaudeAdapter().copyCredentials(FROM, TO)).rejects.toThrow("isn't what Claude Code writes");
    expect(keychain.has(keychainService(TO))).toBe(false);
  });

  it("has nothing to copy for a home that isn't signed in", async () => {
    await new ClaudeAdapter().copyCredentials(FROM, TO);
    expect(keychain.size).toBe(0);
  });

  it("removes the old entry only once the new folder's holds a sign-in", async () => {
    keychain.set(keychainService(FROM), SIGN_IN);
    expect(await new ClaudeAdapter().dropOldCredentials(FROM, TO)).toBe(false);
    expect(keychain.has(keychainService(FROM))).toBe(true);

    // Claude Code has renewed it there since: the old one goes all the same.
    keychain.set(keychainService(TO), '{"claudeAiOauth":{"accessToken":"renewed"}}');
    expect(await new ClaudeAdapter().dropOldCredentials(FROM, TO)).toBe(true);
    expect([...keychain.keys()]).toEqual([keychainService(TO)]);
  });

  it("undoes a copy only while it's still the same, never an entry that was there before", async () => {
    keychain.set(keychainService(FROM), SIGN_IN);
    keychain.set(keychainService(TO), "was there before");
    await new ClaudeAdapter().dropCopiedCredentials(FROM, TO);
    expect(keychain.get(keychainService(TO))).toBe("was there before");

    keychain.set(keychainService(TO), SIGN_IN);
    await new ClaudeAdapter().dropCopiedCredentials(FROM, TO);
    expect([...keychain.keys()]).toEqual([keychainService(FROM)]);
  });
});

describe("which homes Claude Code runs on", () => {
  const homes = ["/Users/ada/.claude-config/claude-work", "/Users/ada/.claude-config/claude-work-2"];

  it("goes by the exact folder a process was started with", () => {
    const line = (env: string) => `/opt/homebrew/bin/claude --print TERM=xterm ${env} HOME=/Users/ada`;
    expect(homesInEnvironment(line(`CLAUDE_CONFIG_DIR=${homes[0]}`), homes)).toEqual([homes[0]]);
    expect(homesInEnvironment(line(`CLAUDE_SECURESTORAGE_CONFIG_DIR=${homes[1]}`), homes)).toEqual([homes[1]]);
    expect(homesInEnvironment(`node CLAUDE_CONFIG_DIR=${homes[1]}`, homes)).toEqual([homes[1]]);
    expect(homesInEnvironment(line("CLAUDE_CONFIG_DIR=/Users/ada/.claude"), homes)).toEqual([]);
    expect(homesInEnvironment(line(`CLAUDE_CONFIG_DIR=${homes[0]}/sub`), homes)).toEqual([]);
    expect(homesInEnvironment(line(`XCLAUDE_CONFIG_DIR=${homes[0]}`), homes)).toEqual([]);
  });
});
