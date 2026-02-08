import 'dotenv/config';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import sharp from 'sharp';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 1024 * 1024 * 1024);

const app = Fastify({
  logger: true,
  bodyLimit: MAX_FILE_SIZE
});

await app.register(multipart, {
  limits: {
    fileSize: MAX_FILE_SIZE,
    files: 1
  }
});

await app.register(cors, {
  origin: process.env.CORS_ORIGIN || true,
  hook: 'onRequest'
});

app.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', process.env.CORS_ORIGIN || '*');
  reply.header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  reply.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (request.method === 'OPTIONS') {
    reply.code(204).send();
  }
});

/* ---------------------------------- ROUTES ---------------------------------- */

// Root route (prevents 404 when opening browser)
app.get('/', async () => ({
  service: 'Image Convert API',
  status: 'running'
}));

// Health check endpoint
app.get('/health', async () => ({ status: 'ok' }));

// Convert endpoint
app.post('/convert', async (request, reply) => {
  const format = (request.query?.format || 'avif')
    .toString()
    .toLowerCase();
  const keepMetadata =
    request.query?.keepMetadata?.toString().toLowerCase() === '1';

  if (!isAllowedFormat(format)) {
    reply.code(400);
    return {
      error:
        'Unsupported format. Use one of: avif, webp, png, jpeg, jpg, svg.'
    };
  }

  const file = await request.file();

  if (!file) {
    reply.code(400);
    return { error: 'No file uploaded' };
  }

  const sourceStream = file.file;

  // Stop stream temporarily while validating
  sourceStream.pause();

  const head = await readHead(sourceStream, 4100);
  const magic = detectMagic(head);

  if (!magic.valid) {
    sourceStream.destroy();
    reply.code(415);
    return { error: 'Unsupported or invalid image signature' };
  }

  if (format === 'svg' && magic.kind !== 'svg') {
    sourceStream.destroy();
    reply.code(415);
    return { error: 'SVG output only supported for SVG inputs' };
  }

  // Rebuild full stream (head + rest of file)
  const bodyStream = new PassThrough();
  bodyStream.write(head);
  sourceStream.pipe(bodyStream);
  sourceStream.resume();

  // Prevent hanging streams if client disconnects
  reply.raw.on('close', () => {
    sourceStream.destroy();
    bodyStream.destroy();
  });

  // SVG passthrough
  if (format === 'svg') {
    return reply.type('image/svg+xml').send(bodyStream);
  }

  // Sharp transformer
  const transformer = sharp({
    failOnError: false,
    sequentialRead: true
  }).rotate(); // auto-fix EXIF orientation
  if (keepMetadata) {
    transformer.withMetadata();
  }

  applyOutputFormat(transformer, format);

  const outputStream = bodyStream.pipe(transformer);

  return reply
    .type(contentTypeForFormat(format))
    .header('Content-Disposition', `inline; filename="converted.${format}"`)
    .send(outputStream);
});

/* ------------------------------ ERROR HANDLER ------------------------------ */

app.setErrorHandler((error, _request, reply) => {
  app.log.error(error);
  if (!reply.sent) {
    reply.code(500).send({ error: 'Conversion failed' });
  }
});

/* ------------------------------- START SERVER ------------------------------- */

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

/* -------------------------------- UTILITIES -------------------------------- */

async function readHead(stream, size) {
  let total = 0;
  const chunks = [];

  while (total < size) {
    const chunk = stream.read(size - total);

    if (chunk) {
      chunks.push(chunk);
      total += chunk.length;
      continue;
    }

    if (stream.readableEnded) break;

    await once(stream, 'readable');
  }

  return Buffer.concat(chunks, total);
}

// File signature detection (magic bytes)
function detectMagic(buffer) {
  const header = buffer.slice(0, 12);
  const ascii = header.toString('ascii');
  const utf8 = buffer.toString('utf8').toLowerCase();

  if (
    buffer.length >= 8 &&
    buffer
      .slice(0, 8)
      .equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
  ) {
    return { valid: true, kind: 'png' };
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return { valid: true, kind: 'jpeg' };
  }

  if (ascii.startsWith('RIFF') && ascii.slice(8, 12) === 'WEBP') {
    return { valid: true, kind: 'webp' };
  }

  if (ascii.slice(4, 12).includes('ftypavif') || ascii.slice(4, 12).includes('ftypavis')) {
    return { valid: true, kind: 'avif' };
  }

  if (ascii.startsWith('GIF87a') || ascii.startsWith('GIF89a')) {
    return { valid: true, kind: 'gif' };
  }

  if (utf8.includes('<svg')) {
    return { valid: true, kind: 'svg' };
  }

  return { valid: false, kind: 'unknown' };
}

function applyOutputFormat(transformer, format) {
  switch (format) {
    case 'webp':
      transformer.webp({ quality: 80, effort: 4 });
      break;

    case 'png':
      transformer.png({
        compressionLevel: 9,
        adaptiveFiltering: true
      });
      break;

    case 'jpeg':
    case 'jpg':
      transformer.jpeg({
        quality: 82,
        mozjpeg: true
      });
      break;

    case 'avif':
    default:
      transformer.avif({
        quality: 50,
        effort: 4
      });
      break;
  }
}

function contentTypeForFormat(format) {
  switch (format) {
    case 'webp':
      return 'image/webp';

    case 'png':
      return 'image/png';

    case 'jpeg':
    case 'jpg':
      return 'image/jpeg';

    case 'avif':
    default:
      return 'image/avif';
  }
}

function isAllowedFormat(format) {
  switch (format) {
    case 'webp':
    case 'png':
    case 'jpeg':
    case 'jpg':
    case 'avif':
    case 'svg':
      return true;
    default:
      return false;
  }
}
