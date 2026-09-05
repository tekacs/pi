import assert from "node:assert/strict";
import { test } from "node:test";
import { dependencyGraph, resolveDependency } from "./lock-graph.mjs";

const packages = {
	"node_modules/app": { link: true, resolved: "packages/app" },
	"packages/app": { name: "app", version: "1.0.0", dependencies: { sdk: "1.0.0", zod: "4.0.0", legacy: "1.0.0" } },
	"packages/app/node_modules/sdk": { version: "1.0.0", dependencies: { zod: "4.0.0" } },
	"packages/app/node_modules/zod": { version: "4.0.0" },
	"node_modules/zod": { version: "3.0.0" },
	"node_modules/legacy": { version: "1.0.0", dependencies: { zod: "3.0.0", cycle: "1.0.0" } },
	"node_modules/cycle": { version: "1.0.0", dependencies: { legacy: "1.0.0" } },
};
const workspaces = new Map([["app", { lockPath: "packages/app", packageJson: packages["packages/app"] }]]);
const copy = (value) => structuredClone(value);

test("installer preserves workspace-local versions and dependency cycles", () => {
	const root = { dependencies: { app: "1.0.0" } };
	const graph = dependencyGraph({
		packages,
		workspaces,
		root,
		seeds: Object.keys(root.dependencies).map((name) => ({ name, from: "" })),
		copyExternal: copy,
		copyWorkspace: copy,
	}).packages;
	const app = "node_modules/app";
	assert.equal(graph[resolveDependency(graph, "zod", app)].version, "4.0.0");
	const sdk = resolveDependency(graph, "sdk", app);
	assert.equal(graph[resolveDependency(graph, "zod", sdk)].version, "4.0.0");
	const legacy = resolveDependency(graph, "legacy", app);
	assert.equal(graph[resolveDependency(graph, "zod", legacy)].version, "3.0.0");
	assert.equal(Object.keys(graph).length, 7);
	assert.ok(Object.keys(graph).every((path) => !path.startsWith("packages/")));
});

test("does not resolve unrelated packages by suffix", () => {
	assert.throws(() => resolveDependency(packages, "sdk", "node_modules/legacy"), /Cannot resolve/);
});
