# Safe demonstration files

`demo.patch` is invented input. It is safe to pass to the real CLI with your own installed Ollama model or prepared browser sessions:

```sh
npm run review -- --task "Review this signup change for input validation and error handling" --diff examples/demo.patch --provider ollama --model MODEL_NAME
```

`sample-audit.json` and `sample-terminal-report.txt` are **synthetic illustrations**, not captured live-provider output. They show the current CLI envelope/report shape and a possible human rejection of a missing null check. Their model name is deliberately `synthetic-example-not-run` so nobody mistakes them for evidence that a model was executed. A real run will produce different text, timestamps, recommendations, and claim history; it writes its own audit outside the repository by default.
