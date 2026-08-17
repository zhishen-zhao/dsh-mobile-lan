/**
 * Standalone loopback SSH server for live harness integration tests.
 * Listens on 127.0.0.1:22822, accepts password auth (tester / test123),
 * echoes a line and exits 0 for every exec. Run:
 *   node test/loopback-server.mjs
 */
import { generateKeyPairSync } from "node:crypto";
import ssh2 from "ssh2";

const { Server } = ssh2;
const { privateKey: keyObject } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const privateKey = keyObject.export({ format: "pem", type: "pkcs1" }).toString();

const server = new Server({ hostKeys: [privateKey] }, (client) => {
	client.on("error", () => {});
	client.on("authentication", (ctx) => {
		if (ctx.method === "password" && ctx.username === "tester" && ctx.password === "test123") return ctx.accept();
		ctx.reject();
	}).on("ready", () => {
		client.on("session", (accept) => {
			const session = accept();
			session.on("exec", (acceptExec, _reject, info) => {
				const stream = acceptExec();
				stream.stdout.write(`hello from loopback, cmd was: ${info.command}\n`);
				stream.exit(0);
				stream.end();
			});
		});
	});
});

server.listen(22822, "127.0.0.1", () => {
	console.log("loopback ssh2 server on 127.0.0.1:22822");
});
