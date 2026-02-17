import axios from 'axios';

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';

const EXTRACT_PROMPT = `Below is text extracted from a webpage. Extract every email address that appears in this text. Do not invent or assume any email not explicitly present. For each email, classify type: generic (e.g. info@, contact@, sales@, booking@, reservations@, office@), personal, or unknown. Assign a confidence score 0.0-1.0. Reply with only valid JSON, no markdown or explanation: {"emails": [{"email": "...", "type": "generic|personal|unknown", "confidence": 0.95}]}`;

function stripMarkdownJson(raw) {
  let s = (raw || '').trim();
  const codeBlock = /^```(?:json)?\s*([\s\S]*?)```$/;
  const m = s.match(codeBlock);
  if (m) s = m[1].trim();
  return s;
}

/**
 * Extract emails from page text using OpenRouter LLM. Returns [] on any failure.
 * @param {string} pageText - Visible text from page (will be truncated)
 * @param {string} sourceUrl - URL where text was taken from
 * @param {object} options - { model, apiKey, aiTextMaxChars }
 * @returns {Promise<Array<{ email, email_type, confidence, source_url, extracted_by }>>}
 */
export async function extractEmailsWithLLM(pageText, sourceUrl, options = {}) {
  const apiKey = options.apiKey || process.env.OPENROUTER_API_KEY;
  if (!apiKey) return [];
  const model = options.model || 'meta-llama/llama-3.1-8b-instruct:free';
  const maxChars = options.aiTextMaxChars ?? 4000;
  const timeoutMs = options.timeoutMs ?? 30000;

  const text = String(pageText || '').slice(0, maxChars);
  if (!text.trim()) return [];

  const userContent = `${EXTRACT_PROMPT}\n\n---\n\n${text}`;

  try {
    const { data } = await axios.post(
      OPENROUTER_URL,
      {
        model,
        messages: [{ role: 'user', content: userContent }],
        temperature: 0,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'HTTP-Referer': sourceUrl || 'https://github.com/0xSafak/scrapper',
        },
        timeout: timeoutMs,
      }
    );

    const content = data?.choices?.[0]?.message?.content;
    if (!content) return [];

    const jsonStr = stripMarkdownJson(content);
    const parsed = JSON.parse(jsonStr);
    const emails = parsed?.emails;
    if (!Array.isArray(emails)) return [];

    const out = [];
    for (const e of emails) {
      const email = (e.email || '').toLowerCase().trim();
      if (!email || !email.includes('@')) continue;
      let type = (e.type || 'unknown').toLowerCase();
      if (!['generic', 'personal', 'unknown'].includes(type)) type = 'unknown';
      let confidence = Number(e.confidence);
      if (Number.isNaN(confidence) || confidence < 0) confidence = 0;
      if (confidence > 1) confidence = 1;
      out.push({
        email,
        email_type: type,
        confidence,
        source_url: sourceUrl,
        extracted_by: 'ai',
      });
    }
    return out;
  } catch (_) {
    return [];
  }
}

export default extractEmailsWithLLM;
