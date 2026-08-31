/**
 * fetch-baseline.integration.test.ts
 *
 * Deterministic HTTPS smoke test — localhost-only baseline.
 *
 * Goal: prove the in-process interceptor captures a real HTTPS request
 * end-to-end without relying on public DNS, external internet access, or
 * provider credentials. This keeps the test deterministic in CI while
 * still exercising the same Node fetch + TLS + interceptor path as a real
 * networked request.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { createServer, request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AddressInfo } from 'node:net';
import { Interceptor } from './interceptor';
import type { LlmLogEntry } from './options';

function generateLocalHttpsFiles(): { certPath: string; keyPath: string } {
  const dir = mkdtempSync(join(tmpdir(), 'elenwatch-https-'));
  const certPath = join(dir, 'localhost-cert.pem');
  const keyPath = join(dir, 'localhost-key.pem');

  const result = spawnSync(
    'openssl',
    [
      'req',
      '-x509',
      '-newkey',
      'rsa:2048',
      '-nodes',
      '-keyout',
      keyPath,
      '-out',
      certPath,
      '-subj',
      '/CN=localhost',
      '-days',
      '1',
    ],
    { stdio: 'pipe', encoding: 'utf8' },
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to generate local HTTPS certificate: ${result.stderr || result.stdout || 'unknown error'}`,
    );
  }

  return { certPath, keyPath };
}

async function startLocalHttpsServer(): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const { certPath, keyPath } = generateLocalHttpsFiles();
  const server = createServer(
    {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath),
    },
    (
      _req: unknown,
      res: {
        writeHead: (status: number, headers: Record<string, string>) => void;
        end: (body: string) => void;
      },
    ) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, ping: 'fetch-baseline' }));
    },
  );

  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve());
  });

  const address = server.address() as AddressInfo;
  return {
    url: `https://127.0.0.1:${address.port}/`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error | null) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
      rmSync(keyPath.replace(/localhost-key\.pem$/, ''), {
        recursive: true,
        force: true,
      });
    },
  };
}

function fetchBaselineSuite(): void {
  test('raw fetch to a localhost HTTPS endpoint is captured by the interceptor', async () => {
    const previousTlsSetting = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
    process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

    const entries: LlmLogEntry[] = [];
    let server: { url: string; close: () => Promise<void> } | undefined;

    try {
      server = await startLocalHttpsServer();
      const interceptor = new Interceptor({
        providers: [/127\.0\.0\.1|localhost/],
        logger: (entry: LlmLogEntry) => entries.push(entry),
      });
      interceptor.install();

      try {
        const requestUrl = server?.url;
        if (!requestUrl) {
          throw new Error('Local HTTPS test server did not bind an address');
        }

        await new Promise<void>((resolve, reject) => {
          const req = httpsRequest(
            requestUrl,
            {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              rejectUnauthorized: false,
            },
            (res) => {
              res.resume();
              res.on('end', () => resolve());
            },
          );

          req.on('error', reject);
          req.write(JSON.stringify({ ping: 'fetch-baseline' }));
          req.end();
        });

        await new Promise((resolve) => setImmediate(resolve));
        await new Promise((resolve) => setImmediate(resolve));

        expect(entries.length).toBe(1);
        expect(entries[0].url).toContain('127.0.0.1');
        expect(typeof entries[0].model).toBe('string');
        expect(JSON.stringify(entries[0]).length).toBeGreaterThan(0);
      } finally {
        interceptor.restore();
      }
    } finally {
      if (server) {
        await server.close();
      }
      if (previousTlsSetting === undefined) {
        delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
      } else {
        process.env.NODE_TLS_REJECT_UNAUTHORIZED = previousTlsSetting;
      }
    }
  }, 60000);
}

describe('fetch baseline (local HTTPS)', fetchBaselineSuite);
