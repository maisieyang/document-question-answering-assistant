import { PineconeStore, SearchResult } from '../vectorstore';
import {
  chatCompletion,
  chatCompletionStream,
  type ChatCompletionChunk,
  resolveProvider,
  type ProviderName,
} from '../providers/modelProvider';
import {
  buildProviderMessages,
  QA_USER_PROMPT_INSTRUCTIONS,
  tracePrompt,
  type PromptTraceMetadata,
} from '../prompts/unifiedPrompt';

const DEFAULT_TEMPERATURE = 0.4;
const DEFAULT_SIMILARITY_THRESHOLD = Number(process.env.SIMILARITY_THRESHOLD ?? '0.75');
const TRACE_RETRIEVAL = /^(1|true|yes)$/i.test(process.env.QA_TRACE_RETRIEVAL ?? '');
const FALLBACK_SIMILARITY_THRESHOLD = Number(process.env.QA_FALLBACK_THRESHOLD ?? '0.6');

interface AnswerReferences {
  index: number;
  title: string;
  url?: string;
  score?: number;
  pageId?: string;
}

export interface AnswerResponse {
  answer: string;
  references: AnswerReferences[];
  retrievalTrace?: RetrievalTrace;
}

interface RetrievalTraceEntry {
  index: number;
  id: string;
  score: number;
  title: string;
  heading?: string;
  headingPath?: string;
  spaceKey?: string;
  included: boolean;
}

export interface RetrievalTrace {
  threshold: number;
  fallbackApplied: boolean;
  fallbackThreshold?: number;
  results: RetrievalTraceEntry[];
}

function buildContext(results: SearchResult[]): { context: string; references: AnswerReferences[] } {
  const references: AnswerReferences[] = [];
  const seen = new Map<string, number>();
  const sections = results.map((result) => {
    const pageId = result.chunk.pageId ?? result.chunk.id;
    let referenceIndex = seen.get(pageId);

    if (!referenceIndex) {
      referenceIndex = references.length + 1;
      seen.set(pageId, referenceIndex);
      references.push({
        index: referenceIndex,
        title: result.chunk.title,
        url: result.chunk.sourceUrl,
        score: result.score,
        pageId: pageId,
      });
    }

    return [
      `Reference [${referenceIndex}] — ${result.chunk.title}`,
      result.chunk.sourceUrl ? `Source: ${result.chunk.sourceUrl}` : undefined,
      result.chunk.content,
    ]
      .filter(Boolean)
      .join('\n');
  });

  return {
    context: sections.join('\n\n---\n\n'),
    references,
  };
}

const FALLBACK_INSTRUCTIONS = `${QA_USER_PROMPT_INSTRUCTIONS}\n- Retrieval context was empty; inform the user before answering from general knowledge.`;

export class QAEngine {
  constructor(
    private readonly store: PineconeStore,
    private readonly topK = 5,
    private readonly defaultProvider: ProviderName = resolveProvider(),
    private readonly similarityThreshold: number = Number.isFinite(DEFAULT_SIMILARITY_THRESHOLD)
      ? Math.min(Math.max(DEFAULT_SIMILARITY_THRESHOLD, 0), 1)
      : 0.2
  ) {}

  async answerQuestion(
    question: string,
    chatHistory?: string,
    providerOverride?: ProviderName | string,
    trace?: PromptTraceMetadata
  ): Promise<AnswerResponse> {
    const { messages, references, retrievalTrace } = await this.prepare(question, chatHistory, trace);
    const provider = resolveProvider(providerOverride ?? this.defaultProvider);

    const { text } = await chatCompletion({
      messages,
      temperature: DEFAULT_TEMPERATURE,
      provider,
    });

    const answer = text || 'I do not have enough information to answer that.';

    return { answer, references, retrievalTrace };
  }

