import 'dotenv/config';
import Fastify from 'fastify';
import multipart from '@fastify/multipart';
import cors from '@fastify/cors';
import sharp from 'sharp';
import { PassThrough } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { once } from 'node:events';
import { v2 as cloudinary } from 'cloudinary';

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || '0.0.0.0';
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 1024 * 1024 * 1024);
const CLOUDINARY_CLOUD_NAME = process.env.CLOUDINARY_CLOUD_NAME || '';
const CLOUDINARY_API_KEY = process.env.CLOUDINARY_API_KEY || '';
const CLOUDINARY_API_SECRET = process.env.CLOUDINARY_API_SECRET || '';
const CLOUDINARY_FOLDER = process.env.CLOUDINARY_FOLDER || 'converted';
const CLOUDINARY_ENABLED =
  CLOUDINARY_CLOUD_NAME && CLOUDINARY_API_KEY && CLOUDINARY_API_SECRET;

if (CLOUDINARY_ENABLED) {
  cloudinary.config({
    cloud_name: CLOUDINARY_CLOUD_NAME,
    api_key: CLOUDINARY_API_KEY,
    api_secret: CLOUDINARY_API_SECRET,
    secure: true
  });
}

const normalizeOrigin = (value) => {
  if (!value || value === '*') return value || '*';
  return value.replace(/\/$/, '');
};

const CORS_ORIGIN = normalizeOrigin(process.env.CORS_ORIGIN || '*');

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
  origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN,
  hook: 'onRequest'
});

app.addHook('onRequest', async (request, reply) => {
  reply.header('Access-Control-Allow-Origin', CORS_ORIGIN);
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

  let converted;
  try {
    converted = await createConvertedStream({
      fileStream: file.file,
      format,
      keepMetadata
    });
  } catch (error) {
    if (error instanceof HttpError) {
      reply.code(error.statusCode);
      return { error: error.message };
    }
    throw error;
  }

  reply.raw.on('close', () => {
    converted.cleanup();
  });

  return reply
    .type(converted.contentType)
    .header('Content-Disposition', `inline; filename="converted.${format}"`)
    .send(converted.stream);
});

// Convert + upload to Cloudinary (server-side conversion)
app.post('/convert/upload', async (request, reply) => {
  if (!CLOUDINARY_ENABLED) {
    reply.code(500);
    return { error: 'Cloudinary is not configured on this server.' };
  }

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

  let converted;
  try {
    converted = await createConvertedStream({
      fileStream: file.file,
      format,
      keepMetadata
    });
  } catch (error) {
    if (error instanceof HttpError) {
      reply.code(error.statusCode);
      return { error: error.message };
    }
    throw error;
  }

  const publicId = buildPublicId(file.filename);

  reply.raw.on('close', () => {
    converted.cleanup();
  });

  try {
    const result = await uploadToCloudinary(converted.stream, {
      folder: CLOUDINARY_FOLDER,
      public_id: publicId,
      resource_type: 'image',
      overwrite: false
    });

    return reply.send({
      url: result.secure_url,
      bytes: result.bytes,
      format: result.format,
      publicId: result.public_id,
      originalFilename: file.filename || null
    });
  } catch (error) {
    app.log.error(error);
    reply.code(500);
    return { error: 'Cloudinary upload failed' };
  }
});

// Upload original to Cloudinary and return transformed URLs
app.post('/upload', async (request, reply) => {
  if (!CLOUDINARY_ENABLED) {
    reply.code(500);
    return { error: 'Cloudinary is not configured on this server.' };
  }

  const file = await request.file();

  if (!file) {
    reply.code(400);
    return { error: 'No file uploaded' };
  }

  const publicId = buildPublicId(file.filename);

  try {
    const result = await uploadToCloudinary(file.file, {
      folder: CLOUDINARY_FOLDER,
      public_id: publicId,
      resource_type: 'image',
      overwrite: false
    });

    const urls = buildTransformedUrls(result.secure_url);

    return reply.send({
      originalUrl: result.secure_url,
      bytes: result.bytes,
      publicId: result.public_id,
      urls
    });
  } catch (error) {
    app.log.error(error);
    reply.code(500);
    return { error: 'Cloudinary upload failed' };
  }
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

class HttpError extends Error {
  constructor(statusCode, message) {
    super(message);
    this.statusCode = statusCode;
  }
}

async function createConvertedStream({ fileStream, format, keepMetadata }) {
  const sourceStream = fileStream;

  sourceStream.pause();
  const head = await readHead(sourceStream, 4100);
  const magic = detectMagic(head);

  if (!magic.valid) {
    sourceStream.destroy();
    throw new HttpError(415, 'Unsupported or invalid image signature');
  }

  if (format === 'svg' && magic.kind !== 'svg') {
    sourceStream.destroy();
    throw new HttpError(415, 'SVG output only supported for SVG inputs');
  }

  const bodyStream = new PassThrough();
  bodyStream.write(head);
  sourceStream.pipe(bodyStream);
  sourceStream.resume();

  const cleanup = () => {
    sourceStream.destroy();
    bodyStream.destroy();
  };

  if (format === 'svg') {
    return {
      stream: bodyStream,
      contentType: 'image/svg+xml',
      cleanup
    };
  }

  const transformer = sharp({
    failOnError: false,
    sequentialRead: true
  }).rotate();
  if (keepMetadata) {
    transformer.withMetadata();
  }

  applyOutputFormat(transformer, format);

  return {
    stream: bodyStream.pipe(transformer),
    contentType: contentTypeForFormat(format),
    cleanup
  };
}

function buildPublicId(filename) {
  const base = (filename || 'image').replace(/\.[^.]+$/, '');
  const normalized = base
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/(^-|-$)/g, '');
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return `${normalized || 'image'}-${suffix}`;
}

function buildTransformedUrls(secureUrl) {
  const base = (format, quality = 'q_auto') =>
    secureUrl.replace('/upload/', `/upload/f_${format},${quality}/`);

  return {
    avif: base('avif'),
    webp: base('webp'),
    jpeg: base('jpg'),
    jpg: base('jpg'),
    png: base('png')
  };
}

async function uploadToCloudinary(readable, options) {
  return new Promise((resolve, reject) => {
    const uploadStream = cloudinary.uploader.upload_stream(options, (error, result) => {
      if (error) {
        reject(error);
        return;
      }
      resolve(result);
    });

    pipeline(readable, uploadStream).catch(reject);
  });
}

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
