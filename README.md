# Debater

AI dictation workspace with realtime speech-to-text, post-confirmation text polishing, bilingual output, settings, and local history.

## Run

```bash
npm install
npm run dev
```

Open the client at `http://localhost:5173`.

## API key

Set an OpenAI API key in the Settings page, or export it before starting the server:

```bash
export OPENAI_API_KEY="sk-..."
```

The browser receives only a short-lived Realtime client secret. The real API key stays on the server.
