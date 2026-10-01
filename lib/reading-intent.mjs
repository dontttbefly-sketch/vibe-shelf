import { httpError } from './http.mjs';

export const READING_INTENTS = Object.freeze({
  overview: '快速理解整体：先建立项目用途、入口与模块之间的关系。用一条真实的运行路径串起全书，少量关键源码支撑理解。',
  core: '深入核心机制：沿真实调用与数据流解释核心实现、关键取舍和边界条件。重点章节引用足够源码，区分已实现行为与推断。',
  handoff: '为接手修改做准备：从运行入口、配置、核心调用链讲起，指出常见改动会经过哪些真实文件、已有测试如何验证，以及源码能证明的修改风险。',
});

export function normalizeReadingIntent(value) {
  if (value === undefined || value === null || value === '') return 'overview';
  if (typeof value !== 'string' || !Object.hasOwn(READING_INTENTS, value)) {
    throw httpError('请选择快速理解、深入机制或接手修改。', 400, 'invalid-reading-intent');
  }
  return value;
}

// 读者写下的侧重点：原话进 prompt，只做换行归一、去掉控制字符与方向覆盖字符、限长。
export const READING_FOCUS_MAX = 500;

export function normalizeReadingFocus(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw httpError('侧重点需要是一段文字。', 400, 'invalid-reading-focus');
  const text = value
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (Array.from(text).length > READING_FOCUS_MAX) {
    throw httpError(`侧重点请控制在 ${READING_FOCUS_MAX} 字以内。`, 400, 'invalid-reading-focus');
  }
  return text;
}
