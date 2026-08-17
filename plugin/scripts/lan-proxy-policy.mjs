const ALLOWED_METHODS = new Set(["GET", "HEAD", "POST"]);

/** Keep the LAN listener narrower than the Harness web server it fronts. */
export function isAllowedProxyRequest(method, rawUrl) {
	if (!ALLOWED_METHODS.has(String(method ?? "").toUpperCase())) return false;
	let pathname;
	try {
		pathname = new URL(rawUrl ?? "/", "https://dsh-mobile.invalid").pathname;
	} catch {
		return false;
	}
	return pathname === "/mobile" || pathname.startsWith("/mobile/") || pathname === "/mobile-api" || pathname.startsWith("/mobile-api/");
}

/** Remove hop-by-hop and caller-supplied forwarding headers before proxying. */
export function makeUpstreamHeaders(headers, remoteAddress = "") {
	const result = { ...headers };
	for (const name of ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade", "x-forwarded-for", "x-forwarded-proto"]) delete result[name];
	result["x-forwarded-proto"] = "https";
	result["x-forwarded-for"] = remoteAddress;
	return result;
}
