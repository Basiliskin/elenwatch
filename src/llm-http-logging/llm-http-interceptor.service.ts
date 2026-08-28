// llm-http-interceptor.service.ts
import { Injectable, OnModuleInit } from '@nestjs/common';
import * as http from 'http';
import * as https from 'https';
import { LlmHttpLoggingOptions, LlmLogEntry } from './llm-http-logging.module';

@Injectable()
export class LlmHttpInterceptorService implements OnModuleInit {
  private readonly providers: (string | RegExp)[];
  private readonly logger: (entry: LlmLogEntry) => void;
  private readonly tokenCounter: {
    estimateInputTokens?: (requestBody: any) => number;
    extractOutputTokens?: (responseBody: any) => number;
  };

  constructor(options: LlmHttpLoggingOptions) {
    this.providers = options.providers || [
      'api.openai.com',
      'api.anthropic.com',
      'api.cohere.ai',
      'api.mistral.ai',
      // add others as needed
    ];
    this.logger =
      options.logger || ((entry) => console.log(JSON.stringify(entry)));
    this.tokenCounter = options.tokenCounter || {};
  }

  onModuleInit() {
    this.patchHttpModule(http);
    this.patchHttpModule(https);
  }

  private patchHttpModule(mod: typeof http | typeof https) {
    const originalRequest = mod.request;

    mod.request = function (
      this: any,
      options: any,
      callback?: (res: http.IncomingMessage) => void,
    ) {
      // Determine the URL
      let hostname: string | undefined;
      if (typeof options === 'string') {
        hostname = new URL(options).hostname;
      } else if (options && options.hostname) {
        hostname = options.hostname;
      } else if (options && options.host) {
        hostname = options.host.split(':')[0];
      }

      const shouldIntercept = hostname && this.matchesProvider(hostname);
      const callerTrace = shouldIntercept ? this.getCallerTrace() : '';

      // Call the original request
      const req = originalRequest.call(this, options, callback);

      if (shouldIntercept) {
        this.interceptRequest(req, callerTrace);
      }

      return req;
    } as any;
  }

  private matchesProvider(hostname: string): boolean {
    return this.providers.some((pattern) => {
      if (typeof pattern === 'string') {
        return hostname === pattern || hostname.endsWith(`.${pattern}`);
      }
      return pattern.test(hostname);
    });
  }

  private interceptRequest(req: http.ClientRequest, callerTrace: string) {
    let requestBody = '';
    let responseBody = '';
    let requestHeaders = req.getHeaders();

    // Intercept writes to capture request body
    const originalWrite = req.write.bind(req);
    const originalEnd = req.end.bind(req);

    req.write = function (chunk: any, ...args: any[]) {
      if (chunk) {
        requestBody += chunk.toString();
      }
      return originalWrite(chunk, ...args);
    } as any;

    req.end = function (chunk?: any, ...args: any[]) {
      if (chunk) {
        requestBody += chunk.toString();
      }
      return originalEnd(chunk, ...args);
    } as any;

    // Capture response
    req.on('response', (res: http.IncomingMessage) => {
      res.on('data', (chunk: Buffer) => {
        responseBody += chunk.toString();
      });

      res.on('end', () => {
        this.logLlmCall(req, requestBody, responseBody, callerTrace);
      });
    });

    req.on('error', (err) => {
      // Optionally log errors
    });
  }

  private getCallerTrace(): string {
    const stack = new Error().stack;
    if (!stack) return 'unknown';

    const lines = stack.split('\n');
    // Skip first lines: Error, getCallerTrace, patchHttpModule, originalRequest wrapper
    for (let i = 3; i < lines.length; i++) {
      const line = lines[i];
      if (
        !line.includes('llm-http-interceptor.service') &&
        !line.includes('node_modules')
      ) {
        return line.trim();
      }
    }
    return lines[3]?.trim() || 'unknown';
  }

  private logLlmCall(
    req: http.ClientRequest,
    requestBody: string,
    responseBody: string,
    callerTrace: string,
  ) {
    try {
      const requestJson = JSON.parse(requestBody);
      const responseJson = JSON.parse(responseBody);

      const model = this.extractModel(requestJson);
      const inputTokens = this.tokenCounter.estimateInputTokens
        ? this.tokenCounter.estimateInputTokens(requestJson)
        : this.defaultEstimateInputTokens(requestJson);
      const outputTokens = this.tokenCounter.extractOutputTokens
        ? this.tokenCounter.extractOutputTokens(responseJson)
        : this.defaultExtractOutputTokens(responseJson);

      const url = `${req.protocol}//${req.host}${req.path}`;
      this.logger({
        timestamp: new Date(),
        model,
        inputTokens,
        outputTokens,
        callerTrace,
        url,
      });
    } catch (e) {
      // If JSON parsing fails, log minimal info
      this.logger({
        timestamp: new Date(),
        model: 'unknown',
        inputTokens: 0,
        outputTokens: 0,
        callerTrace,
        url: `${req.protocol}//${req.host}${req.path}`,
      });
    }
  }

  private extractModel(requestJson: any): string {
    // Common fields: model, model_name, etc.
    return requestJson.model || requestJson.model_name || 'unknown';
  }

  private defaultEstimateInputTokens(requestJson: any): number {
    // Heuristic based on common message formats (OpenAI, Anthropic, etc.)
    let text = '';
    if (requestJson.messages) {
      text = requestJson.messages.map((m: any) => m.content || '').join(' ');
    } else if (requestJson.prompt) {
      text = requestJson.prompt;
    } else if (requestJson.input) {
      text = requestJson.input;
    }
    return Math.ceil(text.length / 4); // approx 4 chars per token
  }

  private defaultExtractOutputTokens(responseJson: any): number {
    // OpenAI style
    if (
      responseJson.usage &&
      responseJson.usage.completion_tokens !== undefined
    ) {
      return responseJson.usage.completion_tokens;
    }
    // Anthropic style
    if (responseJson.usage && responseJson.usage.output_tokens !== undefined) {
      return responseJson.usage.output_tokens;
    }
    // Fallback: concatenate text from choices or content
    let text = '';
    if (responseJson.choices) {
      text = responseJson.choices
        .map((c: any) => c.message?.content || c.text || '')
        .join(' ');
    } else if (responseJson.completion) {
      text = responseJson.completion;
    } else if (responseJson.output_text) {
      text = responseJson.output_text;
    }
    return Math.ceil(text.length / 4);
  }
}
