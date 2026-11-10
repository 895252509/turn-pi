/** 对外入口：注册 / 或 @ 的输入触发器来源。 */
export { inputTriggerRegistry } from './registry';
export { detectTrigger, parseCommandLine } from './detect';
export type {
	CandidateRequest,
	InputTriggerSource,
	PickOutcome,
	SessionReference,
	TriggerCandidate,
	TriggerChar,
	TriggerContext,
	TriggerHit,
	TriggerPick,
	TriggerPosition,
} from './types';
