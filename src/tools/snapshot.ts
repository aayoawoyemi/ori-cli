import { readFileSync, writeFileSync, existsSync } from 'node:fs';

interface FileSnapshot {
  path: string;
  content: string;
  timestamp: number;
  tool: 'Edit' | 'Write';
}

const MAX_SNAPSHOTS = 20;
const snapshots: FileSnapshot[] = [];

/** Capture file content before an edit/write. */
export function captureSnapshot(path: string, tool: 'Edit' | 'Write'): void {
  if (!existsSync(path)) return;
  try {
    const content = readFileSync(path, 'utf-8');
    snapshots.push({ path, content, timestamp: Date.now(), tool });
    if (snapshots.length > MAX_SNAPSHOTS) snapshots.shift();
  } catch { /* file might be binary or inaccessible */ }
}

/** Undo the last snapshot — restore file and return info. */
export function undoLast(): FileSnapshot | null {
  const snap = snapshots.pop();
  if (!snap) return null;
  try {
    writeFileSync(snap.path, snap.content, 'utf-8');
  } catch { /* restore failed */ }
  return snap;
}

/** Undo the last N snapshots. */
export function undoN(n: number): FileSnapshot[] {
  const restored: FileSnapshot[] = [];
  for (let i = 0; i < n; i++) {
    const snap = undoLast();
    if (!snap) break;
    restored.push(snap);
  }
  return restored;
}

/** How many snapshots are available. */
export function snapshotCount(): number {
  return snapshots.length;
}
