import { readFile, writeFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const version = (await readFile(new URL('VERSION', root), 'utf8')).trim();
const semverPattern = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

if (!semverPattern.test(version)) {
  throw new Error(`VERSION must be a semver value like 1.2.3 or 1.2.3-beta.1. Received: ${version}`);
}

async function updateJson(relativePath, applyVersion) {
  const file = new URL(relativePath, root);
  const data = JSON.parse(await readFile(file, 'utf8'));
  applyVersion(data);
  await writeFile(file, `${JSON.stringify(data, null, 2)}\n`);
}

await updateJson('package.json', (data) => {
  data.version = version;
});

await updateJson('package-lock.json', (data) => {
  data.version = version;
  if (data.packages?.['']) data.packages[''].version = version;
});

await updateJson('src-tauri/tauri.conf.json', (data) => {
  data.version = version;
});

const cargoFile = new URL('src-tauri/Cargo.toml', root);
const cargo = await readFile(cargoFile, 'utf8');
let cargoVersionFound = false;
const nextCargo = cargo.replace(
  /(^\[package\][\s\S]*?^version\s*=\s*")[^"]+(")/m,
  (_match, start, end) => {
    cargoVersionFound = true;
    return `${start}${version}${end}`;
  },
);

if (!cargoVersionFound) {
  throw new Error('Could not update package version in src-tauri/Cargo.toml');
}

await writeFile(cargoFile, nextCargo);
