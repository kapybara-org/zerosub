import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import ts from "typescript";
import { expect, it } from "vitest";

/**
 * The phone evaluates what Paseo's daemon builds, so these are the client options of compileTarget() in
 * getpaseo/paseo packages/server/src/server/plugins/compiler.ts (same in v0.9.1 through v0.11.4, except
 * `mainFields`, added after v0.9.1). Resync them when that file changes:
 * https://github.com/getpaseo/paseo/blob/main/packages/server/src/server/plugins/compiler.ts
 * The daemon runs esbuild 0.25.x; we mirror its options, not its version (both keep class syntax at es2020).
 */
async function clientBundle(): Promise<string> {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("../index.client.tsx", import.meta.url))],
    bundle: true,
    format: "cjs",
    jsx: "automatic",
    platform: "neutral",
    target: "es2020",
    mainFields: ["module", "main"],
    supported: { "async-await": false },
    external: [
      "@getpaseo/plugin",
      "@getpaseo/plugin/server",
      "@getpaseo/plugin/server/provider",
      "@getpaseo/plugin/server/usage",
      "@getpaseo/plugin/server/acp",
      "@getpaseo/plugin/client",
      "@getpaseo/plugin/client/ui",
      "@getpaseo/plugin/client/react-native",
      "@tanstack/react-query",
      "react",
      "react/jsx-runtime",
      "react-native",
      "zod",
    ],
    treeShaking: true,
    logLevel: "silent",
    write: false,
  });
  return result.outputFiles[0]!.text;
}

/** Lines with class syntax. Parsing, unlike a regex, ignores comments and strings that say "class". */
function classLines(code: string): number[] {
  const source = ts.createSourceFile("client.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const lines: number[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isClassLike(node)) lines.push(source.getLineAndCharacterOfPosition(node.getStart()).line + 1);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return lines;
}

it("finds class declarations and expressions, not the word", () => {
  expect(classLines('/** class */ const s = "class A {}";\nclass B {}\nconst C = class {};')).toEqual([2, 3]);
});

// Hermes on the phone can't run classes from an eval'd bundle (see createZeroSubStore).
it("keeps class syntax out of the client bundle", async () => {
  expect(classLines(await clientBundle())).toEqual([]);
});

/**
 * Lines where a closure uses a `let` or `const` of a loop around it: the loop's own variable or one
 * declared in its body. Each iteration gets its own copy in the spec, but not on Hermes, which
 * scopes them to the function, so every such closure sees the last iteration's value. A closure
 * called before the iteration ends is safe all the same; this can't tell, so none are allowed.
 * Functions named in `ignore` aren't looked into.
 */
function loopCaptures(code: string, ignore: ReadonlySet<string> = new Set()): number[] {
  const source = ts.createSourceFile("client.js", code, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const lines = new Set<number>();
  const blockScoped = (list: ts.Node): list is ts.VariableDeclarationList =>
    ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.BlockScoped) !== 0;
  const bind = (name: ts.BindingName, into: Set<string>): void => {
    if (ts.isIdentifier(name)) into.add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name, into);
  };
  const named = (node: ts.Identifier): boolean => {
    const parent = node.parent;
    return (
      (ts.isPropertyAccessExpression(parent) && parent.name === node) ||
      (ts.isPropertyAssignment(parent) && parent.name === node) ||
      (ts.isMethodDeclaration(parent) && parent.name === node)
    );
  };
  const visit = (node: ts.Node, scoped: ReadonlySet<string>): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && ignore.has(node.name.text)) return;
    if (ts.isForStatement(node) || ts.isForOfStatement(node) || ts.isForInStatement(node) || ts.isWhileStatement(node) || ts.isDoStatement(node)) {
      const inner = new Set(scoped);
      const head = "initializer" in node ? node.initializer : undefined;
      if (head && blockScoped(head)) for (const declaration of head.declarations) bind(declaration.name, inner);
      const collect = (child: ts.Node): void => {
        if (ts.isFunctionLike(child)) return;
        if (blockScoped(child)) for (const declaration of child.declarations) bind(declaration.name, inner);
        ts.forEachChild(child, collect);
      };
      collect(node.statement);
      ts.forEachChild(node, (child) => visit(child, inner));
      return;
    }
    if (ts.isFunctionLike(node) && scoped.size > 0) {
      const uses = (child: ts.Node): void => {
        if (ts.isIdentifier(child) && scoped.has(child.text) && !named(child)) lines.add(source.getLineAndCharacterOfPosition(child.getStart()).line + 1);
        ts.forEachChild(child, uses);
      };
      uses(node);
      ts.forEachChild(node, (child) => visit(child, new Set()));
      return;
    }
    ts.forEachChild(node, (child) => visit(child, scoped));
  };
  visit(source, new Set());
  return [...lines].sort((a, b) => a - b);
}

it("finds closures that use a loop's let or const, and nothing else", () => {
  const code = [
    "for (const a of list) {",
    "  const b = a.x;",
    "  later(() => a + b);",
    "  now(function () { return { a: 1 }.a; });",
    "}",
    "for (var c of list) later(() => c);",
    "function outside() { return a; }",
  ].join("\n");
  expect(loopCaptures(code)).toEqual([3]);
});

it("keeps closures from using a loop's let or const in the client bundle", async () => {
  const code = await clientBundle();
  // esbuild's helper copies the bundle's exports, only `default`, so its loop runs once.
  const lines = loopCaptures(code, new Set(["__copyProps"])).map((line) => `${line}: ${code.split("\n")[line - 1]!.trim()}`);
  expect(lines).toEqual([]);
});
