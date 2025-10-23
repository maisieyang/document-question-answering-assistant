'use client';

import { useCallback, useMemo, useState } from 'react';
import { ChatWindow } from '@/components/ChatWindow';
import { MessageBubble } from '@/components/MessageBubble';
import { QAReferenceList } from '@/components/QAReferenceList';
import type { RenderMessageParams } from '@/components/ChatWindow/types';
import { PROVIDER_OPTIONS, type ProviderName, normalizeProviderName } from '@/lib/providers/types';

const QA_EMPTY_STATE = {
  icon: '📚',
  headline: 'Bank Knowledge Assistant',
  description: 'Your intelligent assistant for internal banking knowledge based on Confluence.',
  suggestions: [
    '💡 “How do I request new access in the Core Banking System?”',
    '💡 “Where are the IT onboarding guides for new employees?”',
    '💡 “How can I check the change management policy for system deployments?”',
  ],
};

export default function QAPage() {
  const [provider, setProvider] = useState<ProviderName>(
    normalizeProviderName(process.env.NEXT_PUBLIC_PROVIDER as ProviderName | undefined)
  );

  const requestMetadata = useMemo(() => ({ provider }), [provider]);

  const renderMessage = useCallback(({ message, isStreaming, onFeedback }: RenderMessageParams) => {
    return (
      <div className="space-y-3">
        <MessageBubble
          message={message}
          onFeedback={onFeedback}
          isStreaming={isStreaming && message.role === 'assistant'}
          showRelatedDocuments={message.role === 'assistant' && !isStreaming}
        />
        {message.role === 'assistant' && message.references?.length ? (
          <QAReferenceList references={message.references} />
        ) : null}
      </div>
    );
  }, []);

  const toolbarActions = (
    <div className="flex items-center space-x-2">
      <label htmlFor="qa-provider" className="text-sm text-text-tertiary">
        模型
      </label>
      <select
        id="qa-provider"
        value={provider}
        onChange={(event) => setProvider(event.target.value as ProviderName)}
        className="rounded-md border border-border-subtle bg-bg-secondary px-2 py-1 text-sm text-text-primary focus:border-accent focus:outline-none"
      >
        {PROVIDER_OPTIONS.map((option) => (
          <option key={option} value={option}>
            {option === 'openai' ? 'OpenAI' : 'Qwen (通义千问)'}
          </option>
        ))}
      </select>
    </div>
  );

  return (
    <div className="h-screen bg-bg-primary transition-colors duration-200">
      <ChatWindow
        apiUrl="/api/qa"
        placeholder="Ask anything"
        className="h-full"
        title="Bank Knowledge Assistant"
        emptyState={QA_EMPTY_STATE}
        renderMessage={renderMessage}
        requestMetadata={requestMetadata}
        toolbarActions={toolbarActions}
      />
    </div>
  );
}
