# EnglishWord Handwriting Worker

Cloudflare Worker for reading handwritten English vocabulary answers with the OpenAI API.

## Deploy

```powershell
cd worker
npx wrangler deploy
```

## Secrets

Do not put these values in GitHub.

```powershell
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put ACCESS_TOKEN
```

Use the deployed Worker URL ending with `/recognize-handwriting` in the app's photo answer-check settings.

## Request

```json
{
  "imageDataUrl": "data:image/jpeg;base64,...",
  "cards": [
    { "ja": "りんご", "en": "apple" }
  ]
}
```

## Response

```json
{
  "items": [
    { "index": 1, "recognized": "apple" }
  ]
}
```
