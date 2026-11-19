/**
 * Translate between Google Gemini REST payloads and local Ollama /api/chat payloads.
 */

function extractText(parts = []) {
  return parts
    .map((p) => (typeof p?.text === 'string' ? p.text : ''))
    .filter(Boolean)
    .join('\n');
}

/**
 * Convert a Gemini generateContent request body into an Ollama /api/chat body.
 * @param {object} geminiBody
 * @param {string} localModel
 */
export function geminiToOllama(geminiBody = {}, localModel = 'gemma4:latest') {
  const messages = [];

  if (geminiBody.systemInstruction?.parts?.length) {
    const sysText = extractText(geminiBody.systemInstruction.parts);
    if (sysText) {
      messages.push({ role: 'system', content: sysText });
    }
  }

  for (const content of geminiBody.contents || []) {
    const parts = Array.isArray(content?.parts) ? content.parts : [];
    const role = content?.role === 'model' ? 'assistant' : 'user';
    const text = extractText(parts);
    const images = [];

    for (const part of parts) {
      if (part?.inlineData?.data && part?.inlineData?.mimeType) {
        images.push(part.inlineData.data);
      }
    }

    const msg = { role, content: text };
    if (images.length > 0) {
      msg.images = images;
    }
    messages.push(msg);
  }

  const options = {
    temperature: geminiBody.generationConfig?.temperature ?? 0.7,
  };
  if (typeof geminiBody.generationConfig?.maxOutputTokens === 'number') {
    options.num_predict = geminiBody.generationConfig.maxOutputTokens;
  }

  return {
    model: localModel,
    messages,
    stream: false,
    options,
  };
}

/**
 * Convert an Ollama /api/chat JSON response (or plain string) into Gemini generateContent format.
 * @param {object|string} ollamaDataOrText
 */
export function ollamaToGemini(ollamaDataOrText) {
  const isObj = ollamaDataOrText !== null && typeof ollamaDataOrText === 'object';
  const text = isObj
    ? (ollamaDataOrText.message?.content ?? ollamaDataOrText.response ?? '')
    : String(ollamaDataOrText ?? '');

  const out = {
    candidates: [
      {
        content: {
          parts: [{ text }],
          role: 'model',
        },
        finishReason: 'STOP',
      },
    ],
  };

  if (isObj && (typeof ollamaDataOrText.prompt_eval_count === 'number' || typeof ollamaDataOrText.eval_count === 'number')) {
    const promptTokenCount = ollamaDataOrText.prompt_eval_count ?? 0;
    const candidatesTokenCount = ollamaDataOrText.eval_count ?? 0;
    out.usageMetadata = {
      promptTokenCount,
      candidatesTokenCount,
      totalTokenCount: promptTokenCount + candidatesTokenCount,
    };
  }

  return out;
}
