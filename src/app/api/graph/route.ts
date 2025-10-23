import { NextResponse } from 'next/server';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { getPineconeStore } from '@/lib/vectorstore';

type VectorCacheEntry = {
  pageId: string;
  pageTitle: string;
  spaceKey?: string;
  etag?: string;
  updatedAt?: string;
  embedVersion: string;
  chunkCount: number;
  chunkIds: string[];
  lastEmbeddedAt?: string;
};

type VectorCacheFile = {
  version: number;
  pages: Record<string, VectorCacheEntry>;
};

type GraphNode = {
  id: string; // pageId
  label: string; // pageTitle
  size: number; // derived from degree or chunkCount
  chunkCount: number;
  spaceKey?: string;
};

type GraphEdge = {
  source: string; // pageId
  target: string; // pageId
  weight: number; // aggregated similarity
};

function parseNumber(value: string | null, fallback: number): number {
  if (!value) return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function parseFloatInRange(value: string | null, fallback: number, min = 0, max = 1): number {
  if (!value) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

async function readVectorCache(): Promise<VectorCacheFile> {
  const cachePath = path.join(process.cwd(), 'data', 'vector-cache.json');
  try {
    const raw = await fs.readFile(cachePath, 'utf8');
    return JSON.parse(raw) as VectorCacheFile;
  } catch (error) {
    return { version: 1, pages: {} };
  }
}

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const seedPageId = searchParams.get('seedPageId');
    const maxSeeds = parseNumber(searchParams.get('maxSeeds'), 5); // number of seed chunks per page
    const topK = parseNumber(searchParams.get('topK'), 5); // neighbors per seed
    const threshold = parseFloatInRange(searchParams.get('threshold'), 0.25); // similarity threshold [0,1]
    const maxNodes = parseNumber(searchParams.get('maxNodes'), 50); // cap node count

    const cache = await readVectorCache();
    const pages = cache.pages ?? {};

    if (!seedPageId) {
      // Fallback: build a lightweight global graph by sampling the first N pages and connecting via title similarity
      // This path keeps behavior defined even without a seed
      const pageEntries = Object.values(pages).slice(0, Math.min(maxNodes, 25));
      const nodes: GraphNode[] = pageEntries.map((p) => ({
        id: p.pageId,
        label: p.pageTitle,
        size: Math.max(1, Math.min(10, p.chunkCount)),
        chunkCount: p.chunkCount,
        spaceKey: p.spaceKey,
      }));

      // No edges without embeddings for titles here; return nodes only
      return NextResponse.json({ nodes, edges: [] as GraphEdge[] });
    }

    const seed = pages[seedPageId];
    if (!seed) {
      return NextResponse.json({ error: 'seedPageId not found in vector cache' }, { status: 404 });
    }

    const store = await getPineconeStore();

    // Heuristic: pick first maxSeeds chunkIds as seeds (these are stable and sufficient for a local neighborhood)
    const seedChunkIds = seed.chunkIds.slice(0, maxSeeds);

    // Build edges between pages by aggregating similar chunk matches
    const pageEdges = new Map<string, number>();
    const nodeMap = new Map<string, GraphNode>();

    // Ensure seed page node exists
    nodeMap.set(seed.pageId, {
      id: seed.pageId,
      label: seed.pageTitle,
      size: Math.max(1, Math.min(10, seed.chunkCount)),
      chunkCount: seed.chunkCount,
      spaceKey: seed.spaceKey,
    });

    // We do not have raw chunk content in cache, but Pinecone metadata stored content during upsert.
    // Strategy: search by a synthetic query derived from seed page title and heading path when possible.
    // Better: issue searches using representative seed chunks by querying with the page title (approximation).
    // For a stronger signal, we will query using the page title plus space key.
    const syntheticQueries: string[] = [
      seed.pageTitle,
      seed.spaceKey ? `${seed.pageTitle} ${seed.spaceKey}` : seed.pageTitle,
    ];

    // Expand neighbors using several queries to increase recall
    for (const q of syntheticQueries) {
      const results = await store.search(q, topK);
      for (const r of results) {
        const neighborPageId = r.chunk.pageId;
        if (neighborPageId === seed.pageId) continue;
        const score = r.score ?? 0;
        if (score < threshold) continue;

        const key = seed.pageId < neighborPageId ? `${seed.pageId}|${neighborPageId}` : `${neighborPageId}|${seed.pageId}`;
        pageEdges.set(key, (pageEdges.get(key) ?? 0) + score);

        // ensure node exists
        const neighborCache = pages[neighborPageId];
        if (neighborCache && !nodeMap.has(neighborPageId)) {
          nodeMap.set(neighborPageId, {
            id: neighborCache.pageId,
            label: neighborCache.pageTitle,
            size: Math.max(1, Math.min(10, neighborCache.chunkCount)),
            chunkCount: neighborCache.chunkCount,
            spaceKey: neighborCache.spaceKey,
          });
        }
      }
    }

    // Optionally, for each discovered neighbor, connect neighbor-neighbor lightly to form a small ego-network
    const neighborIds = Array.from(nodeMap.keys()).filter((id) => id !== seed.pageId).slice(0, 10);
    for (const neighborId of neighborIds) {
      const neighborCache = pages[neighborId];
      if (!neighborCache) continue;
      const q = neighborCache.pageTitle;
      const results = await store.search(q, Math.max(3, Math.floor(topK / 2)));
      for (const r of results) {
        const otherId = r.chunk.pageId;
        if (otherId === neighborId || !nodeMap.has(otherId)) continue;
        const score = r.score ?? 0;
        if (score < threshold) continue;
        const key = neighborId < otherId ? `${neighborId}|${otherId}` : `${otherId}|${neighborId}`;
        pageEdges.set(key, (pageEdges.get(key) ?? 0) + score * 0.5);
      }
    }

    // Limit nodes
    const limitedNodes = Array.from(nodeMap.values()).slice(0, maxNodes);
    const allowed = new Set(limitedNodes.map((n) => n.id));

    const edges: GraphEdge[] = Array.from(pageEdges.entries())
      .map(([key, weight]) => {
        const [a, b] = key.split('|');
        return { source: a, target: b, weight } as GraphEdge;
      })
      .filter((e) => allowed.has(e.source) && allowed.has(e.target))
      .sort((a, b) => b.weight - a.weight)
      .slice(0, Math.max(20, maxNodes * 2));

    // Adjust node size by degree
    const degree = new Map<string, number>();
    for (const e of edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const nodes: GraphNode[] = limitedNodes.map((n) => ({
      ...n,
      size: Math.min(18, Math.max(6, (degree.get(n.id) ?? 1) + Math.log10(n.chunkCount + 1) * 2)),
    }));

    return NextResponse.json({ nodes, edges });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return NextResponse.json({ error: message }, { status: 500 });
  }
}


