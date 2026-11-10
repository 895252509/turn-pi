/** 全局输入触发器注册表；模块可以注册 / 或 @ source，返回 disposer。 */
import type { InputTriggerSource, TriggerChar } from './types';

class InputTriggerRegistry {
	private readonly sources = new Map<string, InputTriggerSource>();
	private readonly listeners = new Set<() => void>();
	private version = 0;

	register(source: InputTriggerSource): () => void {
		const key = `${source.trigger}:${source.name}`;
		if (this.sources.has(key)) {
			throw new Error(`input trigger "${key}" is already registered`);
		}
		this.sources.set(key, source);
		this.bump();
		return () => {
			if (this.sources.get(key) !== source) return;
			this.sources.delete(key);
			this.bump();
		};
	}

	list(trigger: TriggerChar): readonly InputTriggerSource[] {
		return [...this.sources.values()]
			.filter((source) => source.trigger === trigger)
			.sort((a, b) => (a.order ?? 0) - (b.order ?? 0) || a.name.localeCompare(b.name));
	}

	all(): readonly InputTriggerSource[] {
		return [...this.sources.values()];
	}

	getVersion = (): number => this.version;

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	};

	private bump(): void {
		this.version += 1;
		for (const listener of this.listeners) {
			try {
				listener();
			} catch {
				/* 注册监听失败不能阻止其它订阅者刷新 */
			}
		}
	}
}

export const inputTriggerRegistry = new InputTriggerRegistry();
