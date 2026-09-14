function normalizePrompt(value: string): string {
  return value
    .replace(/\r\n?/g, '\n')
    .replace(/\s+/g, ' ')
    .trim();
}

const NEGATED_CONTEXT_IMAGE_PATTERNS = [
  /(?:不要|不再|禁止|别|无需|不应|不能|避免)[^。！？\n]{0,16}(?:画图|绘图|出图|生图|生成图片|生成图像|图像生成|绘图模型|图像生成模型)/i,
  /(?:画图|绘图|出图|生图|生成图片|生成图像|图像生成|绘图模型|图像生成模型)[^。！？\n]{0,16}(?:不要|不再|禁止|别|无需|不应|不能|避免)/i,
];

const DEFAULT_IMAGE_CONTEXT_PATTERNS = [
  /(?:默认|总是|始终|自动|直接|必须|优先)[^。！？\n]{0,32}(?:调用|使用)[^。！？\n]{0,24}(?:系统配置的)?(?:绘图模型|图像生成模型|图片生成模型|生图模型|image[-_\s]?generation model)/i,
  /(?:默认|总是|始终|自动|直接|必须|优先)[^。！？\n]{0,32}(?:绘图模型|图像生成模型|图片生成模型|生图模型|image[-_\s]?generation model)/i,
  /(?:不用|无需|不要)[^。！？\n]{0,24}(?:回答|回复)[^。！？\n]{0,40}(?:只需|只要|直接|必须)[^。！？\n]{0,40}(?:画出来|画出|画图|绘图|出图|生图|生成图片|生成图像)/i,
  /(?:只需|只要|直接|必须)[^。！？\n]{0,40}(?:将|把)?[^。！？\n]{0,24}(?:提问|问题|请求|prompt|提示词)[^。！？\n]{0,40}(?:画出来|画出|画图|绘图|出图|生图|生成图片|生成图像)/i,
];

function hasDefaultImageGenerationContext(context: string): boolean {
  if (!context) return false;
  if (NEGATED_CONTEXT_IMAGE_PATTERNS.some((pattern) => pattern.test(context))) {
    return false;
  }
  return DEFAULT_IMAGE_CONTEXT_PATTERNS.some((pattern) => pattern.test(context));
}

function normalizeContextValues(values?: Array<string | null | undefined> | string | null): string {
  const list = Array.isArray(values) ? values : [values];
  return normalizePrompt(list.filter((value): value is string => typeof value === 'string' && value.trim().length > 0).join('\n\n'));
}

export function shouldUseConfiguredImageGenerationModel(
  value: string,
  contextValues?: Array<string | null | undefined> | string | null,
): boolean {
  const prompt = normalizePrompt(value);
  if (!prompt) return false;

  const context = normalizeContextValues(contextValues);
  if (!context) {
    return false;
  }

  return hasDefaultImageGenerationContext(context);
}
