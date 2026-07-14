'use client';

import { useParams } from 'next/navigation';
import { ChatWorkspace } from '@/components/chat/ChatWorkspace';

/** Existing conversation — URL: /chat/[id] */
export default function ChatSessionPage() {
  const params = useParams();
  const id = typeof params?.id === 'string' ? params.id : Array.isArray(params?.id) ? params.id[0] : '';

  return <ChatWorkspace sessionId={id || null} />;
}