  async createStreamingCompletion(
    question: string,
    chatHistory?: string,
    providerOverride?: ProviderName | string,
    trace?: PromptTraceMetadata
  ) {
    const { messages, references, retrievalTrace } = await this.prepare(question, chatHistory, trace);
    const provider = resolveProvider(providerOverride ?? this.defaultProvider);

    const { stream } = await chatCompletionStream({
      messages,
      temperature: DEFAULT_TEMPERATURE,
      provider,
    });

    return {
      references,
      stream,
      retrievalTrace,
    } as {
      references: AnswerReferences[];
      stream: AsyncIterable<ChatCompletionChunk>;
      retrievalTrace: RetrievalTrace;
    };
  }

  private async prepare(question: string, chatHistory?: string, trace?: PromptTraceMetadata) {
    if (!question.trim()) {
      throw new Error('Question must not be empty');
    }

    const rawResults = await this.store.search(question, this.topK);
    let relevantResults = rawResults.filter((result) => result.score >= this.similarityThreshold);

    const fallbackThresholdValid = Number.isFinite(FALLBACK_SIMILARITY_THRESHOLD)
      && FALLBACK_SIMILARITY_THRESHOLD > 0
      && FALLBACK_SIMILARITY_THRESHOLD < 1;

    let fallbackApplied = false;
    if (relevantResults.length === 0 && rawResults.length > 0 && fallbackThresholdValid) {
      const fallbackResults = rawResults.filter((result) => result.score >= FALLBACK_SIMILARITY_THRESHOLD);
      if (fallbackResults.length > 0) {
        relevantResults = fallbackResults;
        fallbackApplied = true;
      } else {
        relevantResults = [rawResults[0]];
        fallbackApplied = true;
      }
    }

    const includedIds = new Set(relevantResults.map((result) => result.chunk.id));
    const retrievalTrace: RetrievalTrace = {
      threshold: this.similarityThreshold,
      fallbackApplied,
      fallbackThreshold: fallbackApplied && fallbackThresholdValid ? FALLBACK_SIMILARITY_THRESHOLD : undefined,
      results: rawResults.map((result, idx) => ({
        index: idx + 1,
        id: result.chunk.id,
        score: Number(result.score.toFixed(4)),
        title: result.chunk.title,
        heading: result.chunk.heading,
        headingPath: result.chunk.headingPath,
        spaceKey: result.chunk.spaceKey,
        included: includedIds.has(result.chunk.id),
      })),
    };

    if (TRACE_RETRIEVAL) {
      console.debug(JSON.stringify({ type: 'qa_retrieval', trace: retrievalTrace }));
    }

    if (relevantResults.length === 0) {
      const { messages } = buildProviderMessages({
        question,
        chatHistory,
        instructions: FALLBACK_INSTRUCTIONS,
        contextSections: [
          {
            title: 'Retrieval Context',
            content: 'No relevant Confluence context was retrieved above the similarity threshold.',
          },
        ],
      });

      tracePrompt(
        {
          label: trace?.label ?? 'qa.prompt.fallback',
          requestId: trace?.requestId,
        },
        messages
      );

      return {
        messages,
        references: [],
        retrievalTrace,
      };
    }

    const { context, references } = buildContext(relevantResults);
    const instructions = fallbackApplied
      ? `${QA_USER_PROMPT_INSTRUCTIONS}\n- Retrieved context scored below the usual similarity threshold; treat it as suggestive, not definitive.`
      : QA_USER_PROMPT_INSTRUCTIONS;

    const { messages } = buildProviderMessages({
      question,
      chatHistory,
      instructions,
      contextSections: [
        { title: 'Retrieval Context', content: context },
      ],
    });

    tracePrompt(
      {
        label: trace?.label ?? (fallbackApplied ? 'qa.prompt.fallback-context' : 'qa.prompt'),
        requestId: trace?.requestId,
      },
      messages
    );

    return {
      messages,
      references,
      retrievalTrace,
    };
  }
}
