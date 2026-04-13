# Research Engine V2 — Artifact Persistence + Builds-On

## Context
The research engine (src/research/, ~800 LOC, 10 files) has a 7-phase pipeline:
discover → ingest → extract → chase → reflect → synthesize → persist.
6 API sources: Arxiv, Semantic Scholar, OpenAlex, GitHub, Exa, Reddit.
Citation graph traversal, IterDRAG reflection, tier-ranked anti-slop scoring.

Problem: all structured data (graph, sources, findings, frontier) is discarded after
generating a chat message. Vault gets auto-saved noise notes. Nothing persists.

## What We're Building

### Change 1: Artifact Folder Output
New file: `src/research/artifacts.ts`

Every /research run saves a session folder:
```
brain/research/{slug}/
  meta.json        — slug, query, depth, date, counts
  report.md        — human-readable synthesis (Ori indexes this naturally)
  sources.json     — all DiscoveredSource[] with scores
  findings.json    — all Finding[] with provenance
  graph.json       — CitationGraph (nodes + edges)
  frontier.json    — cited-but-not-ingested source IDs (resume targets)
```

Slug derived from query: "real estate CRM agents" → `real-estate-crm-agents`.
Date appended on collision.

Functions: `saveSession()`, `loadSession()`, `listSessions()`, `resolveSlug()`

Touched:
- NEW: src/research/artifacts.ts
- EDIT: src/research/types.ts — add ResearchSession, ResearchResult, ResearchOptions
- EDIT: src/research/index.ts — call saveSession() after synthesize

### Change 2: Remove Auto-Vault-Save
Edit: `src/research/persist.ts`

Strip all vault.add() calls from persistFindings(). It only generates the markdown
report string for display. No more auto-saving convergent findings, contradictions,
or synthesis summaries to the vault. The report.md in the artifact folder is the
durable output — Ori indexes it naturally because it's a markdown file in brain/.

Touched:
- EDIT: src/research/persist.ts — remove vault auto-save, keep report generation
- EDIT: src/research/index.ts — vault no longer required param

### Change 3: --builds-on Flag
Extend: `src/research/artifacts.ts` + `src/research/discover.ts`

`loadSession(slug)` reads a previous session's frontier.json and sources.json.
Frontier sources become seeds for the Discover phase — merged into API results
before dedup and ranking, with a bonus for being previously identified as high-value.

User can pass flag explicitly: `/research "query" --builds-on real-estate-crm`
Or Aries matches topics automatically and asks before connecting sessions.

Touched:
- EDIT: src/research/artifacts.ts — add loadSeeds(slug)
- EDIT: src/research/discover.ts — accept optional seeds param, merge with API results
- EDIT: src/research/index.ts — accept buildsOn option, load seeds if provided
- EDIT: src/ui/app.tsx — parse --builds-on from command args

### Change 4: Standalone-Ready Signature
Edit: `src/research/index.ts`

New signature:
```typescript
export async function runResearch(
  query: string,
  depth: ResearchDepth,
  router: ModelRouter,
  options: {
    fetchFn: (url: string) => Promise<string>;
    outputDir: string;
    buildsOn?: string;
    vault?: OriVault | null;
  },
): Promise<ResearchResult>
```

Returns ResearchResult (not just string):
```typescript
interface ResearchResult {
  report: string;
  session: ResearchSession;
  slug: string;
}
```

When vault connected: outputDir defaults to brain/research/.
When vault absent: outputDir defaults to ./research/.
No vault dependency. Vault enhances (report.md gets indexed) but isn't required.

Touched:
- EDIT: src/research/index.ts — new signature, return ResearchResult
- EDIT: src/research/types.ts — add interfaces
- EDIT: src/ui/app.tsx — adapt to new return type

## NOT Building Yet
- Watch mode / scheduled research
- Multi-agent orchestration (reviewer, verifier)
- Provenance sidecars
- MCP server interface
- npm standalone package
- Website / installer

## Build Order
1. types.ts — ResearchSession, ResearchResult, ResearchOptions
2. artifacts.ts — new file
3. persist.ts — strip vault auto-save
4. discover.ts — optional seeds param
5. index.ts — new signature, wire everything
6. app.tsx — parse flags, adapt return type
7. Compile + test

## Files Touched
- NEW: src/research/artifacts.ts (~100 LOC)
- EDIT: src/research/types.ts (~30 LOC)
- EDIT: src/research/persist.ts (~-20 LOC, removing vault saves)
- EDIT: src/research/discover.ts (~15 LOC)
- EDIT: src/research/index.ts (~40 LOC)
- EDIT: src/ui/app.tsx (~20 LOC)
