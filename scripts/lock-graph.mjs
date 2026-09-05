import { posix } from "node:path";

/** Resolve against the source installation, including workspace symlinks. */
export function resolveDependency(packages, name, from) {
	let directory = packages[from]?.link ? packages[from].resolved : from;
	while (true) {
		const candidate = directory ? `${directory}/node_modules/${name}` : `node_modules/${name}`;
		const entry = packages[candidate];
		if (entry) return entry.link ? entry.resolved : candidate;
		if (!directory) break;
		const parent = posix.dirname(directory);
		directory = parent === "." ? "" : parent;
	}
	throw new Error(`Cannot resolve ${name} from ${from || "root"}`);
}

function ancestors(path) {
	const paths = [];
	let current = path;
	while (current) {
		paths.push(current);
		const parent = posix.dirname(current);
		current = parent === "." ? "" : parent;
	}
	paths.push("");
	return paths;
}

/**
 * Project a dependency closure into a consumer installation. Source paths are
 * used for resolution; destination paths are used only for placement. Hoist
 * when the slot is free, reuse matching ancestors, and nest conflicting versions.
 */
export function dependencyGraph({ packages, workspaces, root, seeds, copyExternal, copyWorkspace }) {
	const output = { "": root };
	const sources = new Map();
	const internalNames = new Set();
	const queue = seeds.map((seed) => ({ ...seed, target: "" }));
	for (let index = 0; index < queue.length; index++) {
		const { name, from, target } = queue[index];
		const workspace = workspaces.get(name);
		const source = workspace?.lockPath ?? resolveDependency(packages, name, from);
		const candidates = ancestors(target).map((path) => `${path ? `${path}/` : ""}node_modules/${name}`);
		// Only the nearest occupied ancestor participates in Node resolution.
		const nearest = candidates.find((path) => sources.has(path));
		if (nearest && sources.get(nearest) === source) continue;
		const hoisted = `node_modules/${name}`;
		const destination = nearest ? candidates[0] : hoisted;
		if (sources.has(destination)) {
			throw new Error(`Conflicting dependency ${name} at ${destination}`);
		}
		const entry = workspace ? copyWorkspace(workspace.packageJson, name) : copyExternal(packages[source]);
		output[destination] = entry;
		sources.set(destination, source);
		if (workspace) internalNames.add(name);
		for (const dependency of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) {
			queue.push({ name: dependency, from: source, target: destination });
		}
	}
	return { packages: output, internalNames };
}
