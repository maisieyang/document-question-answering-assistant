"use client";
import React, { useEffect, useMemo, useRef, useState } from 'react';

type GraphNode = {
  id: string;
  label: string;
  size: number;
  chunkCount: number;
  spaceKey?: string;
};

type GraphEdge = {
  source: string;
  target: string;
  weight: number;
};

type GraphResponse = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

// 计算节点间平均距离的辅助函数
function calculateAverageDistance(nodes: Array<{ x: number; y: number }>): number {
  let totalDistance = 0;
  let pairCount = 0;
  
  for (let i = 0; i < nodes.length; i++) {
    for (let j = i + 1; j < nodes.length; j++) {
      const dx = nodes[i].x - nodes[j].x;
      const dy = nodes[i].y - nodes[j].y;
      totalDistance += Math.sqrt(dx * dx + dy * dy);
      pairCount++;
    }
  }
  
  return pairCount > 0 ? totalDistance / pairCount : 0;
}

export function GraphView({ seedPageId, onNodeClick }: { seedPageId?: string; onNodeClick?: (nodeId: string, nodeLabel: string) => void }) {
  const [data, setData] = useState<GraphResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let aborted = false;
    async function fetchData() {
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams();
        if (seedPageId) params.set('seedPageId', seedPageId);
        params.set('topK', '6');
        params.set('maxNodes', '60');
        const res = await fetch(`/api/graph?${params.toString()}`);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = (await res.json()) as GraphResponse;
        if (!aborted) setData(json);
      } catch (e) {
        if (!aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!aborted) setLoading(false);
      }
    }
    fetchData();
    return () => {
      aborted = true;
    };
  }, [seedPageId]);

  const layout = useMemo(() => {
    if (!data) return null;
    
    const nodes = data.nodes;
    const edges = data.edges;
    const width = 800; // 保持宽度
    const height = 500; // 减少高度，去除多余留白
    
    // 使用集中式布局，确保整体居中，增加节点间距
    const centerX = width / 2;
    const centerY = height / 2;
    
    // 确定主节点：优先使用 seedPageId，如果没有则使用第一个节点（关联度最高）
    const mainNodeId = seedPageId && nodes.find(n => n.id === seedPageId) ? seedPageId : (nodes[0]?.id);
    
    const positioned = nodes.map((n, i) => {
      const isMainNode = n.id === mainNodeId;
      let x, y;
      
      if (isMainNode) {
        // 主节点（关联度最高）放在中心
        x = centerX;
        y = centerY;
      } else {
        // 其他节点围绕中心分布，减少半径以紧凑布局
        const angle = (i / Math.max(1, nodes.length - 1)) * Math.PI * 2;
        const radius = Math.min(140, 100 + (nodes.length * 8)); // 减少半径，更紧凑
        x = centerX + radius * Math.cos(angle);
        y = centerY + radius * Math.sin(angle);
        
        // 调整边界约束，减少留白
        x = Math.max(60, Math.min(width - 60, x));
        y = Math.max(60, Math.min(height - 60, y));
      }
      
      return { 
        ...n, 
        x, 
        y,
        isMainNode
      } as GraphNode & {
        x: number;
        y: number;
        isMainNode: boolean;
      };
    });
    
    return { nodes: positioned, edges, width, height };
  }, [data, seedPageId]);

  if (loading) {
    return <div className="text-sm text-gray-500">加载图谱中…</div>;
  }
  if (error) {
    return <div className="text-sm text-red-500">加载失败：{error}</div>;
  }
  if (!layout) {
    return <div className="text-sm text-gray-500">暂无数据</div>;
  }

  return (
    <div ref={containerRef} className="w-full min-h-[500px] border rounded-md bg-white dark:bg-gray-900 flex items-center justify-center">
      <svg width={layout.width} height={layout.height} className="block" viewBox={`0 0 ${layout.width} ${layout.height}`}>
        <defs>
          <filter id="shadow" x="-50%" y="-50%" width="200%" height="200%">
            <feDropShadow dx="2" dy="2" stdDeviation="3" floodColor="rgba(0,0,0,0.3)"/>
          </filter>
        </defs>
        
        {/* 边 - 先绘制，避免遮挡节点 */}
        {layout.edges.map((e, idx) => {
          const a = layout.nodes.find((n) => n.id === e.source);
          const b = layout.nodes.find((n) => n.id === e.target);
          if (!a || !b) return null;
          
          const opacity = Math.min(0.8, 0.3 + e.weight);
          const strokeWidth = Math.max(1, e.weight * 2);
          
          return (
            <line 
              key={idx} 
              x1={a.x} y1={a.y} x2={b.x} y2={b.y} 
              stroke={`rgba(99,102,241,${opacity})`} 
              strokeWidth={strokeWidth}
              strokeLinecap="round"
            />
          );
        })}
        
        {/* 节点 */}
        {layout.nodes.map((n) => {
          const radius = Math.max(15, Math.min(30, n.size));
          const isMainNode = n.isMainNode;
          
          return (
            <g 
              key={n.id} 
              className="cursor-pointer"
              onClick={() => onNodeClick?.(n.id, n.label)}
            >
              {/* 节点 */}
              <circle 
                cx={n.x} 
                cy={n.y} 
                r={radius} 
                fill={isMainNode ? "#8b5cf6" : "#3b82f6"}
                stroke={isMainNode ? "#7c3aed" : "#2563eb"}
                strokeWidth={isMainNode ? 3 : 2}
                filter="url(#shadow)"
                className="transition-colors duration-200 ease-in-out"
              />
              
              {/* 悬停时的放大效果 - 使用独立的透明圆形，避免抖动 */}
              <circle 
                cx={n.x} 
                cy={n.y} 
                r={radius + 8} 
                fill="transparent"
                className="hover:fill-blue-500/10 transition-all duration-200 ease-in-out"
              />
              
              {/* 节点标题 - 在节点下方，增加间距避免重叠 */}
              <text 
                x={n.x} 
                y={n.y + radius + 30} 
                textAnchor="middle"
                className="text-sm font-semibold fill-gray-800 dark:fill-gray-200 pointer-events-none"
                style={{ fontSize: '12px' }}
              >
                {n.label}
              </text>
              
              {/* 节点信息 - 在标题下方，增加间距 */}
              <text 
                x={n.x} 
                y={n.y + radius + 50} 
                textAnchor="middle"
                className="text-xs fill-gray-500 dark:fill-gray-400 pointer-events-none"
                style={{ fontSize: '10px' }}
              >
                {n.chunkCount}块
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}


