# Auralis — Web Research AI

Auralis is a self-hosted research assistant. It searches the live web (DuckDuckGo),
fetches full page content, and synthesizes grounded, cited answers with an **open
local model** — no API keys, no Gemini, no cloud AI calls.

## Features

- **Live web research** — DuckDuckGo search (with an HTML-endpoint fallback),
  page-content extraction via Readability, and cited synthesis.
- **＋ Tools menu** (in the composer) — Web search & Deep research toggles,
  file attachments, voice input, and the local model manager.
- **Attach files**
  - **Images** → analyzed by **LFM 2.5 VL 450M**, the vision model from
    [Local-Browser-AI](https://github.com/techjarves/local-browser-ai), running
    in your browser via WebGPU. Ask any question about the image, or combine it
    with web research.
  - **Audio** → transcribed on-device by **Whisper base** (transformers.js),
    then answered like any other message.
  - **PDF / txt / md / csv / json** → text is extracted and given to the
    research model as primary material.
- **Voice input** — live microphone dictation via the Web Speech API (no
  download needed), or attach an audio file to have it transcribed locally.
- **Optional local models** — nothing downloads until you ask. Open
  **＋ → Local models** to download (with live progress bars):
  | Model | Size | Use |
  |---|---|---|
  | LFM 2.5 1.2B Thinking | ~760 MB | Research synthesis in-browser (WebGPU) |
  | LFM 2.5 VL 450M | ~770 MB | Vision / image Q&A (WebGPU) |
  | Whisper base | ~95 MB | Speech-to-text for attached audio |
  Once downloaded, models are cached by the browser and run fully offline.
  The server also runs the research model as a no-download fallback.
- **Memory** — "remember that I…" facts persist per device/account and are
  injected into later chats.

## Run locally

```bash
npm install
npm start
# open http://localhost:3000
```

Optional: copy `.env.example` to `.env` and add Google OAuth credentials to
enable sign-in (memory then follows the account instead of the device).

## Deploy

Pushing to `main` triggers the GitHub Action + Render deploy hook (see
`.github/workflows/deploy.yml`; it skips cleanly when Render secrets are absent).
