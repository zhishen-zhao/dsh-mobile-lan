/**
 * TLS LAN reverse proxy for dsh-mobile-remote.
 *
 * The Harness remains on loopback. This proxy terminates HTTPS for the phone,
 * forwards only HTTP requests to 127.0.0.1, preserves the original Host header
 * (so dsh's desktop /api trust fence remains effective), and adds a trusted
 * X-Forwarded-Proto marker for the mobile plugin's HTTPS requirement.
 *
 * Usage:
 *   node scripts/lan-proxy.mjs [targetPort] [listenHost] [listenPort] \
 *     --tls-cert <certificate.pem> --tls-key <private-key.pem>
 */
import http from "node:http";
import https from "node:https";
import os from "node:os";
import { readFileSync } from "node:fs";
import { isAllowedProxyRequest, makeUpstreamHeaders } from "./lan-proxy-policy.mjs";

const args = process.argv.slice(2);
function takeFlag(name) {
	const index = args.indexOf(name);
	if (index < 0) return void 0;
	const value = args[index + 1];
	args.splice(index, value === void 0 ? 1 : 2);
	return value;
}

const certPath = takeFlag("--tls-cert");
const keyPath = takeFlag("--tls-key");
const [targetPortArg, listenHostArg, listenPortArg] = args;
const targetPort = Number(targetPortArg ?? 3080);
const listenHost = listenHostArg ?? firstLanIpv4();
const listenPort = Number(listenPortArg ?? targetPort);
const targetHost = "127.0.0.1";

function firstLanIpv4() {
	for (const interfaces of Object.values(os.networkInterfaces())) {
		for (const entry of interfaces ?? []) {
			if (entry.family === "IPv4" && !entry.internal && !entry.address.startsWith("169.254.")) return entry.address;
		}
	}
	return void 0;
}

if (!Number.isSafeInteger(targetPort) || targetPort <= 0 || targetPort > 65535) {
	console.error(`lan-proxy: invalid target port ${targetPortArg ?? 3080}`);
	process.exit(1);
}
if (!Number.isSafeInteger(listenPort) || listenPort <= 0 || listenPort > 65535) {
	console.error(`lan-proxy: invalid listen port ${listenPortArg ?? targetPort}`);
	process.exit(1);
}
if (typeof listenHost !== "string" || listenHost.length === 0) {
	console.error("lan-proxy: no non-loopback IPv4 found; pass listenHost explicitly");
	process.exit(1);
}
if (typeof certPath !== "string" || typeof keyPath !== "string" || certPath.length === 0 || keyPath.length === 0) {
	console.error("lan-proxy: HTTPS is required. Pass --tls-cert <certificate.pem> --tls-key <private-key.pem>");
	process.exit(1);
}

let certificate;
let privateKey;
try {
	certificate = readFileSync(certPath);
	privateKey = readFileSync(keyPath);
} catch (error) {
	console.error(`lan-proxy: cannot read TLS certificate or key: ${error instanceof Error ? error.message : String(error)}`);
	process.exit(1);
}

const server = https.createServer({ cert: certificate, key: privateKey, minVersion: "TLSv1.2" }, (req, res) => {
	if (!isAllowedProxyRequest(req.method, req.url)) {
		res.writeHead(req.method === "GET" || req.method === "HEAD" || req.method === "POST" ? 404 : 405, {
			"content-type": "text/plain; charset=utf-8",
			"cache-control": "no-store",
			"x-content-type-options": "nosniff"
		});
		res.end("Not found");
		req.resume();
		return;
	}
	const upstream = http.request({
		host: targetHost,
		port: targetPort,
		method: req.method,
		path: req.url,
		// Preserve Host to keep dsh's desktop /api trust fence rejecting LAN
		// requests. The proxy, not the phone, overwrites forwarded headers.
		headers: makeUpstreamHeaders(req.headers, req.socket.remoteAddress ?? "")
	}, (upstreamResponse) => {
		res.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
		upstreamResponse.pipe(res);
	});
	upstream.on("error", (error) => {
		console.error(`lan-proxy: upstream ${targetHost}:${targetPort} failed: ${error.code ?? error.message}`);
		if (!res.headersSent) res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
		res.end("Harness is unavailable");
	});
	req.on("aborted", () => upstream.destroy());
	req.pipe(upstream);
});

server.headersTimeout = 15_000;
server.requestTimeout = 30_000;
server.on("upgrade", (_req, socket) => socket.destroy());

server.on("error", (error) => {
	if (error.code === "EADDRINUSE") {
		console.error(`lan-proxy: ${listenHost}:${listenPort} is already in use — is another proxy running?`);
	} else if (error.code === "EACCES") {
		console.error(`lan-proxy: cannot bind ${listenHost}:${listenPort}: ${error.message}`);
	} else {
		console.error(`lan-proxy: ${String(error)}`);
	}
	process.exitCode = 1;
});

server.listen(listenPort, listenHost, () => {
	console.log(`lan-proxy: https://${listenHost}:${listenPort}/mobile/ -> ${targetHost}:${targetPort} (TLS enabled)`);
});
