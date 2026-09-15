import { describe, expect, it } from 'vitest';
import { attachmentNotesMarkdown, pastedFileName, representativeFrameTimes, scaleToMaxEdge, withoutDuplicates } from './composerAttachments';

describe('composerAttachments', () => {
  it('粘贴的通用名图片改名，重名加序号；正常文件名不动', () => {
    const now = new Date('2026-09-15T01:02:03Z');
    expect(pastedFileName({ name: 'image.png', type: 'image/png' }, new Set(), now)).toBe('pasted-20260915010203.png');
    expect(pastedFileName({ name: 'image.png', type: 'image/png' }, new Set(['pasted-20260915010203.png']), now)).toBe('pasted-20260915010203-2.png');
    expect(pastedFileName({ name: '', type: 'image/jpeg' }, new Set(), now)).toBe('pasted-20260915010203.jpg');
    expect(pastedFileName({ name: 'diagram.png', type: 'image/png' }, new Set(), now)).toBe('diagram.png');
    expect(pastedFileName({ name: 'image.png', type: 'application/pdf' }, new Set(), now)).toBe('image.png');
  });

  it('同名同大小视为重复忽略（含一次拖进来的重复）', () => {
    const a = { file: { name: 'a.txt', size: 3 } };
    const b = { file: { name: 'a.txt', size: 4 } };
    expect(withoutDuplicates([a], [a, b, b])).toEqual([b]);
  });

  it('代表帧：10%–90% 均匀 3 帧；时长未知 / 很短只取 1 帧；最长边 1280', () => {
    expect(representativeFrameTimes(100)).toEqual([10, 50, 90]);
    expect(representativeFrameTimes(Number.NaN)).toEqual([0]);
    expect(representativeFrameTimes(0.5)).toEqual([0.25]);
    expect(scaleToMaxEdge(3840, 2160)).toEqual({ width: 1280, height: 720 });
    expect(scaleToMaxEdge(640, 480)).toEqual({ width: 640, height: 480 });
  });

  it('附件说明：只写有说明的、非抽帧的附件，折叠空白', () => {
    expect(attachmentNotesMarkdown([
      { file: { name: 'a.png' } as File, note: ' 注意\n右上角 ' },
      { file: { name: 'b.png' } as File },
      { file: { name: 'v-frame-1.jpg' } as File, note: 'x', frameOf: 'v.mp4' },
    ])).toBe('> a.png: 注意 右上角');
  });
});
