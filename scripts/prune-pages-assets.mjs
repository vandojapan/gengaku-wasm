import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const root = path.resolve('dist');
const maxAssetSize = 25 * 1024 * 1024;
const removed = [];

await pruneLargeAssets(root);

if (removed.length) {
  console.log('Removed Cloudflare Pages oversized assets:');
  removed.forEach((asset) => {
    console.log(`- ${asset.path} (${formatBytes(asset.size)})`);
  });
}

async function pruneLargeAssets(directory) {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (error.code === 'ENOENT') {
      return;
    }
    throw error;
  }

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await pruneLargeAssets(fullPath);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const info = await stat(fullPath);
    if (info.size <= maxAssetSize) {
      continue;
    }

    await rm(fullPath);
    removed.push({
      path: path.relative(root, fullPath).replace(/\\/g, '/'),
      size: info.size,
    });
  }
}

function formatBytes(bytes) {
  return `${(bytes / 1024 / 1024).toFixed(2)} MiB`;
}
