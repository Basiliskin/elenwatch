# elenwatch

Near-zero-latency interception of in-process LLM provider HTTP/HTTPS traffic with pluggable loggers, per-provider parsers, request/response transformers, and payload redaction.

## Install

```sh
npm install elenwatch
```

## Usage

Pass a custom logger through the `logger:` option to receive one entry per intercepted call:

```ts
import { Interceptor } from 'elenwatch';

const interceptor = new Interceptor({
  logger: (entry) => {
    console.log(JSON.stringify(entry));
  },
});

interceptor.install(); // start intercepting in-process LLM calls

// ...run your LLM requests...

interceptor.restore(); // stop intercepting (idempotent)
```

The `logger:` option accepts any function matching `(entry: LlmLogEntry) => void`, so you can route entries to your own logging or telemetry pipeline.
