# Manuscripts API — IntelliJ HTTP Client

Environment variables for `.http` requests come from `http-client.env.json` plus optional overrides in **`http-client.private.env.json`** (same JSON shape per environment name). Put real `secret` and non-local `host` values in the private file; it is gitignored.

Create `http-client.private.env.json` next to this file, for example:

```json
{
  "dev": {
    "host": "localhost:3000",
    "secret": "your-manuscripts-app-secret"
  }
}
```

JetBrains merges the private file over the public one for matching keys.
