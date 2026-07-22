# Cruise Compass AI Friend

AI-powered voice question answering for the Odyssey of the Seas 7-night Greek Isles Cruise Compass, May 17, 2026.

## What changed from the first site

- Uses a server-side OpenAI API call instead of plain browser text search.
- Keeps `OPENAI_API_KEY` private on Render as an environment variable.
- Answers from the OCR-read PDF context and returns page references.

## Render settings

- Runtime: Node
- Build command: `npm install`
- Start command: `npm start`
- Environment variable: `OPENAI_API_KEY`
- Optional environment variable: `OPENAI_MODEL`

The default model is `gpt-5.6-sol`, based on the current OpenAI model resolver available in this Codex workspace.
