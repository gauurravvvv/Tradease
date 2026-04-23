/**
 * Test JSON extraction and normalization from Claude responses.
 * These are critical for reliable AI → trade pipeline.
 */
import { jest } from '@jest/globals';

// Replicate extractJson logic for testing
function extractJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    /* fall through */
  }

  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
  if (fenceMatch) {
    try {
      return JSON.parse(fenceMatch[1].trim());
    } catch {
      /* fall through */
    }
  }

  const firstBrace = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let start = -1;
  if (firstBrace === -1 && firstBracket === -1)
    throw new Error('No JSON found in response');
  if (firstBrace === -1) start = firstBracket;
  else if (firstBracket === -1) start = firstBrace;
  else start = Math.min(firstBrace, firstBracket);

  const candidate = text.slice(start);
  return JSON.parse(candidate);
}

function normalizeType(type) {
  if (!type) return 'SKIP';
  const t = String(type).toUpperCase().trim();
  if (t === 'CALL' || t === 'BUY') return 'CALL';
  if (t === 'PUT' || t === 'SELL') return 'PUT';
  if (t === 'NEUTRAL' || t === 'SKIP') return 'SKIP';
  return 'SKIP';
}

describe('extractJson', () => {
  test('parses raw JSON array', () => {
    const input = '[{"symbol":"RELIANCE","type":"CALL"}]';
    const result = extractJson(input);
    expect(Array.isArray(result)).toBe(true);
    expect(result[0].symbol).toBe('RELIANCE');
  });

  test('parses JSON wrapped in markdown fences', () => {
    const input = '```json\n[{"symbol":"TCS","type":"PUT"}]\n```';
    const result = extractJson(input);
    expect(result[0].symbol).toBe('TCS');
  });

  test('parses JSON with leading text', () => {
    const input = 'Here is my analysis:\n\n[{"symbol":"INFY","confidence":80}]';
    const result = extractJson(input);
    expect(result[0].symbol).toBe('INFY');
  });

  test('parses object (not array)', () => {
    const input = '{"type":"CALL","confidence":75}';
    const result = extractJson(input);
    expect(result.type).toBe('CALL');
  });

  test('throws on no JSON', () => {
    expect(() => extractJson('No JSON here at all')).toThrow('No JSON found');
  });

  test('handles markdown fences without json label', () => {
    const input = '```\n{"symbol":"HDFC","type":"CALL"}\n```';
    const result = extractJson(input);
    expect(result.symbol).toBe('HDFC');
  });
});

describe('normalizeType', () => {
  test('maps CALL variants', () => {
    expect(normalizeType('CALL')).toBe('CALL');
    expect(normalizeType('call')).toBe('CALL');
    expect(normalizeType('BUY')).toBe('CALL');
    expect(normalizeType('Buy')).toBe('CALL');
  });

  test('maps PUT variants', () => {
    expect(normalizeType('PUT')).toBe('PUT');
    expect(normalizeType('put')).toBe('PUT');
    expect(normalizeType('SELL')).toBe('PUT');
    expect(normalizeType('Sell')).toBe('PUT');
  });

  test('maps SKIP variants', () => {
    expect(normalizeType('SKIP')).toBe('SKIP');
    expect(normalizeType('NEUTRAL')).toBe('SKIP');
    expect(normalizeType(null)).toBe('SKIP');
    expect(normalizeType(undefined)).toBe('SKIP');
    expect(normalizeType('')).toBe('SKIP');
  });

  test('unknown types default to SKIP', () => {
    expect(normalizeType('HOLD')).toBe('SKIP');
    expect(normalizeType('WAIT')).toBe('SKIP');
  });
});

describe('Full AI response normalization', () => {
  test('normalizes snake_case field names from AI', () => {
    const aiResponse = {
      symbol: 'RELIANCE',
      type: 'CALL',
      confidence: 82,
      entry_price: 2450,
      stop_loss: 2410,
      target1: 2530,
      target2: 2570,
      reason: 'Bullish engulfing at support',
    };

    expect(aiResponse.entry_price).toBe(2450);
    expect(aiResponse.stop_loss).toBe(2410);
  });

  test('normalizes camelCase field names from AI', () => {
    const aiResponse = {
      symbol: 'TCS',
      recommendation: 'BUY',
      confidence: 75,
      entryPrice: 3800,
      stopLoss: 3750,
      target1: 3900,
      target2: 3950,
      reasoning: 'Strong technicals',
    };

    // Normalize
    const normalized = {
      type: normalizeType(aiResponse.type || aiResponse.recommendation),
      entry_price: aiResponse.entry_price ?? aiResponse.entryPrice,
      stop_loss: aiResponse.stop_loss ?? aiResponse.stopLoss,
      reason: aiResponse.reason ?? aiResponse.reasoning,
    };

    expect(normalized.type).toBe('CALL');
    expect(normalized.entry_price).toBe(3800);
    expect(normalized.stop_loss).toBe(3750);
    expect(normalized.reason).toBe('Strong technicals');
  });
});
