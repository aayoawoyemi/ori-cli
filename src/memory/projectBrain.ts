import { readFileSync, writeFileSync, readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, basename } from 'node:path';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ProjectMemory {
  title: string;
  content: string;
  type: string;
  created: string;
  score?: number;
}

// ── Project Brain ───────────────────────────────────────────────────────────

export class ProjectBrain {
  private memoryDir: string;
  private memories: ProjectMemory[] = [];
  private loaded = false;

  constructor(projectDir: string) {
    this.memoryDir = join(projectDir, '.aries', 'memory');
  }

  get path(): string { return this.memoryDir; }

  /** Ensure the .aries/memory directory exists. */
  init(): void {
    mkdirSync(this.memoryDir, { recursive: true });
  }

  /** Load all memories from disk. */
  load(): void {
    if (this.loaded) return;
    this.memories = [];

    if (!existsSync(this.memoryDir)) {
      this.loaded = true;
      return;
    }

    const files = readdirSync(this.memoryDir).filter(f => f.endsWith('.md'));
    for (const file of files) {
      try {
        const content = readFileSync(join(this.memoryDir, file), 'utf-8');
        const parsed = parseMemoryFile(content);
        if (parsed) this.memories.push(parsed);
      } catch {
        // Skip unreadable files
      }
    }

    this.loaded = true;
  }

  /** Get total number of memories. */
  get count(): number {
    this.load();
    return this.memories.length;
  }

  /** Search memories by keyword relevance. Simple but effective for project-local notes. */
  search(query: string, limit = 5): ProjectMemory[] {
    this.load();
    if (this.memories.length === 0) return [];

    const queryTerms = tokenize(query);
    if (queryTerms.length === 0) return this.memories.slice(0, limit);

    // Score each memory by term overlap (title weighted 3x, content 1x)
    const scored = this.memories.map(mem => {
      const titleTerms = tokenize(mem.title);
      const contentTerms = tokenize(mem.content);

      let score = 0;
      for (const qt of queryTerms) {
        for (const tt of titleTerms) {
          if (tt.includes(qt) || qt.includes(tt)) score += 3;
        }
        for (const ct of contentTerms) {
          if (ct.includes(qt) || qt.includes(ct)) score += 1;
        }
      }

      return { ...mem, score };
    });

    return scored
      .filter(s => s.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** Save a new memory to disk. */
  save(title: string, content: string, type = 'learning'): void {
    this.init();

    const slug = slugify(title);
    const created = new Date().toISOString().split('T')[0];

    const fileContent = `---
title: "${title.replace(/"/g, '\\"')}"
type: ${type}
created: ${created}
---

${content}
`;

    const filePath = join(this.memoryDir, `${slug}.md`);
    writeFileSync(filePath, fileContent, 'utf-8');

    // Add to in-memory cache
    this.memories.push({ title, content, type, created });
  }

  /** Get all memories (for display). */
  all(): ProjectMemory[] {
    this.load();
    return [...this.memories];
  }
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2);
}

function slugify(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .slice(0, 80);
}

function parseMemoryFile(content: string): ProjectMemory | null {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
  if (!fmMatch) return null;

  const frontmatter = fmMatch[1];
  const body = fmMatch[2].trim();

  const titleMatch = frontmatter.match(/title:\s*"?([^"\n]+)"?/);
  const typeMatch = frontmatter.match(/type:\s*(\w+)/);
  const createdMatch = frontmatter.match(/created:\s*([\d-]+)/);

  if (!titleMatch) return null;

  return {
    title: titleMatch[1].trim(),
    content: body,
    type: typeMatch?.[1] ?? 'learning',
    created: createdMatch?.[1] ?? 'unknown',
  };
}
