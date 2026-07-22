/**
 * Synthesize a KB answer from PDF passages (server-side only).
 * Set LLM_API_KEY (+ optional LLM_PROVIDER) in .env.local to enable.
 */

type Passage = {
  fileName: string;
  page: number;
  text: string;
};

export async function synthesizeAnswerFromPassages(
  question: string,
  passages: Passage[]
): Promise<string | null> {
  const apiKey = process.env.LLM_API_KEY?.trim();
  if (!apiKey || passages.length === 0) return null;

  const provider = (process.env.LLM_PROVIDER || 'claude').toLowerCase();
  const context = passages
    .map(
      (p, i) =>
        `SOURCE ${i}\nFile: ${p.fileName}\nPage: ${p.page}\nText:\n${p.text}`
    )
    .join('\n\n-------------------\n\n');

  const prompt = `You are a knowledge assistant for Nautilus Shipping. Answer the question using ONLY the document excerpts below. Do NOT use external knowledge.

Return STRICT JSON only:
{
  "answer": "3-6 complete sentences that directly answer the question with useful detail",
  "usedSources": [0]
}

Rules:
- Write a natural, conversational reply — as if explaining to a colleague (like ChatGPT).
- Prefer excerpts that contain the SAME topic phrase as the question (e.g. "superintendent inspections"), not merely related words like "inspection".
- If multiple sources agree, synthesize one clear answer. If they conflict, prefer the more specific topic match and briefly note any difference.
- Answer ONLY from the excerpts. Be specific (include frequencies, timeframes, requirements, and key steps when present).
- Prefer a fuller reply over a one-line summary; typically 100–180 words is fine when the excerpts support it.
- Include responsibilities, list items (a/b/c), referenced manuals, and procedure codes when present.
- Format with line breaks: put the section title on its own line, then a blank line, then the explanation paragraph, then each list item (a/b/c) on its own line. Do not collapse everything into one paragraph.
- When excerpts only point to another procedure, explain what this document says and name the referenced procedure — do not invent missing steps.
- Do NOT dump document headers or page labels; you may restate list-item substance in plain prose.
- Do NOT start with "According to" or cite source numbers in the answer text.
- Never stitch unrelated keyword hits into a fake answer.
- If the excerpts do not contain the answer, return:
{"answer": "I could not find this information in the available documents.", "usedSources": []}

--- DOCUMENT EXCERPTS ---
${context}
--- END EXCERPTS ---

Question: ${question}

Response:`;

  try {
    const raw =
      provider === 'openai'
        ? await callOpenAI(apiKey, prompt)
        : provider === 'gemini'
          ? await callGemini(apiKey, prompt)
          : await callClaude(apiKey, prompt);

    const payload = parseJsonPayload(raw);
    const answer = typeof payload?.answer === 'string' ? payload.answer.trim() : '';
    if (!answer || /could not find/i.test(answer)) return null;
    return answer;
  } catch {
    return null;
  }
}

async function callClaude(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'claude-sonnet-4-6',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || 'Claude API error');
  return json?.content?.[0]?.text ?? '';
}

async function callOpenAI(apiKey: string, prompt: string): Promise<string> {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: process.env.LLM_MODEL || 'gpt-4o',
      max_tokens: 512,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json?.error?.message || 'OpenAI API error');
  return json?.choices?.[0]?.message?.content ?? '';
}

async function callGemini(apiKey: string, prompt: string): Promise<string> {
  const model = process.env.LLM_MODEL || 'gemini-1.5-pro';
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }),
    }
  );
  const json = await res.json();
  if (!res.ok) throw new Error('Gemini API error');
  return json?.candidates?.[0]?.content?.parts?.[0]?.text ?? '';
}

function parseJsonPayload(raw: string): Record<string, unknown> | null {
  let trimmed = raw.trim();
  trimmed = trimmed.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try {
    const parsed = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}
