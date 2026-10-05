import { readFile } from 'node:fs/promises';
import path from 'node:path';

export type NodeCatalog = {
  triggers: Array<{ type: string; description?: string; config?: Record<string, unknown> }>;
  nodes: Array<{ type: string; description?: string; side_effect?: boolean; requires_approval?: boolean; params?: Record<string, unknown>; branches?: string[]; output?: Record<string, unknown>; notes?: string }>;
};

let cachedCatalog: NodeCatalog | null = null;

function catalogPath(fileName: string): string {
  return path.resolve(process.cwd(), 'data', fileName);
}

export async function loadNodeCatalog(): Promise<NodeCatalog> {
  if (cachedCatalog) {
    return cachedCatalog;
  }

  const raw = await readFile(catalogPath('node_catalog.json'), 'utf8');
  cachedCatalog = JSON.parse(raw) as NodeCatalog;
  return cachedCatalog;
}

export function getNodeCatalog(): NodeCatalog {
  if (!cachedCatalog) {
    throw new Error('Node catalog has not been loaded yet');
  }

  return cachedCatalog;
}
