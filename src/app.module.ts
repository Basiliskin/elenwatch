import { Module } from '@nestjs/common';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { LlmHttpLoggingModule } from './llm-http-logging/llm-http-logging.module';

@Module({
  imports: [
    LlmHttpLoggingModule.register({
      // optional: custom provider list
      providers: ['api.openai.com', 'api.anthropic.com'],
      // optional: custom logger
      logger: (entry) => console.log(entry),
      // optional: precise token counting (use tiktoken)
      // tokenCounter: { ... }
    }),
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
