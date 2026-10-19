// Chat panel for the RA Recovery Orchestrator (ra-recovery-orchestrator-v2).
// Renders as a card with a scrollable message list and input bar.

import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
  Button,
  Textarea,
} from '@databricks/appkit-ui/react';
import { useRef, useState } from 'react';
import { Send, Bot, User, Loader2 } from 'lucide-react';
import { chatApi } from '../lib/chat';
import type { ChatMessage } from '../lib/types';

const SUGGESTED_QUESTIONS = [
  'What are the top 3 recovery opportunities by dollar value?',
  'Which check types have the highest recovery confidence?',
  'Summarize the recovery strategy for our highest-risk customer.',
];

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  async function send(text?: string) {
    const content = (text ?? input).trim();
    if (!content || loading) return;

    const userMsg: ChatMessage = { role: 'user', content };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput('');
    setError(null);
    setLoading(true);

    // Scroll to bottom after user message renders.
    requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }));

    try {
      const { content: reply } = await chatApi.send(next);
      setMessages((prev) => [...prev, { role: 'assistant', content: reply }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reach the recovery orchestrator.');
    } finally {
      setLoading(false);
      requestAnimationFrame(() => scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' }));
    }
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <Card className="flex flex-col shadow-sm">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Bot className="h-4 w-4 text-brand" /> Recovery assistant
        </CardTitle>
        <CardDescription>
          Ask the AI recovery orchestrator about leakage patterns, recovery strategy, or exception analysis.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        {/* Message list */}
        <div
          ref={scrollRef}
          className="flex max-h-80 min-h-[10rem] flex-col gap-3 overflow-y-auto rounded-md border border-border bg-muted/30 p-3"
          role="log"
          aria-label="Chat messages"
        >
          {messages.length === 0 && !loading && (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6">
              <Bot className="h-8 w-8 text-muted-foreground/40" />
              <div className="text-center text-xs text-muted-foreground">
                Ask the recovery orchestrator a question, or try one below.
              </div>
              <div className="flex flex-wrap justify-center gap-2">
                {SUGGESTED_QUESTIONS.map((q) => (
                  <button
                    key={q}
                    type="button"
                    onClick={() => send(q)}
                    className="rounded-full border border-border bg-background px-3 py-1 text-xs text-foreground transition-colors hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {q}
                  </button>
                ))}
              </div>
            </div>
          )}
          {messages.map((m, i) => (
            <div key={i} className={`flex gap-2 ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              {m.role === 'assistant' && (
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-brand/10">
                  <Bot className="h-3.5 w-3.5 text-brand" />
                </div>
              )}
              <div
                className={`max-w-[80%] rounded-lg px-3 py-2 text-sm ${
                  m.role === 'user'
                    ? 'bg-brand text-brand-foreground'
                    : 'bg-background text-foreground border border-border'
                }`}
              >
                <div className="whitespace-pre-wrap">{m.content}</div>
              </div>
              {m.role === 'user' && (
                <div className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-muted">
                  <User className="h-3.5 w-3.5 text-muted-foreground" />
                </div>
              )}
            </div>
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="h-3.5 w-3.5 animate-spin" /> Thinking…
            </div>
          )}
          {error && (
            <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
              {error}
            </div>
          )}
        </div>

        {/* Input bar */}
        <div className="flex gap-2">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask about recovery strategy, exception patterns, or leakage analysis…"
            className="min-h-[2.5rem] resize-none"
            rows={1}
            disabled={loading}
            aria-label="Chat message input"
          />
          <Button
            size="icon"
            onClick={() => send()}
            disabled={!input.trim() || loading}
            aria-label="Send message"
          >
            <Send className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
