/**
 * MCP server on top of the real Obsidian Tasks engine — entry point and
 * transport choice. The tools themselves are in `src/mcp.ts`.
 *
 *   node dist/server.js -root /path/to/vault -root /path/to/second-vault
 *   node dist/server.js -root /path/to/vault -scope Subfolder/
 *   node dist/server.js -root /path/to/vault --http 3000
 *
 * Without `--http` the server speaks stdio, as it always has: the client
 * starts it as a subprocess. That stays the default, so existing MCP
 * configurations keep working untouched.
 *
 * `--http` serves Streamable HTTP on `POST /mcp`, bound to loopback and
 * nothing else. The vault is private and remote access is a
 * reverse-proxy-with-real-authentication problem, deliberately not this
 * server's. Over HTTP `-root` is required.
 *
 * **The `-root` directories are the whole of what the server reads**, on
 * either transport: a `rootDirs` from a call may only name them. `rootDirs`
 * is chosen by a language model, and a model's arguments can come from what
 * it read a moment ago — so opening that up is `--allow-any-root`, a decision
 * for the person writing the command line. See `outsideConfiguredRoots` in
 * `src/mcp.ts`.
 *
 * `-scope` pins the server permanently to a subpath of the vault: only what
 * lies below it is read. The paths in the answer stay vault-relative.
 */
import './bootstrap';

import { createMcpHandler } from '@modelcontextprotocol/server';
import { serveStdio } from '@modelcontextprotocol/server/stdio';
import { localhostHostValidation, localhostOriginValidation, toNodeHandler } from '@modelcontextprotocol/node';

import { timingSafeEqual } from 'node:crypto';
import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from 'node:http';

import { createServer, type ServerConfig } from './mcp';

/** The path the HTTP transport is served on. */
const endpoint = '/mcp';

/** Port for `--http` without an explicit one. */
const defaultPort = 3000;

/**
 * The largest request body that will be accepted.
 *
 * A query is a handful of lines of text; a megabyte is already three orders of
 * magnitude more than any real one. The limit is not about a determined
 * attacker — every process on the machine can reach this port, and one that
 * wants to spend memory has cheaper ways. It is about the request that is
 * large by accident and the one that is large on purpose costing nothing to
 * refuse.
 */
const maxBodyBytes = 1_000_000;

/**
 * Time limits, in milliseconds, for *receiving* a request — not for answering
 * one. A query over a large vault may take a while and is not cut off; a
 * client that opens a connection and then dribbles is.
 *
 * Node's own defaults are 300 s and 60 s, which are meant for a public server
 * behind a load balancer. This one is talking to a client on the same
 * machine.
 */
const requestTimeout = 30_000;
const headersTimeout = 10_000;

/**
 * An optional shared secret for `--http`, as `Authorization: Bearer …`.
 *
 * Unset, and nothing changes — this is not authentication arriving late. The
 * port is loopback-only and that remains the boundary that matters; what this
 * narrows is the case the architecture already admits to leaving open, namely
 * every *other* user and process on a shared machine. An environment variable
 * rather than a flag, so the secret stays out of `ps` and out of shell
 * history.
 */
const sharedSecret = process.env.OBSIDIAN_TASKS_MCP_TOKEN;

const { roots, scope, httpPort, allowAnyRoot } = parseArgs(process.argv.slice(2));

if (allowAnyRoot && httpPort !== undefined) {
    process.stderr.write(
        '--allow-any-root and --http are refused together: over a port there is nobody to vouch ' +
            'for a call, so letting it name any directory would let anything on this machine read ' +
            'any Markdown the user can.\n',
    );
    process.exit(2);
}

if (roots.length === 0 && httpPort === undefined && !allowAnyRoot) {
    // Not fatal — a server without -root has always been usable, and the
    // caller then has to name the directories. But it is worth saying out
    // loud, because it is the one configuration in which nothing is pinned.
    process.stderr.write(
        'No -root given: this server will read whatever directory a call names in `rootDirs`. ' +
            'Pass -root to pin it to your vault.\n',
    );
}

/**
 * Pinned unless a human opted out — and never as a side effect of the
 * transport. Nothing to pin to means nothing to enforce: with no `-root` the
 * caller must name the directories, and the warning above says so.
 */
const config: ServerConfig = { roots, scope, pinRoots: roots.length > 0 && !allowAnyRoot };

