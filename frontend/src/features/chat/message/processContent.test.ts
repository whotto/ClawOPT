import { describe, expect, it } from 'vitest';
import {
  hasSearchMatchInProcessBlocks,
  normalizeProcessBlocks,
  sanitizeConfiguredProcessText,
  splitProcessContent,
} from './processContent';

describe('normalizeProcessBlocks', () => {
  it('returns content untouched without both tags', () => {
    expect(normalizeProcessBlocks('hello <think>x</think>')).toBe('hello <think>x</think>');
    expect(normalizeProcessBlocks('hello', '<think>')).toBe('hello');
    expect(normalizeProcessBlocks('no tags here', '<think>', '</think>')).toBe('no tags here');
  });

  it('moves closed process blocks into a leading process_step_thought fence', () => {
    expect(normalizeProcessBlocks('<think>plan</think>answer', '<think>', '</think>'))
      .toBe('````process_step_thought\nplan\n````\n\nanswer');
  });

  it('merges multiple blocks and marks a trailing unclosed block as streaming', () => {
    expect(normalizeProcessBlocks('<think>a</think>mid<think>b', '<think>', '</think>'))
      .toBe('````process_step_thought_streaming\na\n\nb\n````\n\nmid');
  });

  it('drops empty process blocks and keeps the remaining text', () => {
    expect(normalizeProcessBlocks('<think></think>answer', '<think>', '</think>')).toBe('answer');
  });
});

describe('splitProcessContent', () => {
  it('separates known tool progress bullets from model text', () => {
    const result = splitProcessContent('- 正在打开页面：https://a.test\nthinking\n- 命令执行失败: exit 1\n- random bullet');
    expect(result.toolSteps).toEqual([
      { label: '正在打开页面', detail: 'https://a.test', status: 'running' },
      { label: '命令执行失败', detail: 'exit 1', status: 'error' },
    ]);
    expect(result.modelContent).toBe('thinking\n- random bullet');
  });

  it('recognizes generic running-tool labels', () => {
    expect(splitProcessContent('* Running tool browser').toolSteps).toEqual([
      { label: 'Running tool browser', detail: '', status: 'running' },
    ]);
  });
});

describe('sanitizeConfiguredProcessText', () => {
  it('strips configured tags and trailing partial tag fragments', () => {
    expect(sanitizeConfiguredProcessText('a<think>b</think>\n\n\n\nc <thi', '<think>', '</think>')).toEqual({
      content: 'ab\n\nc',
      hasTrailingPlaceholder: true,
    });
  });

  it('is a no-op without tags', () => {
    expect(sanitizeConfiguredProcessText('keep <think>', undefined, undefined)).toEqual({
      content: 'keep <think>',
      hasTrailingPlaceholder: false,
    });
  });
});

describe('hasSearchMatchInProcessBlocks', () => {
  it('matches inside tagged blocks or explicit process content only', () => {
    expect(hasSearchMatchInProcessBlocks('<t>Needle</t> rest', 'needle', '<t>', '</t>')).toBe(true);
    expect(hasSearchMatchInProcessBlocks('<t>x</t> needle', 'needle', '<t>', '</t>')).toBe(false);
    expect(hasSearchMatchInProcessBlocks('', 'needle', undefined, undefined, 'a NEEDLE b')).toBe(true);
  });
});
