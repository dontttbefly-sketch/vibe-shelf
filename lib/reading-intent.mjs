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
