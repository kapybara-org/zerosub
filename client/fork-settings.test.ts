import { beforeEach, describe, expect, it, vi } from "vitest";
import { preferences, type Preferences } from "../shared/preferences";

// The row components are React Native views that don't load here; pass their props straight through
// so the test can assert on labels, hints, disabled flags and options.
vi.mock("@getpaseo/plugin/client/ui", () => ({
  SettingsRow: (props: Record<string, unknown>) => props,
  SettingsSelect: (props: Record<string, unknown>) => props,
}));

const CATALOG = [
  { id: "opencode/glm-5p3-flash", label: "GLM 5.3 Flash", isDefault: true, thinkingOptions: [{ id: "high", label: "High" }] },
  { id: "opencode/other", label: "Other" },
];
let catalog: Array<Record<string, unknown>> = CATALOG;
let catalogError: string | undefined;
vi.mock("@getpaseo/plugin/client", () => ({
  usePaseo: () => ({ providers: { listModels: async () => (catalogError ? { error: catalogError } : { models: catalog }) } }),
}));

// The component is called as a function, so drive its hooks by hand: one state holder, effects run now.
let state: unknown;
vi.mock("react", () => ({
  useState: (initial: unknown) => [state ?? initial, (next: unknown) => { state = next; }],
  useEffect: (effect: () => unknown) => { effect(); },
}));

const { ForkDestinationRows, OpenCodeForkRows } = await import("./fork-settings");

const values = (overrides: Partial<Preferences> = {}): Preferences => ({ ...preferences.schema.parse({}), ...overrides });

interface Row {
  props: {
    label: string;
    hint?: string;
    disabled?: boolean;
    options?: Array<{ label: string; value: string }>;
    onValueChange?: (value: string) => void;
  };
}

/** The rows a render returns: a fragment's children, or the one row it returned on its own. */
const rowsOf = (element: unknown): Row[] => {
  const children = (element as { props: { children?: Row | Row[] } }).props.children;
  return children === undefined ? [element as Row] : ([children].flat() as Row[]);
};

/** Renders once for the loading state, lets the catalog land, then renders again and reports the rows. */
const render = async (overrides: Partial<Preferences> = {}) => {
  const saved: Array<Partial<Preferences>> = [];
  const draw = () =>
    OpenCodeForkRows({ values: values(overrides), saving: false, onSave: (patch) => saved.push(patch) }) as {
      props: { children: Row | Row[] };
    };
  draw();
  for (let round = 0; round < 5; round += 1) await Promise.resolve();
  const children = draw().props.children;
  const rows = (Array.isArray(children) ? children : [children]).map((row) => row as Row);
  const destination = ForkDestinationRows({ values: values(overrides), saving: false, onSave: () => undefined }) as unknown as Row;
  const all = [destination, ...rows];
  return { rows, byLabel: (label: string) => all.find((row) => row.props.label === label)!, saved };
};

beforeEach(() => {
  catalog = CATALOG;
  catalogError = undefined;
  state = undefined;
});

