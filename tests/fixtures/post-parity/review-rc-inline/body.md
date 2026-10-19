**Verdict: request changes** — two blockers, one nit.

1. `parse()` drops the trailing "é" — see "naïve" handling (日本語, 🙂).
2. Path join uses a backslash: C:\temp\new\table and a literal \n sequence.

```ts
const x = JSON.parse('{"a":"b\\n"}');
```

Quote: "double", 'single', <angle> & ampersand, $dollar `tick`.
