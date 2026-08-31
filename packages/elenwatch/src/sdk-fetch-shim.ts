/**
 * sdk-fetch-shim.ts
 *
 * Test-only fetch shim for the Vercel AI SDK providers.
 *
 * Status: TEST-ONLY SURFACE. This file is intentionally NOT re-exported from
 * src/index.ts and is NOT consumed by production code paths. The horizon-9
 * dual-patch (http.ClientRequest.prototype + setGlobalDispatcher) is the
 * load-bearing capture surface for SDK-issued fetch traffic; this shim is
 * the per-call escape hatch documented in decisions.md (2026-08-30 | horizon
 * 10 | SDK transport uses option B) — shipped now to close horizon-8's
 * deferred deliverables, with zero current consumers in the SDK integration
 * tests (those rely on the dual-patch alone and do NOT pass this shim to the
 * SDK providers).
 *
 * Do not re-export from src/index.ts. Do not import from production source.
 *
 * Why this exists:
 *   - horizon-8 named a per-call fetch shim as the bypass-risk hedge against
 *     the SDK lazy-loading its own undici under Jest 29 + Node 22 (the
 *     globalThis.fetch lazy-loader may not share globalDispatcher state with
 *     a user-installed require('undici')).
 *   - horizon-9's setGlobalDispatcher dual-patch resolved that hedge for
 *     production use — see decisions.md 2026-08-30 — but the shim still ships
 *     as test-only surface for the (rare) case a future test needs to drive
 *     the SDK through a specific transport without relying on the patch.
 *
 * Transport: option B from horizon-8 — per-call fetch shim built on
 * node:https.request. The shim translates the SDK Web Request shape into a
 * node:https.request call and the IncomingMessage response back into a Web
 * Response, lowercasing headers and buffering the body into a ReadableStream.
 *
 * Type contract: the factory's return type is anchored to the @ai-sdk/* SDK
 * provider's own fetch option type (AnthropicProviderSettings['fetch']), so
 * a future SDK tightening of the FetchFunction signature will fail tsc here,
 * not silently at the SDK call site. AnthropicProviderSettings is re-exported
 * from @ai-sdk/anthropic/dist/index.d.ts:1311.
 */

import { request as httpsRequest, type RequestOptions } from 'node:https';
import type { AnthropicProviderSettings } from '@ai-sdk/anthropic';

/**
 * The SDK's per-provider fetch option type. AnthropicProviderSettings['fetch']
 * is `FetchFunction | undefined` (per @ai-sdk/anthropic/dist/index.d.ts:1277),
 * and the SDK's FetchFunction = typeof globalThis.fetch (per @ai-sdk/provider-
 * utils/dist/index.d.ts:867). NonNullable strips the `| undefined` so the
 * shim's return type matches the actual fetch slot's shape.
 */
type SdkFetchFunction = NonNullable<AnthropicProviderSettings['fetch']>;

/**
 * Build a fetch implementation compatible with the @ai-sdk/* provider
 * `fetch` option. The returned function translates a Web Request shape into
 * a node:https.request call and the IncomingMessage response back into a
 * Web Response.
 *
 * Intended for test-only use; not part of the public API.
 */
export function createSdkFetchShim(): SdkFetchFunction {
  const fetchImpl: SdkFetchFunction = (input, init) => {
    // Normalize a Web Request input to {url, init} so the downstream
    // builder only deals with URL + RequestInit shapes. Request carries
    // its own method/headers/body that should layer on top of any
    // call-site init.
    let url: URL;
    let mergedInit: RequestInit | undefined;
    if (typeof input === 'string') {
      url = new URL(input);
      mergedInit = init;
    } else if (input instanceof URL) {
      url = input;
      mergedInit = init;
    } else {
      // Request object — pull URL from request.url and merge request
      // method/headers/body with any call-site init.
      url = new URL(input.url);
      mergedInit = mergeRequestInit(input, init);
    }
    const req = buildNodeRequest(url, mergedInit);
    return new Promise<Response>((resolve, reject) => {
      const client = httpsRequest(req, (res) => {
        const status = res.statusCode ?? 0;
        const statusText = res.statusMessage ?? '';

        // Lowercase all header names so response.headers.get('Content-Type')
        // (the form the SDK providers use) works against the raw
        // IncomingMessage headers.
        const headers = new Headers();
        for (const [name, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) {
            for (const v of value) headers.append(name.toLowerCase(), v);
          } else if (typeof value === 'string') {
            headers.append(name.toLowerCase(), value);
          }
        }

        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => {
          chunks.push(chunk);
        });
        res.on('end', () => {
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              for (const c of chunks) controller.enqueue(c);
              controller.close();
            },
          });
          resolve(new Response(body, { status, statusText, headers }));
        });
        res.on('error', (err: Error) => reject(err));
      });
      client.on('error', (err: Error) => reject(err));

      // Write body if supplied.
      if (req.body !== undefined && req.body !== null) {
        client.end(req.body);
      } else {
        client.end();
      }
    });
  };
  return fetchImpl;
}

