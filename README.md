# AVIFY Backend

Fastify-based image conversion API used by the AVIFY frontend. Designed for Render deployment.

## Features
- Convert images to AVIF, WebP, PNG, JPEG, or SVG
- Streaming conversion with Sharp
- CORS support for frontend deployments

## Requirements
- Node.js 18+ recommended
- npm 9+ recommended

## Local Development
```bash
npm install
npm run dev
```

Server runs on `http://localhost:3000` by default.

## Environment Variables
Create `.env` or set these in your host:
```
PORT=3000
HOST=0.0.0.0
MAX_FILE_SIZE=1073741824
CORS_ORIGIN=http://localhost:4200
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_API_KEY=your_api_key
CLOUDINARY_API_SECRET=your_api_secret
CLOUDINARY_FOLDER=converted
```

## API

### POST `/convert`
- `multipart/form-data` with a single field named `file`
- Query params:
  - `format` — `avif | webp | png | jpeg | jpg | svg`
  - `keepMetadata` — `1` to preserve metadata (default strips metadata)

Example:
```bash
curl -X POST "http://localhost:3000/convert?format=webp" \
  -F "file=@./image.jpg" \
  --output converted.webp
```

### POST `/convert/upload`
Uploads the converted image to Cloudinary and returns a JSON response.
- `multipart/form-data` with a single field named `file`
- Query params:
  - `format` â€” `avif | webp | png | jpeg | jpg | svg`
  - `keepMetadata` â€” `1` to preserve metadata (default strips metadata)

Example:
```bash
curl -X POST "http://localhost:3000/convert/upload?format=avif" \
  -F "file=@./image.jpg"
```

### POST `/upload`
Uploads the original image to Cloudinary and returns transformed URLs (fastest path).
- `multipart/form-data` with a single field named `file`

Example:
```bash
curl -X POST "http://localhost:3000/upload" \
  -F "file=@./image.jpg"
```

## Deployment (Render)
Use the repo-level `render.yaml` or configure manually:
- Root directory: `backend/`
- Build: `npm install`
- Start: `npm run start`
- Env vars:
  - `PORT=10000`
  - `HOST=0.0.0.0`
  - `CORS_ORIGIN=https://YOUR_VERCEL_DOMAIN`

## Notes
- SVG output only supports SVG inputs.
- Render free tier may sleep; first request can be slow.
