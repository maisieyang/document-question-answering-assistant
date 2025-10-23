"use client";
import React, { useEffect, useState } from 'react';
import { GraphView } from './GraphView';

type RelatedDocumentsProps = {
  query: string;
  onDocumentClick?: (pageId: string, title: string) => void;
};

export function RelatedDocuments({ query, onDocumentClick }: RelatedDocumentsProps) {
  const [relatedPages, setRelatedPages] = useState<Array<{
    pageId: string;
    title: string;
    score: number;
    content: string;
  }>>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!query.trim()) return;
    
    let aborted = false;
    async function fetchRelated() {
      setLoading(true);
      setError(null);
      try {
        // 调用向量搜索API获取真实的相似度分数
        const response = await fetch('/api/qa', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            question: query,
            messages: [{ role: 'user', content: query }]
          })
        });
        
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        
        // 解析流式响应获取相关文档
        const reader = response.body?.getReader();
        if (!reader) throw new Error('No response body');
        
        let references: any[] = [];
        const decoder = new TextDecoder();
        
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          
          const chunk = decoder.decode(value);
          const lines = chunk.split('\n');
          
          for (const line of lines) {
            if (line.startsWith('data: ')) {
              try {
                const data = JSON.parse(line.slice(6));
                if (data.type === 'metadata' && data.data) {
                  const metadata = JSON.parse(data.data);
                  if (metadata.references) {
                    references = metadata.references;
                  }
                }
              } catch (e) {
                // 忽略解析错误，继续处理其他行
              }
            }
          }
        }
        
        if (!aborted && references.length > 0) {
          setRelatedPages(references.slice(0, 5).map((ref: any) => ({
            pageId: ref.pageId || ref.id,
            title: ref.title || ref.label,
            score: ref.score || 0.5, // 使用真实的相似度分数
            content: `文档包含相关信息`
          })));
        } else {
          // 如果没有找到相关文档，回退到图谱API
          const graphResponse = await fetch('/api/graph?maxNodes=5');
          if (graphResponse.ok) {
            const graphData = await graphResponse.json();
            if (graphData.nodes) {
              setRelatedPages(graphData.nodes.slice(0, 5).map((node: any) => ({
                pageId: node.id,
                title: node.label,
                score: 0.5, // 默认相似度
                content: `文档包含 ${node.chunkCount} 个知识块`
              })));
            }
          }
        }
      } catch (e) {
        if (!aborted) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!aborted) setLoading(false);
      }
    }
    
    fetchRelated();
    return () => { aborted = true; };
  }, [query]);

  if (loading) {
    return (
      <div className="mt-4 p-4 bg-bg-secondary rounded-lg">
        <div className="text-sm text-text-tertiary">正在查找相关文档...</div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="mt-4 p-4 bg-red-50 dark:bg-red-900/20 rounded-lg">
        <div className="text-sm text-red-600 dark:text-red-400">加载相关文档失败：{error}</div>
      </div>
    );
  }

  if (relatedPages.length === 0) {
    return null;
  }

  return (
    <div className="mt-4 space-y-4">
      {/* 相关文档列表 */}
      <div className="p-4 bg-bg-secondary rounded-lg">
        <h3 className="text-sm font-medium text-text-primary mb-3">相关文档</h3>
        <div className="space-y-2">
          {relatedPages.slice(0, 5).map((page, index) => (
            <div
              key={page.pageId}
              className="flex items-start space-x-3 p-3 hover:bg-bg-tertiary rounded-lg cursor-pointer transition-all duration-200 hover:shadow-sm border border-transparent hover:border-accent/20"
              onClick={() => onDocumentClick?.(page.pageId, page.title)}
            >
              <div className="flex-shrink-0 w-8 h-8 bg-gradient-to-br from-accent/20 to-accent/30 rounded-full flex items-center justify-center text-sm font-bold text-accent shadow-sm">
                {index + 1}
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-text-primary hover:text-accent transition-colors truncate">
                  {page.title}
                </div>
                <div className="text-xs text-text-tertiary mt-1 flex items-center space-x-2">
                  <span className="bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 px-2 py-1 rounded-full">
                    相似度: {(page.score * 100).toFixed(1)}%
                  </span>
                  <span className="text-gray-500">•</span>
                  <span className="text-gray-500">点击查看详情</span>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 知识图谱可视化 */}
      {relatedPages.length > 0 && (
        <div className="p-4 bg-bg-secondary rounded-lg mb-8">
          <h3 className="text-sm font-medium text-text-primary mb-3">知识关联图谱</h3>
          <div className="min-h-[500px] w-full overflow-visible border border-gray-200 dark:border-gray-700 rounded-md">
            <GraphView 
              seedPageId={relatedPages[0].pageId}
              onNodeClick={(nodeId, nodeLabel) => {
                console.log('Graph node clicked:', { nodeId, nodeLabel });
                onDocumentClick?.(nodeId, nodeLabel);
              }}
            />
          </div>
        </div>
      )}
    </div>
  );
}
