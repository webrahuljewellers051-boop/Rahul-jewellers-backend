import {
  readFileSync,
  writeFileSync,
  copyFileSync
} from 'node:fs';

import { execFileSync } from 'node:child_process';

const file = 'server.js';
const original = readFileSync(file, 'utf8');
const crlf = original.includes('\r\n');

let code = original.replace(/\r\n/g, '\n');

function replaceOnce(before, after, label) {
  const count = code.split(before).length - 1;

  if (count !== 1) {
    throw new Error(
      `${label}: expected one match, found ${count}. Nothing saved.`
    );
  }

  code = code.replace(before, after);
}

// 1. Make product description required
replaceOnce(
  "  description: {\n    type: String,\n    default: ''\n  },\n  price: {",
  "  description: {\n    type: String,\n    required: true,\n    trim: true\n  },\n  price: {",
  'Product description schema'
);

// 2. Update product gallery validation
const start = 'function normalizeImages(body, existing = []) {';
const end = '\nasync function getRootCategory(';

const startAt = code.indexOf(start);
const endAt = code.indexOf(end, startAt);

if (
  startAt < 0 ||
  endAt < 0 ||
  code.indexOf(start, startAt + 1) >= 0
) {
  throw new Error(
    'Cannot locate unique normalizeImages function. Nothing saved.'
  );
}

code = code.slice(0, startAt) + `
// Protect MongoDB documents from oversized image galleries.
const MAX_PRODUCT_IMAGES = 12;
const MAX_EMBEDDED_IMAGE_CHARS = 6 * 1024 * 1024;

function normalizeImages(body, existing = []) {
  if (
    body.images === undefined &&
    body.imageUrl === undefined
  ) {
    return existing;
  }

  const images = Array.isArray(body.images)
    ? body.images
    : body.imageUrl
      ? [body.imageUrl]
      : existing;

  if (!images.length) {
    bad(400, 'At least one product photo is required.');
  }

  if (images.length > MAX_PRODUCT_IMAGES) {
    bad(
      400,
      'Maximum ' + MAX_PRODUCT_IMAGES +
      ' product photos are allowed.'
    );
  }

  let embeddedChars = 0;

  const normalized = images.map((image, index) => {
    const url = typeof image === 'string'
      ? image
      : image?.url;

    const alt = typeof image === 'string'
      ? ''
      : image?.alt;

    if (!validJewelleryImage(url)) {
      bad(
        400,
        'Invalid HTTPS image URL or image data at position ' +
        (index + 1)
      );
    }

    const cleanUrl = String(url);

    if (cleanUrl.startsWith('data:')) {
      embeddedChars += cleanUrl.length;
    } else if (cleanUrl.length > 2048) {
      bad(400, 'Image URL exceeds 2048 characters.');
    }

    return {
      url: cleanUrl,
      alt: safe(alt, 150)
    };
  });

  if (embeddedChars > MAX_EMBEDDED_IMAGE_CHARS) {
    bad(
      413,
      'Photos exceed the 6 MB storage budget. ' +
      'Compress them or use HTTPS image URLs.'
    );
  }

  return normalized;
}
` + code.slice(endAt);

// 3. First gallery photo is the main product photo
replaceOnce(
  `    if (images.length) {
      fields.imageUrl = images[0].url;
    } else if (body.imageUrl) {
      fields.imageUrl = String(body.imageUrl);
    }`,
  `    fields.imageUrl = images[0].url;`,
  'Main product image'
);

// 4. Product creation validation
replaceOnce(
  `    if (!fields.title || !fields.weight) {
      bad(
        400,
        'Product name and weight are required.'
      );
    }`,
  `    if (!fields.title || !fields.weight || !fields.description) {
      bad(400, 'Product name, main weight and description are required.');
    }`,
  'Create product validation'
);

// 5. Product editing validation
replaceOnce(
  `      !existing.weight ||
      !existing.imageUrl`,
  `      !existing.weight ||
      !existing.description ||
      !existing.imageUrl`,
  'Edit product validation'
);

replaceOnce(
  `'Name, category, weight and image are required.'`,
  `'Name, category, main weight, description and main image are required.'`,
  'Edit product error message'
);

// 6. Backup and save
const updated = crlf
  ? code.replace(/\n/g, '\r\n')
  : code;

const backup = `server.pre-step2-${Date.now()}.bak`;

copyFileSync(file, backup);
writeFileSync(file, updated, 'utf8');

// 7. Syntax check; restore server.js on failure
try {
  execFileSync(
    process.execPath,
    ['--check', file],
    { stdio: 'inherit' }
  );

  execFileSync(
    process.execPath,
    ['--check', 'categoryPolicy.js'],
    { stdio: 'inherit' }
  );

  console.log(
    `SUCCESS: Backend Step 2 updated. Backup: ${backup}`
  );
} catch (error) {
  copyFileSync(backup, file);

  console.error(
    'Syntax check failed. Original server.js restored.'
  );

  process.exitCode = 1;
}