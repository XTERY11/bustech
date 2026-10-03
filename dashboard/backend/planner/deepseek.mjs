export class DeepSeekError extends Error {
  constructor(code) { super(code); this.code = code; }
}

export class DeepSeekClient {
  constructor({ apiKey = process.env.DEEPSEEK_API_KEY, model = process.env.DEEPSEEK_MODEL || 'deepseek-flash', timeoutMs = Number(process.env.DEEPSEEK_TIMEOUT_MS || 20000), fetchImpl = fetch } = {}) {
    this.apiKey = apiKey;
    this.model = model;
    this.timeoutMs = Number.isFinite(timeoutMs) ? Math.min(60000, Math.max(1000, timeoutMs)) : 20000;
    this.fetchImpl = fetchImpl;
  }
  async complete(messages, { phase = 'action' } = {}) {
    if (!this.apiKey) throw new DeepSeekError('MISSING_API_KEY');
    const start = performance.now();
    let response;
    try {
      response = await this.fetchImpl('https://api.deepseek.com/chat/completions', {
        method: 'POST', redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { Authorization: `Bearer ${this.apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model, messages, stream: false, temperature: 0,
          thinking: { type: 'disabled' }, response_format: { type: 'json_object' },
          max_tokens: phase === 'summary' ? 320 : 1400,
        }),
      });
    } catch (error) {
      throw new DeepSeekError(['TimeoutError', 'AbortError'].includes(error.name) ? 'API_TIMEOUT' : 'API_NETWORK_ERROR');
    }
    if (!response.ok) {
      // Never print the response body: upstream error strings might contain sensitive data.
      await response.body?.cancel();
      throw new DeepSeekError(`API_HTTP_${response.status}`);
    }
    let data;
    try { data = await response.json(); } catch { throw new DeepSeekError('API_INVALID_RESPONSE'); }
    const choice = data.choices?.[0];
    if (choice?.finish_reason !== 'stop') throw new DeepSeekError('API_TRUNCATED_OR_INCOMPLETE');
    let value;
    try { value = JSON.parse(choice.message.content); } catch { throw new DeepSeekError('API_INVALID_JSON'); }
    // Only numeric aggregate usage; do not retain reasoning_content, raw headers, or credentials.
    const usage = Object.fromEntries(['prompt_tokens', 'completion_tokens', 'total_tokens', 'prompt_cache_hit_tokens', 'prompt_cache_miss_tokens']
      .filter(k => typeof data.usage?.[k] === 'number').map(k => [k, data.usage[k]]));
    return { value, usage, model: data.model ?? this.model, latency_ms: Math.round(performance.now() - start) };
  }
}
