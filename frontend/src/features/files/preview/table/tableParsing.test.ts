import { describe, expect, it } from 'vitest';
import { buildCsvPreview, buildWorkbookPreview, capTableRows, DEFAULT_TABLE_LIMITS, detectCsvDelimiter, isTableTruncated, parseCsv } from './tableParsing';

const small = { maxSheets: 2, maxRows: 3, maxCols: 2, maxCells: 100, maxCellChars: 5 };

describe('capTableRows', () => {
  it('keeps small tables intact and not truncated', () => {
    const sheet = capTableRows('S', [['a', 1], [true, null]], DEFAULT_TABLE_LIMITS);
    expect(sheet.rows).toEqual([['a', '1'], ['true', '']]);
    expect(isTableTruncated(sheet)).toBe(false);
  });

  it('caps rows, columns and cell text with truncation flags', () => {
    const input = Array.from({ length: 5 }, (_, r) => [`r${r}-abcdefgh`, 'b', 'c']);
    const sheet = capTableRows('S', input, small);
    expect(sheet.rows.length).toBe(3);
    expect(sheet.rows[0]).toEqual(['r0-ab', 'b']);
    expect(sheet.truncated).toEqual({ rows: true, cols: true, cells: false, chars: true });
    expect(sheet.totalRows).toBe(5);
    expect(sheet.totalCols).toBe(3);
  });

  it('caps by total cells (rows × cols)', () => {
    const input = Array.from({ length: 10 }, () => Array.from({ length: 10 }, () => 'x'));
    const sheet = capTableRows('S', input, { ...DEFAULT_TABLE_LIMITS, maxCells: 35 });
    expect(sheet.rows.length).toBe(3);
    expect(sheet.rows[0].length).toBe(10);
    expect(sheet.truncated.cells).toBe(true);
  });
});

describe('detectCsvDelimiter', () => {
  it('detects comma, semicolon, tab and pipe', () => {
    expect(detectCsvDelimiter('a,b,c\n1,2,3\n4,5,6')).toBe(',');
    expect(detectCsvDelimiter('a;b;c\n1;2,5;3\n4;5;6')).toBe(';');
    expect(detectCsvDelimiter('a\tb\n1\t2')).toBe('\t');
    expect(detectCsvDelimiter('a|b|c\n1|2|3')).toBe('|');
  });

  it('ignores delimiters inside quotes and falls back to comma', () => {
    expect(detectCsvDelimiter('"x;y;z",b\n"1;2;3",c')).toBe(',');
    expect(detectCsvDelimiter('single column\nvalue')).toBe(',');
  });
});

describe('parseCsv', () => {
  it('handles quotes, escaped quotes, embedded newlines, CRLF and BOM', () => {
    const { rows } = parseCsv('﻿name,note\r\n"A, Inc.","say ""hi""\nthere"\r\nB,plain', ',');
    expect(rows).toEqual([['name', 'note'], ['A, Inc.', 'say "hi"\nthere'], ['B', 'plain']]);
  });

  it('stops parsing after maxRows + 1 rows', () => {
    const text = Array.from({ length: 100 }, (_, i) => `${i},x`).join('\n');
    const { rows, stoppedEarly } = parseCsv(text, ',', small);
    expect(stoppedEarly).toBe(true);
    expect(rows.length).toBe(4);
  });

  it('buildCsvPreview marks rows as a lower bound when stopped early', () => {
    const text = Array.from({ length: 50 }, (_, i) => `${i};x`).join('\n');
    const result = buildCsvPreview(text, small);
    expect(result.delimiter).toBe(';');
    expect(result.sheets[0].rows.length).toBe(3);
    expect(result.sheets[0].rowsAtLeast).toBe(true);
    expect(result.sheets[0].truncated.rows).toBe(true);
  });
});

describe('buildWorkbookPreview', () => {
  it('limits the number of sheets and only reads visible ones', () => {
    const read: string[] = [];
    const result = buildWorkbookPreview(['a', 'b', 'c'], (name) => {
      read.push(name);
      return { rows: [[name]], rowsExceeded: false };
    }, small);
    expect(read).toEqual(['a', 'b']);
    expect(result.sheetsTruncated).toBe(true);
    expect(result.totalSheets).toBe(3);
  });
});
