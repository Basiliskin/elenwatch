import {
  Module,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import {
  Interceptor,
  consoleLogger,
  LlmLogEntry,
  InterceptorOptions,
  ProviderParser,
  DEFAULT_SENSITIVE_FIELDS,
  defaultParser,
  VERSION as LLM_HTTP_PROXY_VERSION,
} from 'elenwatch';

const RECENT_CALLS: LlmLogEntry[] = [];
const MAX_RECENT = 50;

const captureLogger = (entry: LlmLogEntry): void => {
  RECENT_CALLS.unshift(entry);
  if (RECENT_CALLS.length > MAX_RECENT) {
    RECENT_CALLS.pop();
  }
  consoleLogger(entry);
};

const customProviderParser: ProviderParser = {
  extractModel: (requestJson) => {
    const model = defaultParser.extractModel(requestJson);
    return model === 'unknown' ? 'elenwatch-fallback' : model;
  },
  estimateInputTokens: (requestJson) => {
    const text = JSON.stringify(requestJson ?? {});
    return Math.ceil(text.length / 3);
  },
  extractOutputTokens: (responseJson) => {
    const obj = (responseJson ?? {}) as { usage?: { total_tokens?: number } };
    return obj.usage?.total_tokens ?? 0;
  },
};

const interceptorOptions: InterceptorOptions = {
  providers: [
    'api.openai.com',
    'api.anthropic.com',
    'api.cohere.ai',
    'api.mistral.ai',
    /^https?:\/\/.*\.internal\.elenwatch\.test$/,
  ],
  capturePayloads: true,
  logger: captureLogger,
  providerParser: customProviderParser,
  tokenCounter: {
    estimateInputTokens: (requestBody) =>
      Math.ceil(JSON.stringify(requestBody ?? {}).length / 4),
    extractOutputTokens: (responseBody) =>
      (responseBody as { usage?: { completion_tokens?: number } } | null)?.usage
        ?.completion_tokens ?? 0,
  },
  redaction: {
    sensitiveFields: [...DEFAULT_SENSITIVE_FIELDS, 'elenwatchSecret'],
    placeholder: '[REDACTED]',
  },
};

export const llmHttpInterceptor = new Interceptor(interceptorOptions);

@Module({
  imports: [],
  controllers: [AppController],
  providers: [
    AppService,
    {
      provide: 'LLM_HTTP_PROXY_INTERCEPTOR',
      useValue: llmHttpInterceptor,
    },
    {
      provide: 'LLM_HTTP_PROXY_RECENT_CALLS',
      useValue: RECENT_CALLS,
    },
    {
      provide: 'LLM_HTTP_PROXY_VERSION',
      useValue: LLM_HTTP_PROXY_VERSION,
    },
  ],
})
export class AppModule
  implements OnApplicationBootstrap, OnApplicationShutdown
{
  onApplicationBootstrap(): void {
    llmHttpInterceptor.install();
  }

  onApplicationShutdown(): void {
    llmHttpInterceptor.restore();
  }
}
