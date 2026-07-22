import { describe, expect, test } from "vitest";
import {
	AgentSessionRuntime,
	createAgentSession,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
} from "../src/index.ts";

describe("coding-agent public SDK exports", () => {
	test("exports session factories from their runtime modules", () => {
		expect(AgentSessionRuntime).toBeTypeOf("function");
		expect(createAgentSession).toBeTypeOf("function");
		expect(createAgentSessionFromServices).toBeTypeOf("function");
		expect(createAgentSessionRuntime).toBeTypeOf("function");
		expect(createAgentSessionServices).toBeTypeOf("function");
	});
});