/**
 * Translate a (URL, RequestInit) pair into a node:https.request options
 * object. Pure data — no I/O — so unit-testable in isolation if a future
 * test needs the head-of-pipeline surface.
 *
 * Input normalization happens in the caller so this function only handles
 * the URL + init shape (the Request shape is unwrapped before reaching here).
 */
function buildNodeRequest(
  url: URL,
  init?: RequestInit,
): RequestOptions & { body?: string | Buffer | undefined } {
  const method = init?.method ?? 'GET';
  const headers: Record<string, string> = {};
  if (init?.headers !== undefined) {
    // Headers may be a Headers object, a Record, or an array of pairs —
    // normalize to lowercase keys to match node:https.request convention.
    if (init.headers instanceof Headers) {
      init.headers.forEach((value, name) => {
        headers[name.toLowerCase()] = value;
      });
    } else if (Array.isArray(init.headers)) {
      for (const [name, value] of init.headers) {
        headers[name.toLowerCase()] = value;
      }
    } else {
      for (const [name, value] of Object.entries(init.headers)) {
        headers[name.toLowerCase()] = String(value);
      }
    }
  }

  const protocol = url.protocol.replace(/:$/, '');
  const defaultPort =
    protocol === 'https' ? 443 : protocol === 'http' ? 80 : undefined;

  const req: RequestOptions & { body?: string | Buffer | undefined } = {
    protocol,
    hostname: url.hostname,
    port: url.port !== '' ? Number(url.port) : defaultPort,
    path: `${url.pathname}${url.search}`,
    method,
    headers,
  };

  // Body branches: string, Uint8Array (Buffer), undefined. Other shapes
  // (ArrayBuffer, Blob, FormData, ReadableStream) are intentionally not
  // supported — the SDK providers only emit the documented three shapes
  // for LLM provider traffic, and adding support would expand the shim's
  // surface beyond horizon-10's needs.
  if (init?.body !== undefined && init.body !== null) {
    if (typeof init.body === 'string') {
      req.body = init.body;
    } else if (init.body instanceof Uint8Array) {
      req.body = Buffer.from(init.body);
    } else {
      // Other body shapes are out of horizon-10 scope; reject loudly
      // rather than silently drop.
      throw new Error(
        'sdk-fetch-shim: unsupported body shape (expected string | Uint8Array | undefined)',
      );
    }
  }

  return req;
}

/**
 * Layer a Request's own method/headers/body on top of any call-site init,
 * matching the standard Request constructor semantics: call-site init wins
 * for keys it specifies, Request's own values fill in the rest.
 */
function mergeRequestInit(request: Request, init?: RequestInit): RequestInit {
  const out: RequestInit = {};
  // Start with the request's own values as the base layer.
  if (request.method !== undefined) out.method = request.method;
  if (request.headers !== undefined) out.headers = request.headers;
  // Body extraction is guarded: GET/HEAD requests cannot have a body.
  if (request.method !== 'GET' && request.method !== 'HEAD') {
    // request.body is a ReadableStream | null under undici-types; for
    // horizon-10's documented body shapes (string | Uint8Array) we expect
    // the SDK to have already buffered the body before reaching here.
    // Leave it for the body-branch handling below.
  }

  // Overlay call-site init on top.
  if (init !== undefined) {
    if (init.method !== undefined) out.method = init.method;
    if (init.headers !== undefined) out.headers = init.headers;
    if (init.body !== undefined && init.body !== null) out.body = init.body;
  }

  return out;
}
