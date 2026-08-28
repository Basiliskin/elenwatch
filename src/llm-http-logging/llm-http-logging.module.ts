// llm-http-logging.module.ts
import { Module, DynamicModule, Provider } from '@nestjs/common';
import { LlmHttpInterceptorService } from './llm-http-interceptor.service';

export interface LlmHttpLoggingOptions {
  /**
   * Array of URL hostnames (or regex patterns) that should be intercepted.
   * Defaults to common LLM providers.
   */
  providers?: (string | RegExp)[];
  /**
   * Custom logger – defaults to console.log
   */
  logger?: (entry: LlmLogEntry) => void;
  /**
   * Optional custom token counting functions.
   * If not provided, a simple character‑based heuristic is used.
   */
  tokenCounter?: {
    estimateInputTokens?: (requestBody: any) => number;
    extractOutputTokens?: (responseBody: any) => number;
  };
}

export interface LlmLogEntry {
  timestamp: Date;
  model: string;
  inputTokens: number;
  outputTokens: number;
  callerTrace: string;
  url: string;
}

@Module({})
export class LlmHttpLoggingModule {
  static register(options: LlmHttpLoggingOptions = {}): DynamicModule {
    const serviceProvider: Provider = {
      provide: LlmHttpInterceptorService,
      useFactory: () => new LlmHttpInterceptorService(options),
    };

    return {
      module: LlmHttpLoggingModule,
      providers: [serviceProvider],
      exports: [LlmHttpInterceptorService],
    };
  }
}
