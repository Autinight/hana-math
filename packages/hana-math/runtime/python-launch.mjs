// Fixed package/SDK contract, selected only by a trusted bridge constructor.
import fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

export const PYTHON_VERSION = '3.12.14';
const mac = Object.freeze({ executable: 'dependencies/python/bin/python3', profile: 'scoped', network: 'none', windows: false });
const windows = Object.freeze({ executable: 'dependencies/python/python.exe', profile: 'native', network: 'external', windows: true });
export function pythonLaunch(platform, arch, fail) {
  if (platform === 'darwin' && arch === 'arm64') return mac;
  if (platform === 'win32' && arch === 'x64') return windows;
  throw fail('UNSUPPORTED', 'Only packaged darwin-arm64 or win32-x64 Python is supported');
}
export function matchesPythonRuntime(info, launch) {
  return !!launch && info.runtime === 'command' && info.profile === launch.profile && info.network === launch.network
    && (!launch.windows || info.enforcement === undefined || info.enforcement === 'partial');
}
export function windowsAbsolute(value) {
  // Local drive paths only: no UNC/device paths, drive-relative paths, ADS or
  // components that Win32 may silently rewrite. Do not fold component case.
  return typeof value === 'string' && /^[A-Za-z]:\\/.test(value) && path.win32.resolve(value) === value
    && value.slice(3).split('\\').every(part => !/[:<>"/|?*\x00-\x1f]|[. ]$|^(?:con|prn|aux|nul|conin\$|conout\$|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/i.test(part));
}
export const sameWindowsPath = (a, b) => a.slice(0, 2).toUpperCase() === b.slice(0, 2).toUpperCase() && a.slice(2) === b.slice(2);
export function insideRoot(root, child) {
  const relative = path.relative(root, child);
  return relative !== '' && relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

const singleFile = stat => stat.isFile() && stat.nlink === 1n && stat.ino !== 0n;
const sameFile = (a, b) => singleFile(a) && singleFile(b) && a.dev === b.dev && a.ino === b.ino
  && a.mode === b.mode && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
// Node does not offer a Windows OPEN_REPARSE_POINT read. Never use an absent
// O_NOFOLLOW as a guarantee: read only after matching the canonical checked
// path's identity to the opened handle, and recheck before accepting any bytes.
// These checks complement Host-owned roots/ACLs, not an atomic Win32 lock.
export async function withWindowsFile(file, checkPath, invalid, read) {
  const checked = async () => { await checkPath(); return fs.lstat(file, { bigint: true }); };
  const before = await checked();
  if (!singleFile(before)) throw invalid();
  const handle = await fs.open(file, constants.O_RDONLY);
  try {
    const verify = async () => {
      if (!sameFile(before, await handle.stat({ bigint: true })) || !sameFile(before, await checked())) throw invalid();
    };
    await verify();
    const value = await read(handle);
    await verify();
    return value;
  } finally { await handle.close(); }
}

// Fresh exchange files use exclusive creation, never writable non-exclusive
// opens. Recheck the owned directory and compare the new handle before writing.
export async function openWindowsExclusive(file, checkPath, invalid) {
  await checkPath(false);
  const handle = await fs.open(file, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try {
    await checkPath(true);
    if (!sameFile(await handle.stat({ bigint: true }), await fs.lstat(file, { bigint: true }))) throw invalid();
    return handle;
  } catch (error) { await handle.close(); throw error; }
}