if (httpPort === undefined) {
    // Dual-era: `legacy: 'serve'` is the SDK default, but spelling it out says
    // that serving 2025-era clients is intended and not an oversight.
    serveStdio(() => createServer(config), { legacy: 'serve' });
} else {
    if (roots.length === 0) {
        process.stderr.write(
            '--http needs at least one -root: over HTTP the directories passed at start are the ' +
                'only ones this server will read. Without them any process that can reach the port ' +
                'could name an arbitrary directory in `rootDirs` and have it read out.\n',
        );
        process.exit(2);
    }

    const handler = toNodeHandler(createMcpHandler(() => createServer(config), { legacy: 'stateless' }));
    const validateHost = localhostHostValidation();
    const validateOrigin = localhostOriginValidation();

    const httpServer = createHttpServer((request, response) => {
        // The guards answer the request themselves when they refuse.
        if (!validateHost(request, response) || !validateOrigin(request, response)) return;
        if (!authorized(request, response)) return;
        if (!withinSizeLimit(request, response)) return;

        const path = (request.url ?? '').split('?')[0];
        if (path !== endpoint) {
            response.writeHead(404, { 'content-type': 'text/plain' });
            response.end(`Not found. This server serves MCP on ${endpoint}.\n`);
            return;
        }

        void handler(request, response);
    });

    httpServer.requestTimeout = requestTimeout;
    httpServer.headersTimeout = headersTimeout;

    // Report the port the kernel actually assigned, not the one asked for:
    // with `--http 0` those differ, and that is how the smoke test finds us.
    httpServer.listen(httpPort, '127.0.0.1', () => {
        const address = httpServer.address();
        const port = typeof address === 'object' && address !== null ? address.port : httpPort;
        process.stderr.write(`MCP over Streamable HTTP on http://127.0.0.1:${port}${endpoint}\n`);
        if (sharedSecret) process.stderr.write('A bearer token is required (OBSIDIAN_TASKS_MCP_TOKEN).\n');
    });
}

/** Refuses with `401` unless `OBSIDIAN_TASKS_MCP_TOKEN` is set and matches. */
function authorized(request: IncomingMessage, response: ServerResponse): boolean {
    if (!sharedSecret) return true;

    const offered = request.headers.authorization ?? '';
    if (!matches(offered, `Bearer ${sharedSecret}`)) {
        response.writeHead(401, { 'content-type': 'text/plain', 'www-authenticate': 'Bearer' });
        response.end('Unauthorized.\n');
        return false;
    }
    return true;
}

/**
 * Constant-time comparison. `timingSafeEqual` throws on buffers of different
 * length, so both are copied into zero-filled ones of the same size and the
 * length is only compared afterwards — the bytes are never compared in a way
 * that stops early on the first difference.
 */
function matches(offered: string, expected: string): boolean {
    const a = Buffer.from(offered);
    const b = Buffer.from(expected);
    const size = Math.max(a.length, b.length, 1);
    const left = Buffer.alloc(size);
    const right = Buffer.alloc(size);
    a.copy(left);
    b.copy(right);
    const sameBytes = timingSafeEqual(left, right);
    return sameBytes && a.length === b.length;
}

/**
 * Bounds the request body before a byte of it is read.
 *
 * `Content-Length` is a claim, not a measurement — a chunked request makes no
 * claim at all and could go on forever. Rather than counting bytes off the
 * stream ahead of the SDK's own reader, which would mean consuming what it is
 * about to consume, a body without a length is refused outright: an MCP
 * request is one JSON document whose size is known before it is sent, and
 * every client sends `Content-Length` for it. A request with no body at all
 * (a `GET`, which the stateless handler answers with 405) has neither header
 * and passes untouched.
 */
function withinSizeLimit(request: IncomingMessage, response: ServerResponse): boolean {
    const refuse = (status: number, why: string) => {
        response.writeHead(status, { 'content-type': 'text/plain' });
        response.end(`${why}\n`);
        return false;
    };

    if (request.headers['transfer-encoding'] !== undefined) {
        return refuse(411, 'A request body must arrive with a Content-Length; chunked is not accepted.');
    }

    const declared = request.headers['content-length'];
    if (declared === undefined) return true;

    const length = Number(declared);
    if (!Number.isFinite(length) || length < 0) return refuse(400, 'Malformed Content-Length.');
    if (length > maxBodyBytes) return refuse(413, `Request too large: the limit is ${maxBodyBytes} bytes.`);
    return true;
}

/**
 * Accepts `-root DIR` and `--root DIR`, likewise bare directories, plus
 * `-scope SUBPATH`, `--http [PORT]` and `--allow-any-root`.
 *
 * `--http` takes its port only when the next argument looks like one —
 * otherwise `--http -root /vault` would swallow the flag that follows.
 */
function parseArgs(args: string[]): {
    roots: string[];
    scope: string | undefined;
    httpPort: number | undefined;
    allowAnyRoot: boolean;
} {
    const roots: string[] = [];
    let scope: string | undefined;
    let httpPort: number | undefined;
    let allowAnyRoot = false;
    for (let i = 0; i < args.length; i++) {
        if (args[i] === '-root' || args[i] === '--root') {
            const value = args[++i];
            if (value) roots.push(value);
        } else if (args[i] === '-scope' || args[i] === '--scope') {
            const value = args[++i];
            if (value) scope = value;
        } else if (args[i] === '-http' || args[i] === '--http') {
            httpPort = defaultPort;
            if (/^\d+$/.test(args[i + 1] ?? '')) httpPort = Number(args[++i]);
        } else if (args[i] === '-allow-any-root' || args[i] === '--allow-any-root') {
            allowAnyRoot = true;
        } else if (!args[i].startsWith('-')) {
            roots.push(args[i]);
        }
    }
    return { roots, scope, httpPort, allowAnyRoot };
}
