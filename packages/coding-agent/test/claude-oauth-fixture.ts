import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer as httpServer } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { nativeEndpoint } from "./claude-native-fixture.ts";

/** Intercepts the unmodified CLI's fixed OAuth URL; no real credentials or Keychain access. */
export async function oauthFixture(root: string) {
	const config = join(root, "login");
	const bin = join(root, "bin");
	mkdirSync(config);
	mkdirSync(bin);
	// Native macOS storage falls back to .credentials.json on item-not-found.
	// Never let either its shell or execFile calls reach the system security tool.
	writeFileSync(join(bin, "security"), "#!/bin/sh\nexit 44\n", { mode: 0o700 });
	const key = join(root, "key.pem");
	const cert = join(root, "cert.pem");
	const openssl = join(root, "openssl.cnf");
	writeFileSync(
		openssl,
		`[req]\nprompt=no\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\nCN=api.anthropic.com\n[ext]\nsubjectAltName=DNS:api.anthropic.com,DNS:platform.claude.com\nbasicConstraints=critical,CA:TRUE\nkeyUsage=critical,digitalSignature,keyEncipherment,keyCertSign\n`,
	);
	execFileSync(
		"openssl",
		["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-config", openssl],
		{ stdio: "ignore" },
	);
	const credentials = join(config, ".credentials.json");
	const initial = {
		claudeAiOauth: {
			accessToken: "expired-access",
			refreshToken: "valid-refresh",
			expiresAt: 1,
			scopes: ["user:inference", "user:profile"],
			subscriptionType: "max",
			rateLimitTier: "default_claude_max_5x",
		},
		unrelated: { keep: true },
	};
	writeFileSync(credentials, JSON.stringify(initial), { mode: 0o600 });
	const messages = await nativeEndpoint(() => [{ type: "text", text: "Authenticated locally." }]);
	let exchanges = 0;
	const authorizations: string[] = [];
	const failures: string[] = [];
	const tls = httpsServer({ key: readFileSync(key), cert: readFileSync(cert) }, async (request, response) => {
		let raw = "";
		for await (const chunk of request) raw += chunk;
		if (request.url === "/v1/oauth/token") {
			exchanges++;
			const body = JSON.parse(raw);
			if (body.grant_type !== "refresh_token" || body.refresh_token !== "valid-refresh" || exchanges !== 1) {
				failures.push("duplicate or invalid refresh exchange");
				response.writeHead(400, { "content-type": "application/json" });
				response.end(JSON.stringify({ error: "invalid_grant" }));
				return;
			}
			await setTimeout(250);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(
				JSON.stringify({
					access_token: "fresh-access",
					refresh_token: "rotated-refresh",
					expires_in: 3600,
					scope: "user:inference user:profile",
					token_type: "Bearer",
				}),
			);
			return;
		}
		if (request.url?.startsWith("/v1/messages")) {
			const auth = request.headers.authorization ?? "";
			authorizations.push(auth);
			if (auth !== "Bearer fresh-access") {
				response.writeHead(401, { "content-type": "application/json" });
				response.end(
					JSON.stringify({
						type: "error",
						error: { type: "authentication_error", message: "OAuth access token has expired" },
					}),
				);
				return;
			}
			try {
				const reply = await fetch(`${messages.url}${request.url}`, { method: "POST", body: raw });
				response.writeHead(reply.status, { "content-type": reply.headers.get("content-type")! });
				response.end(await reply.text());
			} catch {
				response.writeHead(500);
				response.end();
			}
			return;
		}
		response.writeHead(200, { "content-type": "application/json" });
		response.end(
			JSON.stringify({
				account: { uuid: "fixture-account", email: "test@example.com" },
				organization: { uuid: "fixture-org", organization_type: "claude_max" },
			}),
		);
	});
	await new Promise<void>((resolve) => tls.listen(0, "127.0.0.1", resolve));
	const address = tls.address();
	if (!address || typeof address === "string") throw new Error("Missing TLS address");
	const sockets = new Set<Socket>();
	const proxy = httpServer((_request, response) => {
		response.writeHead(502);
		response.end();
	});
	// CONNECT sockets are upgraded and are not closed by closeAllConnections().
	proxy.on("connection", (socket) => {
		sockets.add(socket);
		socket.once("close", () => sockets.delete(socket));
	});
	proxy.on("connect", (request, client, head) => {
		if (!["platform.claude.com:443", "api.anthropic.com:443"].includes(request.url ?? "")) {
			client.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
			return;
		}
		const upstream = connect(address.port, "127.0.0.1", () => {
			client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			client.pipe(upstream).pipe(client);
		});
		sockets.add(upstream);
		upstream.on("error", () => client.destroy());
		upstream.once("close", () => {
			client.destroy();
			sockets.delete(upstream);
		});
		client.on("error", () => upstream.destroy());
		client.on("close", () => {
			upstream.destroy();
			sockets.delete(upstream);
		});
	});
	await new Promise<void>((resolve) => proxy.listen(0, "127.0.0.1", resolve));
	const proxyAddress = proxy.address();
	if (!proxyAddress || typeof proxyAddress === "string") throw new Error("Missing proxy address");
	const url = `http://127.0.0.1:${proxyAddress.port}`;
	const env: Record<string, string> = Object.fromEntries(Object.keys(process.env).map((name) => [name, ""]));
	delete env.CLAUDE_SECURESTORAGE_CONFIG_DIR;
	Object.assign(env, {
		HOME: root,
		USER: "fixture",
		PATH: `${bin}:/usr/bin:/bin`,
		SHELL: "/bin/sh",
		CLAUDE_CONFIG_DIR: config,
		NODE_EXTRA_CA_CERTS: cert,
		HTTPS_PROXY: url,
		HTTP_PROXY: url,
		ALL_PROXY: url,
		https_proxy: url,
		http_proxy: url,
		all_proxy: url,
		NO_PROXY: "",
		no_proxy: "",
		CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
		DISABLE_TELEMETRY: "1",
		DISABLE_ERROR_REPORTING: "1",
	});
	return {
		env,
		credentials,
		authorizations,
		failures,
		exchanges: () => exchanges,
		close: async () => {
			for (const socket of sockets) socket.destroy();
			proxy.closeAllConnections();
			tls.closeAllConnections();
			await Promise.all([
				new Promise<void>((resolve) => proxy.close(() => resolve())),
				new Promise<void>((resolve) => tls.close(() => resolve())),
				messages.close(),
			]);
		},
	};
}
