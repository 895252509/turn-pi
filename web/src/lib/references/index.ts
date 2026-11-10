/** 引用 token 编解码与会话候选；后续文件/工作区引用也从这里扩展。 */
export {
	formatSessionReference,
	MAX_SESSION_REFERENCES,
	parseSessionReferences,
	sessionReferenceLabel,
} from './session';
export { createSessionReferenceSource, sessionCandidate } from './sessionSource';
export type { SessionReference } from '@/lib/input-trigger/types';