describe("OpenCodeForkRows and ForkDestinationRows", () => {
  it("renders only the destination select, no model or thinking rows, from ForkDestinationRows", () => {
    const row = ForkDestinationRows({ values: values(), saving: false, onSave: () => undefined }) as unknown as Row;
    expect(row.props.label).toBe("Fork a stopped Claude chat to");
  });

  it("shows the read error, not an empty catalog, when listModels reports one", async () => {
    catalogError = "daemon unreachable";
    await render();
    const rows = rowsOf(OpenCodeForkRows({ values: values(), saving: false, onSave: () => undefined }));
    expect(rows.find((row) => row.props.label === "OpenCode model")?.props.hint).toBe("Couldn't read this host's OpenCode models: daemon unreachable");
  });

  it("shows the model and thinking rows next to a disabled destination under factory defaults", async () => {
    // Factory defaults: destination codex, both automation flags off, no saved model. The model and
    // thinking rows still show, because a manual Continue on OpenCode uses them.
    const { byLabel } = await render();
    const destination = byLabel("Fork a stopped Claude chat to");
    const model = byLabel("OpenCode model");
    expect(destination.props.disabled).toBe(true);
    expect(model.props.disabled).toBe(false);
    expect(model.props.hint).toBe("Used by Continue on OpenCode in the account menu, and by the automatic fork when its destination is OpenCode.");
    expect(model.props.options).toContainEqual({ label: "Host default", value: "" });
    // The host marks a default, so its thinking options are listed and pickable.
    const thinking = byLabel("OpenCode thinking");
    expect(thinking.props.disabled).toBe(false);
    expect(thinking.props.options).toEqual([
      { label: "Model default", value: "" },
      { label: "High", value: "high" },
    ]);
    expect(thinking.props.hint).toContain("GLM 5.3 Flash");
  });

  it("shows the thinking row as unavailable when no model resolves", async () => {
    catalog = CATALOG.filter((entry) => !("isDefault" in entry));
    const thinking = (await render()).byLabel("OpenCode thinking");
    expect(thinking.props.disabled).toBe(true);
    expect(thinking.props.options).toEqual([{ label: "Model default", value: "" }]);
    expect(thinking.props.hint).toBe("Pick a model above to choose its thinking option.");
  });

  it("lists no thinking options while the catalog is loading", async () => {
    catalog = CATALOG;
    state = { status: "loading" };
    const rows = rowsOf(OpenCodeForkRows({ values: values(), saving: false, onSave: () => undefined }));
    expect(rows.find((row) => row.props.label === "OpenCode model")?.props.hint).toBe("Loading this host's OpenCode catalog…");
    expect(rows.every((row) => row.props.options === undefined || row.props.label !== "OpenCode thinking")).toBe(true);
  });

  it("drops Host default and says so when the host marks no default", async () => {
    catalog = CATALOG.filter((entry) => !("isDefault" in entry));
    const { byLabel } = await render();
    const model = byLabel("OpenCode model");
    expect(model.props.options!.map((option) => option.label)).not.toContain("Host default");
    expect(model.props.hint).toBe("This host marks no OpenCode default; pick a model.");
  });

  it("keeps the stale-model hint when the saved model left the catalog", async () => {
    catalog = CATALOG.filter((entry) => !("isDefault" in entry));
    const { byLabel } = await render({ forkOpenCodeModel: "opencode/gone" });
    expect(byLabel("OpenCode model").props.hint).toBe("That model is no longer in this host's catalog; pick another.");
  });

  it("enables the destination only with both automation switches on, the model row regardless", async () => {
    const both = await render({ forkOtherProvider: true, autoSwitch: true });
    expect(both.byLabel("Fork a stopped Claude chat to").props.disabled).toBe(false);
    expect(both.byLabel("OpenCode model").props.disabled).toBe(false);
    const destination = await render({ forkOtherProvider: true, autoSwitch: false });
    expect(destination.byLabel("Fork a stopped Claude chat to").props.disabled).toBe(true);
    expect(destination.byLabel("OpenCode model").props.disabled).toBe(false);
  });

  it("saves a picked model and clears a thinking option the model drops", async () => {
    const view = await render({ forkOtherProvider: true, autoSwitch: true });
    view.byLabel("OpenCode model").props.onValueChange!("opencode/glm-5p3-flash");
    expect(view.saved).toEqual([{ forkOpenCodeModel: "opencode/glm-5p3-flash", forkOpenCodeThinking: "" }]);

    const picked = await render({ forkOpenCodeModel: "opencode/glm-5p3-flash", forkOpenCodeThinking: "high" });
    expect(picked.byLabel("OpenCode thinking").props.options).toEqual([
      { label: "Model default", value: "" },
      { label: "High", value: "high" },
    ]);
    picked.byLabel("OpenCode thinking").props.onValueChange!("high");
    expect(picked.saved).toEqual([{ forkOpenCodeThinking: "high" }]);
    // The freshly picked model offers no thinking options, so the saved one can't stand.
    picked.byLabel("OpenCode model").props.onValueChange!("opencode/other");
    expect(picked.saved.at(-1)).toEqual({ forkOpenCodeModel: "opencode/other", forkOpenCodeThinking: "" });
    // Back to Host default: the host's marked default offers "high", so it stands.
    picked.byLabel("OpenCode model").props.onValueChange!("");
    expect(picked.saved.at(-1)).toEqual({ forkOpenCodeModel: "" });
  });
});
