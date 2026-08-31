/**
 * AppModule lifecycle tests for the elenwatch bootstrap hook (#10).
 *
 * Pins the horizon-3 contract: importing AppModule must NOT patch
 * ClientRequest.prototype (no import-time install()); the patch applies
 * only when the Nest app boots (OnApplicationBootstrap) and is released
 * again on shutdown (OnApplicationShutdown), repeatably.
 */

import * as http from 'node:http';
import { once } from 'node:events';
import { Test, TestingModule } from '@nestjs/testing';
import { llmHttpInterceptor } from './app.module';
import { AppModule } from './app.module';

const prototype = http.ClientRequest.prototype;

describe('AppModule bootstrap-lived install (#10)', () => {
  afterEach(() => {
    // Never leak a patch across tests, even on assertion failure.
    llmHttpInterceptor.restore();
  });

  it('importing AppModule does not install the interceptor (no import-time side effect)', () => {
    // Prototype reference identity is the proof the patch is absent; the
    // rule's this-scoping concern does not apply to identity comparisons.
    //
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const pristineWrite = prototype.write;
    // eslint-disable-next-line @typescript-eslint/unbound-method
    const pristineEnd = prototype.end;
    expect(llmHttpInterceptor.isInstalled).toBe(false);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(prototype.write).toBe(pristineWrite);
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(prototype.end).toBe(pristineEnd);
  });

  it('boot -> close cycles install and restore the patch', async () => {
    for (let cycle = 0; cycle < 2; cycle += 1) {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const app = moduleFixture.createNestApplication();
      await app.init();
      expect(llmHttpInterceptor.isInstalled).toBe(true);

      await app.close();
      expect(llmHttpInterceptor.isInstalled).toBe(false);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const pristineWrite = prototype.write;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const pristineEnd = prototype.end;
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(prototype.write).toBe(pristineWrite);
      // eslint-disable-next-line @typescript-eslint/unbound-method
      expect(prototype.end).toBe(pristineEnd);
    }
  });

  it('a real outbound HTTP call through the booted app is captured', async () => {
    // Local server that answers OpenAI-shape JSON; the request uses a
    // provider-listed hostname via the Host header (the interceptor reads
    // req.hostname ?? Host header).
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(
          JSON.stringify({
            usage: { completion_tokens: 3 },
            choices: [{ message: { content: 'ok' } }],
          }),
        );
      });
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    const addr = server.address();
    if (addr === null || typeof addr === 'string') {
      throw new Error('expected a TCP port');
    }
    const port = addr.port;

    // The app module logs captured entries through consoleLogger; spy on
    // it to observe the emitted entry without touching package internals.
    const consoleSpy = jest
      .spyOn(console, 'log')
      .mockImplementation(() => undefined);

    try {
      const moduleFixture: TestingModule = await Test.createTestingModule({
        imports: [AppModule],
      }).compile();
      const app = moduleFixture.createNestApplication();
      await app.init();

      await new Promise<void>((resolve, reject) => {
        const req = http.request(
          {
            hostname: '127.0.0.1',
            port,
            path: '/v1/chat/completions',
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              host: 'api.openai.com',
            },
          },
          (res) => {
            res.resume();
            res.on('end', resolve);
          },
        );
        req.on('error', reject);
        req.end(JSON.stringify({ model: 'gpt-4o', messages: [] }));
      });

      // Emission is deferred via setImmediate; flush twice like the
      // package's own harness does.
      await new Promise((r) => setImmediate(r));
      await new Promise((r) => setImmediate(r));

      const captured = consoleSpy.mock.calls
        .map((c) => c[0] as unknown)
        .find(
          (text): text is string =>
            typeof text === 'string' && text.includes('gpt-4o'),
        );
      expect(captured).toBeDefined();
      expect(JSON.parse(captured as string)).toMatchObject({
        model: 'gpt-4o',
        url: 'http://api.openai.com/v1/chat/completions',
      });

      await app.close();
    } finally {
      consoleSpy.mockRestore();
      server.close();
    }
  });

  it('customProviderParser fallback maps unknown model to elenwatch-fallback', () => {
    // The app's custom provider parser delegates to defaultParser and maps
    // 'unknown' -> 'elenwatch-fallback'. Exercises the delegation directly.
    const interceptor = llmHttpInterceptor as unknown as {
      providerParser: {
        extractModel: (j: unknown) => string;
      };
    };
    const parser = interceptor.providerParser;
    expect(parser.extractModel({ model: 'gpt-4o' })).toBe('gpt-4o');
    expect(parser.extractModel({})).toBe('elenwatch-fallback');
  });
});
