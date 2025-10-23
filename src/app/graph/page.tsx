'use client';

import { useState } from 'react';
import { GraphView } from '@/components';

export default function GraphPage() {
  const [seedPageId, setSeedPageId] = useState<string>('');

  return (
    <main className="mx-auto w-full max-w-5xl px-6 py-8">
      <h1 className="mb-2 text-2xl font-semibold">知识图谱可视化</h1>
      <p className="mb-6 text-sm text-text-tertiary">
        可选填 Confluence pageId 作为起点；留空则展示采样节点。
      </p>

      <div className="mb-4 flex items-center gap-2">
        <input
          value={seedPageId}
          onChange={(e) => setSeedPageId(e.target.value)}
          placeholder="输入 seedPageId（可留空）"
          className="w-72 rounded-md border border-border-subtle bg-bg-secondary px-3 py-2 text-sm text-text-primary focus:border-accent focus:outline-none"
        />
      </div>

      <GraphView 
        seedPageId={seedPageId || undefined}
        onNodeClick={(nodeId, nodeLabel) => {
          console.log('Node clicked:', { nodeId, nodeLabel });
          // 可以在这里实现跳转到文档详情
          alert(`点击了节点: ${nodeLabel} (ID: ${nodeId})`);
        }}
      />
    </main>
  );
}


