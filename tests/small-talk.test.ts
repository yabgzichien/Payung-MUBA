import { describe, it, expect } from 'vitest';
import { detectSmallTalk } from '../src/small-talk.js';

describe('detectSmallTalk', () => {
  it('classifies plain greetings', () => {
    expect(detectSmallTalk('hi')).toBe('greeting');
    expect(detectSmallTalk('Hello!')).toBe('greeting');
    expect(detectSmallTalk('  hey  ')).toBe('greeting');
    expect(detectSmallTalk('Good morning')).toBe('greeting');
  });

  it('classifies help / meta questions', () => {
    expect(detectSmallTalk('help')).toBe('help');
    expect(detectSmallTalk('what should I do now')).toBe('help');
    expect(detectSmallTalk('what can you do?')).toBe('help');
    expect(detectSmallTalk('How does this work')).toBe('help');
  });

  it('returns null for an actual protection request', () => {
    expect(detectSmallTalk('Protect 0.2 ETH at a $2,300 floor for 7 days')).toBeNull();
  });

  it('returns null for unrelated off-topic text', () => {
    expect(detectSmallTalk('tell me a joke')).toBeNull();
  });

  it('classifies floor-price glossary questions', () => {
    expect(detectSmallTalk('what is floor price')).toBe('floorPrice');
    expect(detectSmallTalk("what's the floor price?")).toBe('floorPrice');
    expect(detectSmallTalk('explain floor price')).toBe('floorPrice');
    expect(detectSmallTalk('what is protected price')).toBe('floorPrice');
    expect(detectSmallTalk("what's the protected price?")).toBe('floorPrice');
    // Regression: a genuine question about the term, not a statement that
    // happens to use the word "floor" or "protected" while filling in a real value.
    expect(detectSmallTalk('Protect 0.2 ETH at a $2,300 floor for 7 days')).toBeNull();
    expect(detectSmallTalk('Protect 0.2 ETH at a $2,300 protected price for 7 days')).toBeNull();
  });

  it('classifies market-price glossary questions', () => {
    expect(detectSmallTalk('what is market price')).toBe('marketPrice');
    expect(detectSmallTalk('what does market price mean')).toBe('marketPrice');
  });
});
