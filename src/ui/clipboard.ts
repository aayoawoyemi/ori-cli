/**
 * Clipboard reader — returns text, image path, or nothing.
 *
 * Windows: powershell
 * macOS: pbpaste + osascript
 * Linux: xclip / wl-paste
 *
 * Images are saved to a cache dir (reused across sessions) and the path
 * is returned so it can be inserted as a placeholder in the input.
 */
import { execSync } from 'node:child_process';
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir, platform } from 'node:os';
import { randomUUID } from 'node:crypto';

export type ClipboardResult =
  | { type: 'text'; value: string }
  | { type: 'image'; path: string; base64: string; mediaType: string }
  | { type: 'empty' }
  | { type: 'error'; reason: string };

function cacheDir(): string {
  // Mirror Claude Code's convention where possible
  const base = join(homedir(), '.claude', 'image-cache');
  try {
    if (!existsSync(base)) mkdirSync(base, { recursive: true });
    return base;
  } catch {
    const fallback = join(tmpdir(), 'aries-image-cache');
    if (!existsSync(fallback)) mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

function readImageAsBase64(path: string): { base64: string; mediaType: string } {
  const buf = readFileSync(path);
  return { base64: buf.toString('base64'), mediaType: 'image/png' };
}

function windowsClipboard(): ClipboardResult {
  const dir = join(cacheDir(), randomUUID());
  const imgPath = join(dir, 'paste.png').replace(/\\/g, '\\\\');
  // Try image first; if clipboard has no image, fall through to text.
  const script = `
try {
  Add-Type -AssemblyName System.Windows.Forms
  Add-Type -AssemblyName System.Drawing
  $img = [System.Windows.Forms.Clipboard]::GetImage()
  if ($img -ne $null) {
    New-Item -ItemType Directory -Force -Path '${dir.replace(/\\/g, '\\\\')}' | Out-Null
    $img.Save('${imgPath}', [System.Drawing.Imaging.ImageFormat]::Png)
    Write-Output "IMAGE:${imgPath}"
    exit 0
  }
  $text = [System.Windows.Forms.Clipboard]::GetText()
  if ($text) {
    Write-Output "TEXT:"
    Write-Output $text
    exit 0
  }
  Write-Output "EMPTY"
} catch {
  Write-Output "ERROR:$($_.Exception.Message)"
  exit 1
}
`;
  try {
    const out = execSync(
      `powershell -NoProfile -NonInteractive -STA -Command -`,
      { input: script, encoding: 'utf-8', timeout: 5000 },
    );
    const trimmed = out.trimEnd();
    if (trimmed === 'EMPTY') return { type: 'empty' };
    if (trimmed.startsWith('ERROR:')) {
      return { type: 'error', reason: trimmed.slice(6).slice(0, 120) };
    }
    if (trimmed.startsWith('IMAGE:')) {
      const p = trimmed.slice(6).split('\n')[0]!.trim();
      const { base64, mediaType } = readImageAsBase64(p);
      return { type: 'image', path: p, base64, mediaType };
    }
    if (trimmed.startsWith('TEXT:')) {
      return { type: 'text', value: trimmed.slice(5).replace(/^\r?\n/, '') };
    }
    return { type: 'empty' };
  } catch (err) {
    return { type: 'error', reason: (err as Error).message.slice(0, 120) };
  }
}

function macosClipboard(): ClipboardResult {
  // Check for image via osascript first
  const imgPath = join(cacheDir(), `${randomUUID()}.png`);
  try {
    execSync(
      `osascript -e 'set pngData to (the clipboard as «class PNGf»)' -e 'set f to open for access POSIX file "${imgPath}" with write permission' -e 'write pngData to f' -e 'close access f'`,
      { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'ignore'], timeout: 3000 },
    );
    const { base64, mediaType } = readImageAsBase64(imgPath);
    return { type: 'image', path: imgPath, base64, mediaType };
  } catch {
    // Fall through to text
  }
  try {
    const text = execSync('pbpaste', { encoding: 'utf-8', timeout: 3000 });
    if (text) return { type: 'text', value: text };
    return { type: 'empty' };
  } catch (err) {
    return { type: 'error', reason: (err as Error).message.slice(0, 120) };
  }
}

function linuxClipboard(): ClipboardResult {
  // Try wl-paste (Wayland) then xclip (X11)
  const imgPath = join(cacheDir(), `${randomUUID()}.png`);
  const tools = [
    { cmd: `wl-paste -t image/png > "${imgPath}"`, img: true },
    { cmd: `xclip -selection clipboard -t image/png -o > "${imgPath}"`, img: true },
  ];
  for (const t of tools) {
    try {
      execSync(t.cmd, { encoding: 'utf-8', stdio: 'ignore', timeout: 3000, shell: '/bin/bash' } as never);
      const { base64, mediaType } = readImageAsBase64(imgPath);
      return { type: 'image', path: imgPath, base64, mediaType };
    } catch { /* next */ }
  }
  // Fall through to text
  const textTools = ['wl-paste', 'xclip -selection clipboard -o'];
  for (const cmd of textTools) {
    try {
      const text = execSync(cmd, { encoding: 'utf-8', timeout: 3000, shell: '/bin/bash' } as never);
      if (text) return { type: 'text', value: text };
    } catch { /* next */ }
  }
  return { type: 'empty' };
}

export function readClipboard(): ClipboardResult {
  const p = platform();
  if (p === 'win32') return windowsClipboard();
  if (p === 'darwin') return macosClipboard();
  return linuxClipboard();
}
